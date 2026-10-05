/**
 * Copilot — SillyTavern entry point.
 *
 * Manifest: `js: index.js`. Everything host-facing is wired here and delegated
 * to `src/st/adapter.js`; the logic lives in `src/core/` and never imports ST.
 *
 * THE TURN, as actually observed in SillyTavern 1.18.0 (verified phase 0):
 *
 *   :4240  GENERATION_STARTED      <- token allocated, quiet flags read
 *   :4262  GENERATION_AFTER_COMMANDS
 *   :4394  sendMessageAsUser       <- the USER's line finally joins `chat`
 *   ...    prompt assembled
 *   :3972/:3978  GENERATE_AFTER_COMBINE_PROMPTS / CHAT_COMPLETION_PROMPT_READY
 *              <- AWAITED and mutable. This is where we compose and inject.
 *   :6057  request sent
 *   :6685  saveReply pushes the assistant message  <- the reply finally exists
 *   :6679  MESSAGE_RECEIVED        <- the note binds to it here
 *
 * Two consequences that decide everything below:
 *  1. There is no assistant message to attach a note to until AFTER the reply
 *     arrives, so the note is composed against a predicted index and bound later.
 *  2. The user's new line is NOT in `chat` at either pre-assembly hook, which is
 *     why composition happens at the prompt-ready hook. See the note on
 *     INJECTION below.
 */

import { EVENT, GENERATION_TYPE, NOTE_TAG } from './src/st/constants.js';
import { DebugLog, SKIP, verifyInOutgoing, BUILD_ID } from './src/core/debug-log.js';
import { runPipeline } from './src/core/pipeline.js';
import { collectExtractions, listRecords, readSwipeRecordOrNull, writeSwipeRecord } from './src/schema/store.js';
import { applyComposerEdit, applyExtractionEdit } from './src/schema/edit.js';
import {
    noteHash, goalFacts, tickGoals, tickRequests, makeGoal, makeUserRequest,
} from './src/schema/records.js';
import { redact } from './src/core/redact.js';
import {
    ctx, chat, eventSource, saveChatConditional,
    nextToken, isCurrent, resetTokens, clearPending,
    setPending, getPending, bindToMessage, recordSkip, registerNote, clearNote,
} from './src/st/adapter.js';

const log = new DebugLog();

/** Where the API key and configuration live inside SillyTavern's settings. */
const SETTINGS_KEY = 'copilot';

/* ------------------------------------------------------------------ settings */

/**
 * Defaults. No key ships with the extension, and it never reads `secret.md`
 * (GOAL.md §9.2) — the user enters their own.
 */
const DEFAULTS = {
    enabled: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    extractor: {
        chain: ['inclusionai/ling-3.1-flash'],
        retries: 1,
        temperature: 0.2,
        maxChars: 6000,
    },
    composer: {
        chain: ['mistralai/mistral-nemo'],
        retries: 1,
        temperature: 0.7,
        maxChars: 8000,
        minWords: 15,
        maxWords: 120,
    },
    injection: {
        // 'end' | 'before_last' | 'first'
        position: 'end',
        depth: 0,
        role: 'system',
    },
    maxWaitMs: 15000,
    debug: true,
    // Phase 3 (§6): what happens on swipe/reroll. 'ask' shows a popup —
    // "new composer note or reuse the current one" — before the generation
    // proceeds. 'new' / 'reuse' skip the popup (useful for tests and for users
    // who always want the same behaviour).
    rerollMode: 'ask',
    // Phase 4 (§6): after a reroll composes new data, show the old-vs-new diff
    // popup (use old / use new / reroll / cancel). Set false for a silent flow.
    diffPopup: true,
};

function settings() {
    const root = ctx().extensionSettings ?? {};
    const stored = root[SETTINGS_KEY] ?? {};
    return {
        ...DEFAULTS,
        ...stored,
        extractor: { ...DEFAULTS.extractor, ...(stored.extractor ?? {}) },
        composer: { ...DEFAULTS.composer, ...(stored.composer ?? {}) },
        injection: { ...DEFAULTS.injection, ...(stored.injection ?? {}) },
    };
}

function apiKey() {
    const s = settings();
    const stored = ctx().extensionSettings?.[SETTINGS_KEY];
    // Accept a direct key, or a SillyTavern secret reference so the key can live
    // in the server-side secret store rather than in localStorage.
    const direct = stored?.apiKey;
    if (direct) {
        return direct;
    }
    const ref = stored?.apiKeySecret;
    if (ref && ctx().getSecret) {
        try {
            const v = ctx().getSecret(ref);
            return Array.isArray(v) ? v[0] : v;
        } catch {
            return null;
        }
    }
    return null;
}

function saveSettings(patch) {
    const root = ctx().extensionSettings;
    if (!root) {
        return;
    }
    root[SETTINGS_KEY] = { ...(root[SETTINGS_KEY] ?? {}), ...patch };
    // ST persists extension_settings inside its main settings payload
    // (script.js:7992 saveSettings -> :8026 extension_settings). There is no
    // ctx.saveExtensionSettings — the optional-chain call that used to live here
    // was a silent no-op and settings never reached the server. The context
    // exposes saveSettingsDebounced (st-context.js:131); ST's own extensions
    // (extensions.js:673) persist extension settings the same way.
    ctx().saveSettingsDebounced?.();
}

/* ------------------------------------------------------------------- inputs */

/**
 * Collect the context the pipeline needs from the live chat.
 *
 * Reached through `ctx()` FRESH every time. Nothing here is cached across a
 * turn, because `chat_metadata` is reassigned by SillyTavern on load and a held
 * reference would silently diverge (trap 1).
 */
function collectInput(turnId) {
    const list = chat();
    const messages = [];
    const window = settings().composer.maxChars;
    // Walk backwards so a budget drops whole OLDEST messages (trap 4).
    let used = 0;
    for (let i = list.length - 1; i >= 0; i -= 1) {
        const m = list[i];
        const text = typeof m?.mes === 'string' ? m.mes : '';
        if (text.trim() === '' || m?.is_system) {
            continue;
        }
        const cost = text.length;
        if (used + cost > window && messages.length > 0) {
            break;
        }
        messages.unshift({ role: m.is_user ? 'user' : 'assistant', text });
        used += cost;
    }

    // Extractions the composer may read: everything up to and including the
    // message we are answering, excluding the slot being written. Compressed
    // originals are excluded here and ONLY here (I2).
    const extractions = collectExtractions(list, {
        excludeSwipeAt: { messageIndex: list.length, swipeIndex: 0 },
    }).map((e) => ({ text: e.extraction.text, source: e.messageIndex + 1 }));

    const meta = ctx().chatMetadata?.copilot ?? {};
    return {
        messages,
        extractions,
        lorebook: readLorebook(),
        characterCard: ctx().name2 ?? '',
        narratorPrompt: ctx().systemPrompt ?? '',
        userRequest: activeRequestText(meta),
        // Script-tracked goal FACTS (S6): the counters are computed here, never
        // by the model. goalFacts drops completed goals.
        goals: goalFacts(meta.goals ?? [], GOAL_COUNTER_KEY),
        previousNote: previousNoteFor(list),
        settings: settings(),
    };
}

/**
 * Triggered lorebook entries for this generation.
 *
 * `world_info_activated` carries every entry the scan activated
 * (public/scripts/world-info.js:902). We collect them per generation so the
 * composer sees the same lorebook the narrator does, and so the debug panel can
 * say which parts of the prompt came from world info.
 */
let lorebookEntries = new Map();

function readLorebook() {
    return [...lorebookEntries.values()]
        .map((e) => `- ${e.comment ?? `entry ${e.uid}`}: ${e.content ?? ''}`)
        .join('\n');
}

function noteTextOf(record) {
    const t = record?.composer?.text;
    return typeof t === 'string' && t.trim() !== '' ? t : null;
}

function previousNoteFor(list) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
        const m = list[i];
        if (m?.is_user) {
            continue;
        }
        const info = m?.swipe_info?.[m.swipe_id ?? 0];
        const note = noteTextOf(info?.extra?.copilot?.record);
        if (note) {
            return note;
        }
    }
    return '';
}

/**
 * Counter namespace for goal turn counts (records.js turnCounters keys).
 * Goals live in `chat_metadata.copilot` — already per-chat — so one key is
 * enough; the per-chat key contract stays available for imports (S6).
 */
const GOAL_COUNTER_KEY = 'default';

function activeRequestText(meta) {
    return (meta.requests ?? [])
        .filter((r) => !r.complete)
        .map((r) => r.text)
        .join('; ');
}

/* ------------------------------------------------- goals and user requests */

/**
 * Script-driven turn counters (S6): advance every goal counter and expire the
 * user requests whose turn budget is spent — once per REAL narrator turn.
 *
 * Trap 1: `chat_metadata` is reassigned by ST on load, so the object is read
 * FRESH through ctx() and persisted through ST's own saveMetadata. The model
 * is never asked to do this arithmetic (GOAL.md §5).
 */
function tickChatState() {
    try {
        const meta = ctx().chatMetadata;
        if (!meta) {
            return;
        }
        const root = meta.copilot ?? (meta.copilot = {});
        const beforeGoals = (root.goals ?? []).filter((g) => !g.complete).length;
        const beforeReq = (root.requests ?? []).filter((r) => !r.complete).length;
        tickGoals(root.goals ?? [], GOAL_COUNTER_KEY);
        tickRequests(root.requests ?? []);
        const afterGoals = (root.goals ?? []).filter((g) => !g.complete).length;
        const afterReq = (root.requests ?? []).filter((r) => !r.complete).length;
        saveMetadata();
        if (afterGoals !== beforeGoals || afterReq !== beforeReq) {
            log.info('goals', `tick: ${beforeGoals} goals / ${beforeReq} requests active -> ${afterGoals} / ${afterReq} (completed or expired)`);
        }
    } catch (err) {
        log.warn('goals', `tick failed: ${redact(String((err && err.message) || err))}`);
    }
}

/** Read-modify-write chat_metadata.copilot through a fresh ctx() (trap 1). */
function withMeta(fn) {
    const meta = ctx().chatMetadata;
    if (!meta) {
        return { ok: false, reason: 'no chat metadata' };
    }
    const root = meta.copilot ?? (meta.copilot = {});
    const res = fn(root) ?? { ok: true, reason: null };
    saveMetadata();
    return res;
}

function addGoal(text, remainingTurns = 'forever') {
    return withMeta((root) => {
        const goal = makeGoal({ text, remainingTurns });
        root.goals = [...(root.goals ?? []), goal];
        log.info('goals', `goal added: "${goal.text}" (${goal.remainingTurns === 'forever' ? 'no expiry' : `${goal.remainingTurns} turns`})`);
        return { ok: true, reason: null, id: goal.id };
    });
}

function completeGoal(id) {
    return withMeta((root) => {
        const goal = (root.goals ?? []).find((g) => g.id === id);
        if (!goal) {
            return { ok: false, reason: 'goal not found' };
        }
        goal.complete = true;
        log.info('goals', `goal completed: "${goal.text}"`);
        return { ok: true, reason: null };
    });
}

function addRequest(text, remainingTurns = 'forever') {
    return withMeta((root) => {
        const req = makeUserRequest({ text, remainingTurns });
        root.requests = [...(root.requests ?? []), req];
        log.info('goals', `request added: "${req.text}" (${req.remainingTurns === 'forever' ? 'forever' : `${req.remainingTurns} turns`})`);
        return { ok: true, reason: null, id: req.id };
    });
}

function removeRequest(id) {
    return withMeta((root) => {
        const before = (root.requests ?? []).length;
        root.requests = (root.requests ?? []).filter((r) => r.id !== id);
        if (root.requests.length === before) {
            return { ok: false, reason: 'request not found' };
        }
        log.info('goals', 'request removed');
        return { ok: true, reason: null };
    });
}

/* ---------------------------------------------------------------- injection */

/**
 * INJECTION — and an honest note about G1's choice.
 *
 * G1 selected "register-then-assemble": publish through `setExtensionPrompt` so
 * the note gets SillyTavern's own depth and role handling. That registry is read
 * while the prompt is being assembled — BEFORE the awaited prompt-ready hooks —
 * and both pre-assembly await points (`GENERATION_STARTED` :4240 and
 * `GENERATION_AFTER_COMMANDS` :4262) fire before `sendMessageAsUser` appends the
 * user's line at :4394.
 *
 * So the register-then-assemble route necessarily composes WITHOUT the line the
 * user has just typed. Writing a note about a scene the user has not yet moved is
 * worse than having no depth slider, so phase 1 composes at the prompt-ready
 * hook — where the user's line IS present — and injects by SPLICING into the
 * outgoing prompt at the configured position.
 *
 * `registerNote` is kept and used when a note is already in hand before
 * assembly, which is the path a future background pre-compose would take.
 *
 * This deviation is flagged in PROGRESS.md for the human rather than decided
 * silently.
 */
function injectIntoArray(prompt, note, opts) {
    const block = { role: opts.role === 'user' ? 'user' : (opts.role === 'assistant' ? 'assistant' : 'system'), content: `<${NOTE_TAG}>\n${note}\n</${NOTE_TAG}>` };
    if (opts.position === 'first') {
        prompt.unshift(block);
        return 1;
    }
    if (opts.position === 'before_last' && prompt.length > 1) {
        prompt.splice(prompt.length - 1, 0, block);
        return 1;
    }
    prompt.push(block);
    return 1;
}

function injectIntoString(prompt, note, opts) {
    const block = `<${NOTE_TAG}>\n${note}\n</${NOTE_TAG}>`;
    if (opts.position === 'first') {
        return `${block}\n\n${prompt}`;
    }
    return `${prompt}\n\n${block}`;
}

/* --------------------------------------------------------------- event wire */

let lastNote = null;
/** The user's swipe/reroll choice for the generation in flight (phase 3). */
let rerollChoice = null;

/**
 * The swipe/reroll popup (§6: "On swipe/reroll, a popup asks: new composer note
 * or reuse the current one"). ST AWAITS this handler (eventemitter.js:146), so
 * the generation genuinely waits for the answer.
 *
 * Cancel/Escape resolves as 'reuse' — the benign answer: no model call, and the
 * choice is recorded on the record either way.
 */
async function askRerollChoice() {
    try {
        const PopupCls = ctx().Popup;
        if (!PopupCls?.show?.confirm) {
            log.warn('reroll', 'no Popup in the ST context — defaulting to a new note');
            return 'new';
        }
        const result = await PopupCls.show.confirm(
            'Copilot note for this swipe',
            'Compose a NEW composer note for this generation, or REUSE the current one?',
            { okButton: 'Compose a new note', cancelButton: 'Reuse the current note' },
        );
        return result === 1 ? 'new' : 'reuse';
    } catch (err) {
        log.warn('reroll', `popup failed — defaulting to a new note: ${redact(String(err?.message ?? err))}`);
        return 'new';
    }
}

/**
 * The diff popup (§6): old vs new extraction + composer, with the options
 * use old / use new / reroll / cancel. Awaited inside the prompt-ready hook,
 * so the outgoing request waits for the answer exactly like the reroll popup.
 */
async function askDiffChoice(oldExtraction, newExtraction, oldNote, newNote) {
    try {
        const call = ctx().callGenericPopup;
        const POPUP_TYPE = ctx().POPUP_TYPE;
        if (!call || !POPUP_TYPE) {
            log.warn('reroll', 'no popup API in the ST context — defaulting to the new note');
            return 'new';
        }
        const block = (label, text) => `<div class="copilot-diff-block"><strong>${escapeHtml(label)}</strong><pre>${escapeHtml(String(text ?? '(none)'))}</pre></div>`;
        const html = `<div class="copilot-diff">
            <p>The reroll composed new copilot data. Which should be used?</p>
            ${block('OLD extraction', oldExtraction)}
            ${block('NEW extraction', newExtraction)}
            ${block('OLD note', oldNote)}
            ${block('NEW note', newNote)}
        </div>`;
        const result = await call(html, POPUP_TYPE.CONFIRM, null, {
            okButton: 'Use the NEW note',
            cancelButton: 'Use the OLD note',
            customButtons: [
                { text: 'Reroll (compose again)', result: 1001 },
                { text: 'Cancel (no note)', result: 1002 },
            ],
        });
        if (result === 1) {
            return 'new';
        }
        if (result === 1001) {
            return 'reroll';
        }
        if (result === 1002) {
            return 'cancel';
        }
        return 'old';
    } catch (err) {
        log.warn('reroll', `diff popup failed — defaulting to the new note: ${redact(String(err?.message ?? err))}`);
        return 'new';
    }
}

async function onGenerationStarted(type, opts = {}, dryRun = false) {
    // Trap 14: every decline logs exactly one line. A dry run, a quiet
    // generation and an impersonation are NOT turns of the narrator and must
    // not consume or advance the generation token — a token bump here once made
    // bindToMessage() see a "stale" note that was composed seconds earlier.
    if (dryRun) {
        log.info('generation', 'dry run — no note composed');
        return;
    }
    if (type === GENERATION_TYPE.QUIET || opts?.quiet_prompt) {
        log.info('generation', `quiet generation (type=${type}) — no note composed`);
        return;
    }
    if (type === GENERATION_TYPE.IMPERSONATE) {
        log.info('generation', 'impersonate — the narrator is not generating');
        return;
    }
    lastToken = nextToken();
    lorebookEntries = new Map();
    clearNote();
    clearPending(SKIP.STALE_GENERATION);
    rerollChoice = null;
    const s = settings();
    if (!s.enabled) {
        log.info('generation', `copilot is disabled — ${SKIP.DISABLED}`);
        return;
    }
    if (!apiKey()) {
        log.warn('generation', `no API key configured — ${SKIP.NO_KEY}`);
        return;
    }
    // Phase 4 (S6): the goal counters and request expiries advance here — once
    // per real narrator turn, by script, before composition reads them.
    tickChatState();
    // Phase 3: swipe and reroll ask first. Everything else composes as usual.
    if (type === 'swipe' || type === 'regenerate') {
        const mode = s.rerollMode ?? 'ask';
        const choice = mode === 'ask' ? await askRerollChoice() : mode;
        rerollChoice = { token: lastToken, choice };
        log.info('reroll', mode === 'ask'
            ? `popup answered: ${choice} (type=${type})`
            : `rerollMode=${mode} — no popup (type=${type})`);
    }
    log.info('generation', `turn starting (type=${type}, token ${lastToken})`);
}

function currentTokenSafe() {
    return lastToken;
}

let lastToken = 0;

function onWorldInfoActivated(entries) {
    if (!Array.isArray(entries)) {
        return;
    }
    // Dedupe by world+uid, never uid alone: two lorebooks routinely both have
    // uid 0 (verified phase 0, public/scripts/world-info.js:594).
    let added = 0;
    for (const e of entries) {
        if (!e || e.uid === undefined) {
            continue;
        }
        const key = `${e.world ?? '?'}.${e.uid}`;
        if (!lorebookEntries.has(key)) {
            added += 1;
        }
        lorebookEntries.set(key, e);
    }
    if (added > 0) {
        log.info('lorebook', `${added} new entries (${lorebookEntries.size} total after dedupe by world+uid)`);
    }
}

/**
 * The prompt-ready hook. Awaited by SillyTavern, so whatever we do here happens
 * before the request is sent.
 *
 * BOTH `chat_completion_prompt_ready` (array) and `generate_after_combine_prompts`
 * (string) fire, and for chat completions the second one ALSO fires with the
 * array under `.prompt`. We therefore discriminate on the payload TYPE, and we
 * are idempotent per generation token — otherwise the text-completion path would
 * inject the note twice (verified phase 0: :5184 and :3972).
 */
const injectedTokens = new Set();

async function onPromptReady(eventData, kind) {
    const payload = eventData ?? {};
    if (payload.dryRun) {
        log.info('inject', 'dry run prompt — nothing injected');
        return;
    }
    const isArray = Array.isArray(payload.chat);
    const isString = typeof payload.prompt === 'string';

    if (kind === EVENT.GENERATE_AFTER_COMBINE_PROMPTS) {
        if (isArray) {
            // The chat-completion payload under the other event. Ignore it: the
            // chat hook will fire for the same array and injecting twice would
            // duplicate the note.
            log.info('inject', 'array seen on generate_after_combine_prompts — deferring to the chat hook');
            return;
        }
        if (!isString) {
            return;
        }
        await injectInto(payload, 'string');
        return;
    }
    if (kind === EVENT.CHAT_COMPLETION_PROMPT_READY) {
        if (!isArray) {
            return;
        }
        await injectInto(payload, 'array');
    }
}

async function injectInto(payload, shape) {
    const token = currentTokenSafe();
    if (injectedTokens.has(token)) {
        log.info('inject', `already injected for token ${token} — ignoring the duplicate hook (trap: fires twice)`);
        return;
    }

    const s = settings();
    const turn = log.turn(String(token));

    let note = lastNote;
    /** @type {object} what bindToMessage() will write for the composer role */
    let composerRecord = null;
    let extractionRecord = null;

    // Phase 3: the popup's "reuse the current one" — no model call, the note
    // goes in again, and the record SAYS it was reused instead of pretending a
    // fresh composition happened.
    const wantsReuse = Boolean(rerollChoice && rerollChoice.token === token
        && rerollChoice.choice === 'reuse' && lastNote);
    if (wantsReuse) {
        note = lastNote;
        turn.reroll = 'reused the previous note (user choice)';
        composerRecord = {
            text: note, model: '(reused from the previous turn)',
            tokensIn: 0, tokensOut: 0, createdAt: Date.now(), staleFlag: false, edited: false,
        };
        turn.composer = composerRecord;
        log.info('reroll', `reusing the current note for token ${token} — no model call`);
    } else {
        const isRerollTurn = Boolean(rerollChoice && rerollChoice.token === token);
        const oldNote = lastNote ?? '';
        let input = collectInput(token);
        const oldExtraction = (input.extractions ?? []).at(-1)?.text ?? '';
        let rerolls = 0;
        for (;;) {
            const composed = await runPipeline(input, {
                key: apiKey(),
                deadlineMs: s.maxWaitMs,
                onEvent: (e) => {
                    if (e.kind === 'attempt') {
                        // A rejected attempt is a FAILURE and must be visible as one
                        // (phase 2: "failures are shown"), not a quiet info line.
                        log[e.ok ? 'info' : 'warn']('provider', `${e.model}: ${e.ok ? 'ok' : `rejected (${e.reason}) — ${e.detail}`}`);
                    } else {
                        log.info('pipeline', e.kind);
                    }
                },
            });

            // Panel detail (§6): what each role was asked, and every attempt on
            // the fallback chain with its raw output — failures shown, not hidden.
            turn.inputs = composed.inputs ?? null;
            turn.lorebookText = composed.lorebook ?? '';
            turn.attempts = (composed.attempts ?? []).map((a) => ({
                model: a.model ?? null,
                ok: a.ok === true,
                reason: a.reason ?? null,
                attemptIndex: a.attemptIndex ?? 0,
                text: typeof a.text === 'string' ? a.text.slice(0, 2000) : '',
            }));

            if (!composed.ok) {
                turn.skipReason = composed.reason;
                turn.failure = { reason: composed.reason, detail: composed.detail ?? '' };
                log.warn('pipeline', `no note this turn — ${composed.reason}: ${composed.detail ?? ''}`);
                break;
            }

            note = composed.note;
            extractionRecord = composed.extraction;
            composerRecord = composed.composer;
            turn.extraction = composed.extraction;
            turn.composer = composed.composer;
            turn.pipelineMs = composed.elapsedMs ?? null;
            lastNote = note;

            // Phase 4 (§6): the diff popup on rerolls — old vs new extraction
            // and note, four options. Only when there IS an old note to diff
            // against and this is a swipe/reroll turn.
            if (!(s.diffPopup !== false && isRerollTurn && oldNote)) {
                break;
            }
            const choice = await askDiffChoice(oldExtraction, composed.extraction?.text ?? '', oldNote, composed.note);
            log.info('reroll', `diff popup answered: ${choice}`);
            turn.reroll = `${turn.reroll ? `${turn.reroll}; ` : ''}diff popup: ${choice}`;
            if (choice === 'new') {
                break;
            }
            if (choice === 'old') {
                note = oldNote;
                extractionRecord = null;
                composerRecord = {
                    text: note, model: '(reused — diff popup: use old)',
                    tokensIn: 0, tokensOut: 0, createdAt: Date.now(), staleFlag: false, edited: false,
                };
                turn.composer = composerRecord;
                turn.extraction = null;
                break;
            }
            if (choice === 'cancel') {
                recordSkip(log, SKIP.SUPPRESSED, 'diff popup: cancel — no note this turn', token);
                injectedTokens.add(token);
                return;
            }
            // 'reroll' — compose again from fresh input (bounded).
            rerolls += 1;
            if (rerolls >= 2) {
                log.warn('reroll', 'diff popup reroll limit reached — keeping the newest composition');
                break;
            }
            input = collectInput(token);
        }
    }

    if (!note) {
        recordSkip(log, SKIP.NO_NOTE, turn.failure?.detail ?? turn.failure?.reason ?? '', token);
        injectedTokens.add(token);
        return;
    }

    const opts = s.injection;
    if (shape === 'array') {
        const count = injectIntoArray(payload.chat, note, opts);
        turn.injection = `array +${count} at ${opts.position}`;
    } else {
        payload.prompt = injectIntoString(payload.prompt, note, opts);
        turn.injection = `string at ${opts.position}`;
    }
    turn.incomingPromptSeen = true;
    injectedTokens.add(token);

    // Keep the note for the registry route and for binding after the reply lands.
    setPending(note, {
        noteHash: noteHash(note),
        position: opts.position,
        extraction: extractionRecord,
        composer: composerRecord,
        model: composerRecord?.model,
        tokensIn: composerRecord?.tokensIn,
        tokensOut: composerRecord?.tokensOut,
        createdAt: composerRecord?.createdAt,
    });

    // Also register it, so a pre-assembly path and SillyTavern's own machinery
    // stay consistent if this turn is ever re-assembled.
    if (lastNote) {
        registerNote(note, { position: 'in_chat', depth: opts.depth, role: roleCode(opts.role) });
    }

    log.info('inject', `note injected (${turn.injection}), ${note.length} chars, token ${token}`);
}

function roleCode(role) {
    return { system: 0, user: 1, assistant: 2 }[role] ?? 0;
}

/* ---------------------------------------------------------- record editing */

/**
 * Phase 3: user edits to a stored record. The LIVE record is mutated (trap 15)
 * through the edit helpers, which keep the superseded value in `history` (I1)
 * and — for extractions — flag the dependent composer entry stale (§6).
 */
function editRecordField(messageIndex, swipeIndex, field, text) {
    try {
        const list = chat();
        const message = list?.[Number(messageIndex)];
        if (!message) {
            return { ok: false, reason: 'message not found' };
        }
        const record = readSwipeRecordOrNull(message, Number(swipeIndex));
        if (!record) {
            return { ok: false, reason: 'no copilot record on that swipe' };
        }
        const res = field === 'composer'
            ? applyComposerEdit(record, text)
            : applyExtractionEdit(record, text);
        if (res.ok) {
            writeSwipeRecord(message, Number(swipeIndex), {}); // re-mirror the updated root
            saveChatConditional?.();
            log.info('edit', `${field} edited on message ${messageIndex} swipe ${swipeIndex}${field === 'extraction' ? ' — composer entry flagged stale' : ''}`);
        } else {
            log.warn('edit', `edit refused on message ${messageIndex} swipe ${swipeIndex}: ${res.reason}`);
        }
        return { ok: res.ok, reason: res.reason };
    } catch (err) {
        log.error('edit', `edit threw: ${redact(String(err?.message ?? err))}`);
        return { ok: false, reason: String((err && err.message) || err) };
    }
}

function editNote(messageIndex, swipeIndex, text) {
    return editRecordField(messageIndex, swipeIndex, 'composer', text);
}

function editExtraction(messageIndex, swipeIndex, text) {
    return editRecordField(messageIndex, swipeIndex, 'extraction', text);
}

function onMessageReceived() {
    const token = currentTokenSafe();
    const has = getPending();
    // Every arrival logs exactly one line (trap 14). Without this, "the record
    // is missing" is indiagnosable: the event may not have fired, or the bind
    // may have thrown before it logged anything.
    log.info('store', `message received — token=${token} pending=${has ? has.token : 'none'}`);
    if (!has) {
        return;
    }
    let result;
    try {
        result = bindToMessage(token);
    } catch (err) {
        log.error('store', `bind threw: ${redact(String(err?.message ?? err))}`);
        injectedTokens.delete(token);
        return;
    }
    const turn = log.turn(String(token));
    if (result.bound) {
        turn.injection = `${turn.injection ?? 'note'} -> bound to message ${result.messageIndex} swipe ${result.swipeIndex}`;
        log.info('store', `note bound to message ${result.messageIndex} swipe ${result.swipeIndex}`);
        saveChatConditional?.();
    } else {
        log.warn('store', `note could not be bound: ${result.reason}`);
    }
    injectedTokens.delete(token);
}

function onChatChanged() {
    // Trap 7: everything in flight is abandoned on a chat change.
    clearPending(SKIP.CHAT_CHANGED);
    resetTokens();
    injectedTokens.clear();
    lorebookEntries = new Map();
    lastNote = null;
    clearNote();
    log.info('chat', 'chat changed — pending state cleared');
}

/* -------------------------------------------------------------- diagnostics */

/**
 * Install the request watcher.
 *
 * This is what satisfies GOAL.md §10.8: it captures the body of the request that
 * actually LEAVES SillyTavern, so "the note was injected" can be checked against
 * the real prompt instead of our own return value.
 */
let watcherInstalled = false;

function installWatcher() {
    if (watcherInstalled || typeof window === 'undefined') {
        return;
    }
    const original = window.fetch?.bind(window);
    if (!original) {
        return;
    }
    watcherInstalled = true;
    window.fetch = async function copilotWatchedFetch(input, init) {
        try {
            const url = typeof input === 'string' ? input : (input?.url ?? '');
            const isBackend = /\/api\/backends\/(chat-completions|text-completions)\/generate/.test(url);
            if (isBackend && typeof init?.body === 'string') {
                const turn = log.turn(String(currentTokenSafe()));
                turn.outgoingPromptSeen = true;
                turn.outgoingBody = init.body;
                const check = verifyInOutgoing(init.body, lastNote ?? '');
                turn.noteFoundOutgoing = check.found;
                turn.finishedAt = Date.now();
                log[check.found ? 'info' : 'warn'](
                    'outgoing',
                    `${url.split('/api/')[1]} — note ${check.found ? 'FOUND' : 'NOT FOUND'} in the real outgoing request`,
                );
            }
        } catch (err) {
            log.error('outgoing', `watcher failed: ${redact(String(err?.message ?? err))}`);
        }
        return original(input, init);
    };
    log.info('boot', 'outgoing-request watcher installed (GOAL.md 10.8)');
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function installPanel() {
    const panelId = 'copilot-debug';
    if (document.getElementById(panelId)) {
        return;
    }
    // ST's own presentation for extension settings: an inline-drawer accordion
    // INSIDE the Extensions drawer (index.html:5760 `#extensions_settings` /
    // :5778 `#extensions_settings2`). The first draft was a floating overlay
    // over the chat — wrong home for it (user report).
    const panel = document.createElement('div');
    panel.id = panelId;
    panel.className = 'extension_container copilot-panel';
    panel.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Copilot</b>
                <code class="copilot-build">build ${BUILD_ID}</code>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="display: none;">
                <div class="copilot-head">
                    <button type="button" data-act="copy">Copy log</button>
                    <button type="button" data-act="clear">Clear</button>
                    <button type="button" data-act="toggle">Toggle</button>
                </div>
                <pre class="copilot-body"></pre>
                <div class="copilot-goals"></div>
                <div class="copilot-records"></div>
            </div>
        </div>`;
    const host = document.getElementById('extensions_settings2')
        || document.getElementById('extensions_settings')
        || document.body;
    host.appendChild(panel);

    // The accordion collapse, through ST's own helper (utils.js toggleDrawer).
    const drawer = panel.querySelector('.inline-drawer');
    panel.querySelector('.inline-drawer-toggle').addEventListener('click', async () => {
        try {
            const utils = await import('/scripts/utils.js');
            const expanded = drawer.querySelector('.inline-drawer-content').style.display !== 'none';
            utils.toggleDrawer(drawer, !expanded);
        } catch (err) {
            log.warn('panel', `drawer toggle failed: ${redact(String((err && err.message) || err))}`);
        }
    });

    const body = panel.querySelector('.copilot-body');
    const render = () => {
        body.textContent = log.toText({ maxPerLine: 400 });
    };

    // ---- Goals and user requests (phase 4, §6 / S6). The counters shown here
    // are the SCRIPT-tracked facts the composer receives — the model is never
    // asked to do the arithmetic.
    const goalsEl = panel.querySelector('.copilot-goals');
    const renderGoals = () => {
        try {
            const meta = ctx().chatMetadata?.copilot ?? {};
            const goals = meta.goals ?? [];
            const requests = meta.requests ?? [];
            goalsEl.innerHTML = `
                <div class="copilot-gr-head"><strong>goals &amp; requests</strong></div>
                <div class="copilot-gr-add">
                    <input type="text" data-gr="goal-text" placeholder="goal (e.g. introduce Bob)" />
                    <input type="text" data-gr="goal-turns" placeholder="turns (blank = forever)" size="12" />
                    <button type="button" data-act="add-goal">Add goal</button>
                </div>
                <div class="copilot-gr-add">
                    <input type="text" data-gr="req-text" placeholder="request (e.g. nudge toward the storm)" />
                    <input type="text" data-gr="req-turns" placeholder="turns (blank = forever)" size="12" />
                    <button type="button" data-act="add-request">Add request</button>
                </div>
                ${goals.map((g) => {
                    const elapsed = Object.values(g.turnCounters ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
                    const remaining = g.remainingTurns === 'forever' ? 'no expiry' : `${Math.max(0, g.remainingTurns - elapsed)} left`;
                    return `<div class="copilot-gr-item${g.complete ? ' copilot-gr-done' : ''}" data-id="${escapeHtml(g.id)}">
                        <span>${escapeHtml(g.text)} — ${elapsed} turns elapsed, ${remaining}${g.complete ? ' (complete)' : ''}</span>
                        ${g.complete ? '' : '<button type="button" data-act="done-goal">Done</button>'}
                    </div>`;
                }).join('')}
                ${requests.map((r) => {
                    const remaining = r.remainingTurns === 'forever' ? 'forever' : `${Math.max(0, r.remainingTurns - (Number(r.turnsElapsed) || 0))} left`;
                    return `<div class="copilot-gr-item${r.complete ? ' copilot-gr-done' : ''}" data-id="${escapeHtml(r.id)}">
                        <span>${escapeHtml(r.text)} — ${remaining}${r.complete ? ' (expired)' : ''}</span>
                        <button type="button" data-act="remove-request">Remove</button>
                    </div>`;
                }).join('')}`;
        } catch (err) {
            goalsEl.textContent = `goals unavailable: ${redact(String((err && err.message) || err))}`;
        }
    };
    goalsEl.addEventListener('click', (ev) => {
        const btn = ev.target.closest?.('button[data-act]');
        if (!btn) {
            return;
        }
        const item = btn.closest('.copilot-gr-item');
        const id = item ? item.dataset.id : null;
        const val = (name) => goalsEl.querySelector(`[data-gr="${name}"]`)?.value ?? '';
        const turns = (raw) => (String(raw).trim() === '' ? 'forever' : Number(raw));
        if (btn.dataset.act === 'add-goal') {
            const text = val('goal-text').trim();
            if (text) {
                addGoal(text, turns(val('goal-turns')));
            }
        } else if (btn.dataset.act === 'add-request') {
            const text = val('req-text').trim();
            if (text) {
                addRequest(text, turns(val('req-turns')));
            }
        } else if (btn.dataset.act === 'done-goal' && id) {
            completeGoal(id);
        } else if (btn.dataset.act === 'remove-request' && id) {
            removeRequest(id);
        }
        renderGoals();
    });

    // ---- The log browser (phase 3, §6): every record in the chat, one card
    // layout repeated per message/swipe, each entry editable. Editing keeps the
    // old value (I1) and an extraction edit flags its composer entry stale.
    const recordsEl = panel.querySelector('.copilot-records');
    const renderRecords = () => {
        try {
            const entries = listRecords(ctx().chat ?? []);
            if (entries.length === 0) {
                recordsEl.innerHTML = '<div class="copilot-record-empty">no copilot records in this chat yet</div>';
                return;
            }
            const last = entries.length - 1;
            recordsEl.innerHTML = entries.map((e, i) => {
                const rec = e.record;
                const stale = rec.composer?.staleFlag === true;
                return `
                <div class="copilot-record" data-mi="${e.messageIndex}" data-si="${e.swipeIndex}">
                    <div class="copilot-record-head">
                        <strong>message ${e.messageIndex} · swipe ${e.swipeIndex}</strong>
                        ${i === last ? '<em class="copilot-badge copilot-badge-latest">last injected note</em>' : ''}
                        ${e.isCurrentSwipe ? '<em class="copilot-badge">current swipe</em>' : ''}
                        ${rec.composer?.edited ? '<em class="copilot-badge">note edited</em>' : ''}
                        ${rec.extraction?.edited ? '<em class="copilot-badge">extraction edited</em>' : ''}
                        ${stale ? `<em class="copilot-warn">⚠ ${escapeHtml(rec.composer.staleReason ?? 'extraction changed, may not match')}</em>` : ''}
                    </div>
                    <label>extraction</label>
                    <textarea data-field="extraction" rows="3">${escapeHtml(rec.extraction?.text ?? '')}</textarea>
                    <button type="button" data-act="save-extraction">Save extraction</button>
                    <label>composer note</label>
                    <textarea data-field="composer" rows="3">${escapeHtml(rec.composer?.text ?? '')}</textarea>
                    <button type="button" data-act="save-note">Save note</button>
                </div>`;
            }).join('');
        } catch (err) {
            recordsEl.textContent = `records unavailable: ${redact(String((err && err.message) || err))}`;
        }
    };

    recordsEl.addEventListener('click', (ev) => {
        const btn = ev.target.closest?.('button[data-act]');
        if (!btn) {
            return;
        }
        const card = btn.closest('.copilot-record');
        if (!card) {
            return;
        }
        const mi = Number(card.dataset.mi);
        const si = Number(card.dataset.si);
        const isNote = btn.dataset.act === 'save-note';
        const field = isNote ? 'composer' : 'extraction';
        const ta = card.querySelector(`textarea[data-field="${isNote ? 'composer' : 'extraction'}"]`);
        const res = editRecordField(mi, si, field, ta ? ta.value : '');
        if (res.ok) {
            renderRecords();
            render();
        }
    });

    panel.querySelector('[data-act="copy"]').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(log.toText({ maxPerLine: 4000 }));
            log.info('panel', 'log copied to the clipboard');
        } catch (err) {
            log.error('panel', `clipboard blocked: ${redact(String((err && err.message) || err))}`);
        }
        render();
    });
    panel.querySelector('[data-act="clear"]').addEventListener('click', () => {
        log.clear();
        render();
    });
    panel.querySelector('[data-act="toggle"]').addEventListener('click', () => {
        const s = settings();
        saveSettings({ enabled: !s.enabled });
        log.info('panel', `copilot ${!s.enabled ? 'enabled' : 'disabled'}`);
        render();
    });
    log.subscribe(() => {
        render();
        // Refresh the browser/goals unless the user is typing in them.
        if (!recordsEl.contains(document.activeElement) && !goalsEl.contains(document.activeElement)) {
            renderRecords();
            renderGoals();
        }
    });
    render();
    renderRecords();
    renderGoals();
    log.info('boot', `copilot loaded — build ${BUILD_ID}`);
}

/* -------------------------------------------------------------------- init */

function init() {
    const es = eventSource();
    if (!es) {
        log.error('boot', 'no eventSource in context — the copilot cannot start');
        return;
    }
    es.on(EVENT.GENERATION_STARTED, (type, opts, dryRun) => {
        // The token is bumped INSIDE onGenerationStarted, and only for real
        // narrator turns. It used to be bumped here too — twice per turn — and
        // setPending()/bindToMessage() disagreed about the token, so every note
        // failed to bind as "stale_generation_aborted".
        return onGenerationStarted(type, opts ?? {}, dryRun === true);
    });
    es.on(EVENT.CHAT_COMPLETION_PROMPT_READY, (data) => onPromptReady(data, EVENT.CHAT_COMPLETION_PROMPT_READY));
    es.on(EVENT.GENERATE_AFTER_COMBINE_PROMPTS, (data) => onPromptReady(data, EVENT.GENERATE_AFTER_COMBINE_PROMPTS));
    es.on(EVENT.MESSAGE_RECEIVED, () => onMessageReceived());
    es.on(EVENT.CHAT_CHANGED, () => onChatChanged());
    es.on(EVENT.WORLD_INFO_ACTIVATED, (entries) => onWorldInfoActivated(entries));

    installWatcher();
    installPanel();

    // Exposed for the T3 driver and for the user in the console. Never holds a
    // secret: apiKey() is a function, not a value.
    window.copilot = {
        log, settings, saveSettings, BUILD_ID, runs: [],
        editNote, editExtraction,
        addGoal, completeGoal, addRequest, removeRequest, tick: tickChatState,
    };

    log.info('boot', `copilot wired up — build ${BUILD_ID}`);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}