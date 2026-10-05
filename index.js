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
import { collectExtractions } from './src/schema/store.js';
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
        goals: (meta.goals ?? []).filter((g) => !g.complete).map((g) => ({
            text: g.text,
            turnsElapsed: Object.values(g.turnCounters ?? {}).reduce((a, b) => a + (Number(b) || 0), 0),
        })),
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

function activeRequestText(meta) {
    return (meta.requests ?? [])
        .filter((r) => !r.complete)
        .map((r) => r.text)
        .join('; ');
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

function onGenerationStarted(type, opts = {}, dryRun = false) {
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
    const s = settings();
    if (!s.enabled) {
        log.info('generation', `copilot is disabled — ${SKIP.DISABLED}`);
        return;
    }
    if (!apiKey()) {
        log.warn('generation', `no API key configured — ${SKIP.NO_KEY}`);
        return;
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
    const composed = await runPipeline(collectInput(token), {
        key: apiKey(),
        deadlineMs: s.maxWaitMs,
        onEvent: (e) => {
            if (e.kind === 'attempt') {
                log.info('provider', `${e.model}: ${e.ok ? 'ok' : `rejected (${e.reason}) — ${e.detail}`}`);
            } else {
                log.info('pipeline', e.kind);
            }
        },
    });

    if (composed.ok) {
        note = composed.note;
        turn.extraction = composed.extraction;
        turn.composer = composed.composer;
        lastNote = note;
    } else {
        turn.skipReason = composed.reason;
        log.warn('pipeline', `no note this turn — ${composed.reason}: ${composed.detail ?? ''}`);
    }

    if (!note) {
        recordSkip(log, SKIP.NO_NOTE, composed.detail ?? composed.reason ?? '', token);
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
        noteHash: composed.noteHash,
        position: opts.position,
        extraction: composed.extraction,
        composer: composed.composer,
        model: composed.composer?.model,
        tokensIn: composed.composer?.tokensIn,
        tokensOut: composed.composer?.tokensOut,
        createdAt: composed.composer?.createdAt,
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

function installPanel() {
    const panelId = 'copilot-debug';
    if (document.getElementById(panelId)) {
        return;
    }
    const panel = document.createElement('div');
    panel.id = panelId;
    panel.className = 'copilot-panel';
    panel.innerHTML = `
        <div class="copilot-head">
            <strong>Copilot</strong>
            <code class="copilot-build">build ${BUILD_ID}</code>
            <button type="button" data-act="copy">Copy log</button>
            <button type="button" data-act="clear">Clear</button>
            <button type="button" data-act="toggle">Toggle</button>
        </div>
        <pre class="copilot-body"></pre>`;
    document.body.appendChild(panel);

    const body = panel.querySelector('.copilot-body');
    const render = () => {
        body.textContent = log.toText({ maxPerLine: 400 });
    };
    panel.querySelector('[data-act="copy"]').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(log.toText({ maxPerLine: 4000 }));
            log.info('panel', 'log copied to the clipboard');
        } catch (err) {
            log.error('panel', `clipboard blocked: ${redact(String(err?.message ?? err))}`);
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
    log.subscribe(render);
    render();
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
    window.copilot = { log, settings, saveSettings, BUILD_ID, runs: [] };

    log.info('boot', `copilot wired up — build ${BUILD_ID}`);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}