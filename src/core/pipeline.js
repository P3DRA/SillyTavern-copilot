/**
 * The copilot pipeline: extractor, then composer, then a note.
 *
 * Deliberately HOST-FREE. It takes a context object and returns records; it never
 * touches SillyTavern. That is what makes the whole loop testable in Node, and
 * it is the opposite of the previous build, where the logic and the ST wiring
 * were fused and nothing could be exercised except through a browser.
 *
 * The host adapter in `src/st/adapter.js` supplies the context and stores the
 * result.
 *
 * INVARIANT I5, enforced structurally: nothing in here throws. Every failure
 * path returns a result with `ok: false` and a reason, because the caller is
 * inside SillyTavern's generation and an exception there would break the chat.
 */

import { callWithFallback, costUsd } from './provider.js';
import {
    render, renderMessages, renderEntries, fitMessages, detectLanguage,
    DEFAULT_EXTRACTOR_PROMPT, DEFAULT_COMPOSER_PROMPT,
} from './prompts.js';
import { makeExtraction, makeComposer, makeInjection, noteHash } from '../schema/records.js';
import { LIMITS } from './garbage.js';
import { redact } from './redact.js';

/** How long the whole pipeline may take before the turn proceeds without a note. */
export const DEFAULT_DEADLINE_MS = 20000;

/**
 * @typedef {object} PipelineInput
 * @property {Array<{role: string, text: string}>} messages Recent chat, oldest first.
 * @property {string} [lorebook]        Text of the entries triggered for this generation.
 * @property {string} [characterCard]
 * @property {string} [narratorPrompt]
 * @property {string} [userRequest]     A user request in force for this turn, if any.
 * @property {Array<object>} [goals]     Script-tracked goal facts (never counted by the LLM).
 * @property {string} [previousNote]     The last note we injected, so we do not repeat it (trap 9).
 * @property {object} settings
 */

/**
 * Run extractor then composer.
 *
 * @param {PipelineInput} input
 * @param {object} deps
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {string} [deps.key]
 * @param {(e: object) => void} [deps.onEvent]
 * @param {AbortSignal} [deps.signal]
 * @param {number} [deps.deadlineMs]
 * @returns {Promise<object>} Always resolves.
 */
export async function runPipeline(input, deps = {}) {
    const {
        fetchImpl, key, onEvent = () => {}, signal, deadlineMs = DEFAULT_DEADLINE_MS,
    } = deps;
    const settings = input?.settings ?? {};
    const started = Date.now();

    const result = {
        ok: false,
        reason: null,
        detail: '',
        extraction: null,
        composer: null,
        note: null,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        elapsedMs: 0,
        attempts: [],
        skipReason: null,
    };

    try {
        // ---- 0. Gate: nothing to do? Say so, in one line (trap 14). ----
        if (settings.enabled === false) {
            return Object.assign(result, { ok: false, reason: 'disabled', detail: 'the copilot is switched off' });
        }
        if (!key) {
            return Object.assign(result, { ok: false, reason: 'no_api_key', detail: 'no API key configured' });
        }
        if (!Array.isArray(input.messages) || input.messages.length === 0) {
            return Object.assign(result, { ok: false, reason: 'no_messages', detail: 'no chat messages to work from' });
        }

        // ---- 1. Extractor ----
        const extractWindow = fitMessages(input.messages, settings.extractor?.maxChars ?? 6000);
        const language = detectLanguage(extractWindow.messages);
        const extractorPrompt = render(settings.extractor?.prompt ?? DEFAULT_EXTRACTOR_PROMPT, {
            lastMessages: renderMessages(extractWindow.messages),
            lorebook: input.lorebook ?? '',
            characterCard: input.characterCard ?? '',
            narratorPrompt: input.narratorPrompt ?? '',
            language: language.code ?? 'en',
        });
        onEvent({ kind: 'extract-start', messages: extractWindow.messages.length, dropped: extractWindow.dropped });

        const extractResult = await callWithFallback({
            models: settings.extractor?.chain ?? [],
            retries: settings.extractor?.retries ?? 1,
            key,
            fetchImpl,
            messages: [
                { role: 'system', content: extractorPrompt.text },
                { role: 'user', content: renderMessages(extractWindow.messages) },
            ],
            temperature: settings.extractor?.temperature ?? 0.2,
            maxTokens: settings.extractor?.maxTokens,
            // The extractor emits a structured, deliberately COMPACT record. The
            // composer's prose word bounds do not apply to it — applying them
            // rejected perfectly good extractions for being short, which is how
            // a cheap extractor silently produced nothing.
            minWords: 1,
            maxWords: 20000,
            allowRefusal: true,
            signal,
            onEvent,
        });
        result.attempts.push(...extractResult.attempts);
        result.tokensIn += extractResult.attempts.reduce((n, a) => n + (a.tokensIn || 0), 0);
        result.tokensOut += extractResult.attempts.reduce((n, a) => n + (a.tokensOut || 0), 0);
        result.costUsd += costUsd(
            { tokensIn: result.tokensIn, tokensOut: result.tokensOut },
            settings.pricing?.extractor,
        );

        if (extractResult.deadKey) {
            return Object.assign(result, { ok: false, reason: 'dead_key', detail: extractResult.summary, elapsedMs: Date.now() - started });
        }

        // The extraction is stored EVEN IF the composer later fails. GOAL.md I1:
        // nothing an automatic operation produced may be thrown away.
        result.extraction = makeExtraction({
            text: extractResult.ok ? extractResult.text : extractResult.attempts.at(-1)?.text ?? '',
            model: extractResult.model ?? '',
            tokensIn: extractResult.attempts.reduce((n, a) => n + (a.tokensIn || 0), 0),
            tokensOut: extractResult.attempts.reduce((n, a) => n + (a.tokensOut || 0), 0),
        });

        if (!extractResult.ok) {
            // A failed extraction is not fatal: the composer can still work from
            // the raw messages. The record of WHY is kept for the debug panel.
            onEvent({ kind: 'extract-failed', summary: extractResult.summary });
            result.extraction.text = '';
            result.warn = extractResult.summary;
        }

        if (Date.now() - started > deadlineMs) {
            return Object.assign(result, {
                ok: false, reason: 'deadline', elapsedMs: Date.now() - started,
                detail: `the extractor used the whole budget (${deadlineMs}ms); proceeding without a note`,
            });
        }

        // ---- 2. Composer ----
        const composerWindow = fitMessages(input.messages, settings.composer?.maxChars ?? 8000);
        const entries = (Array.isArray(input.goals) ? input.goals : []).map((g) => ({ text: g.text, source: g.turnsElapsed }));
        const noteBudget = {
            minWords: settings.composer?.minWords ?? LIMITS.MIN_WORDS,
            maxWords: settings.composer?.maxWords ?? LIMITS.MAX_WORDS,
        };
        const composerPrompt = render(settings.composer?.prompt ?? DEFAULT_COMPOSER_PROMPT, {
            extractions: renderEntries(input.extractions ?? []),
            lastMessages: renderMessages(composerWindow.messages),
            lorebook: input.lorebook ?? '',
            characterCard: input.characterCard ?? '',
            narratorPrompt: input.narratorPrompt ?? '',
            userRequest: input.userRequest ?? '',
            goals: renderEntries(entries),
            // TRAP 9: without the previous note the composer regenerates the same
            // text every turn and the note becomes wallpaper.
            previousNote: input.previousNote ?? '(none yet — this is the first note in this chat)',
            language: language.code ?? 'en',
            minWords: String(noteBudget.minWords),
            maxWords: String(noteBudget.maxWords),
        });
        onEvent({ kind: 'compose-start', messages: composerWindow.messages.length, dropped: composerWindow.dropped });

        const composeResult = await callWithFallback({
            models: settings.composer?.chain ?? [],
            retries: settings.composer?.retries ?? 1,
            key,
            fetchImpl,
            messages: [
                { role: 'system', content: composerPrompt.text },
                { role: 'user', content: renderMessages(composerWindow.messages) },
            ],
            temperature: settings.composer?.temperature ?? 0.7,
            maxTokens: settings.composer?.maxTokens,
            tag: 'copilot',
            minWords: noteBudget.minWords,
            maxWords: noteBudget.maxWords,
            allowRefusal: true,
            signal,
            onEvent,
        });
        result.attempts.push(...composeResult.attempts);

        if (composeResult.deadKey) {
            return Object.assign(result, { ok: false, reason: 'dead_key', detail: composeResult.summary, elapsedMs: Date.now() - started });
        }

        result.composer = makeComposer({
            // Even a refusal is KEPT here. Content-neutrality means we never
            // delete what a model said; it does not mean we inject it.
            text: composeResult.ok ? composeResult.text
                : (composeResult.refused ? composeResult.text : ''),
            model: composeResult.model ?? '',
            tokensIn: composeResult.attempts.reduce((n, a) => n + (a.tokensIn || 0), 0),
            tokensOut: composeResult.attempts.reduce((n, a) => n + (a.tokensOut || 0), 0),
            latencyMs: Date.now() - started,
            attempts: composeResult.attempts.map((a) => ({
                createdAt: started,
                model: a.model,
                ok: a.ok === true,
                rejectReason: a.ok ? null : a.reason,
                raw: redact(String(a.text ?? '')).slice(0, 2000),
                tokensIn: a.tokensIn ?? 0,
                tokensOut: a.tokensOut ?? 0,
                latencyMs: a.latencyMs ?? 0,
                attemptIndex: a.attemptIndex ?? 0,
                finishReason: a.finishReason ?? null,
            })),
        });
        result.costUsd += costUsd(
            { tokensIn: result.composer.tokensIn, tokensOut: result.composer.tokensOut },
            settings.pricing?.composer,
        );

        if (!composeResult.ok) {
            return Object.assign(result, {
                ok: false, reason: 'compose_failed', detail: composeResult.summary,
                elapsedMs: Date.now() - started,
            });
        }

        // ---- 3. The note ----
        result.note = composeResult.text.trim();
        result.noteHash = noteHash(result.note);
        result.ok = result.note !== '';
        if (!result.ok) {
            result.reason = 'empty_note';
            result.detail = 'the composer returned nothing usable';
        }
        result.elapsedMs = Date.now() - started;
        onEvent({ kind: 'done', ok: result.ok, elapsedMs: result.elapsedMs });
        return result;
    } catch (err) {
        // I5. If anything at all goes wrong, the chat still generates.
        return Object.assign(result, {
            ok: false,
            reason: 'exception',
            detail: redact(String(err?.message ?? err)),
            elapsedMs: Date.now() - started,
        });
    }
}

/**
 * Wrap a note for injection.
 *
 * The tag is what makes the block recognisable in the narrator's prompt and
 * lets the debug panel find it again in the outgoing request (I7, 10.8).
 *
 * @param {string} note
 * @param {string} [tag]
 */
export function wrapNote(note, tag = 'copilot') {
    const body = String(note ?? '').trim();
    if (body === '') {
        return '';
    }
    return `<${tag}>\n${body}\n</${tag}>`;
}

/**
 * Build the injection record for a turn that is about to send.
 * @param {object} args
 */
export function buildInjection(args) {
    return makeInjection({
        injected: Boolean(args.injected),
        position: args.position ?? 'end',
        finalPromptRef: args.finalPromptRef ?? null,
        goalsActive: args.goalsActive ?? [],
        userRequestsActive: args.userRequestsActive ?? [],
        injectedAt: args.injected ? Date.now() : undefined,
        skipReason: args.skipReason ?? undefined,
        noteChars: args.noteChars ?? 0,
        noteHash: args.noteHash ?? undefined,
    });
}