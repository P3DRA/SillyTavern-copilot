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
import { mergeLoreEntries } from './src/core/prompts.js';
import { applyComposerEdit, applyExtractionEdit } from './src/schema/edit.js';
import {
    noteHash, goalFacts, tickGoals, tickRequests, makeGoal, makeUserRequest,
} from './src/schema/records.js';
import { emptySpend, recordSpend, spendSummary } from './src/core/spend.js';
import {
    presetFromSettings, applyPreset, upsertPreset, removePreset,
} from './src/core/presets.js';
import {
    compressEntries, undoCompressionAt, autoSelect, validateSelection,
} from './src/core/compressor.js';
import { exportChatState, importChatState, restoreImport } from './src/schema/transfer.js';
import { callWithFallback } from './src/core/provider.js';
import { pushSnapshot } from './src/schema/records.js';
import { redact } from './src/core/redact.js';
import {
    ctx, chat, eventSource, saveChatConditional, saveMetadata,
    nextToken, isCurrent, resetTokens, clearPending,
    setPending, getPending, bindToMessage, recordSkip, registerNote, clearNote,
    hasPendingSkip,
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
    // Shipped defaults per the §10.4 model matrix (tests/runs/matrix-*, live):
    //  - extractor: ling-3.0-flash is the cheapest model that CERTIFIED on the
    //    required <state> format AND meets the every-turn latency budget
    //    (2/2 format at ~1.4s). dots-3-note-preview:free is the literal
    //    cheapest certified (0/0) but takes 16-43s per extraction — kept as
    //    the FREE fallback. ling-3.1-flash is free but was rate-limited to
    //    unusability during the matrix (429 on 4 of 4 cells).
    //  - composer: qwen3.7-flash is the strongest affordable model that
    //    certified (2/2 <copilot> tag); l3-lunaris-8b is the lean fast
    //    fallback; dots-3 as the free floor. mistral-nemo — the USER's pick to
    //    power the NARRATOR — failed the composer tag battery 2/2 (unclosed)
    //    and is NOT shipped as composer; the matrix is a test result.
    extractor: {
        chain: ['inclusionai/ling-3.0-flash', 'dots-studio/dots-3-note-preview:free'],
        retries: 1,
        temperature: 0.2,
        maxChars: 6000,
    },
    composer: {
        chain: ['qwen/qwen3.7-flash', 'sao10k/l3-lunaris-8b', 'dots-studio/dots-3-note-preview:free'],
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
    // Phase 5 (§6): the USER-editable pricing table (per token, as OpenRouter
    // publishes prices). Zero by default — the counter reports tokens
    // regardless and never invents a price.
    pricing: {
        extractor: { prompt: 0, completion: 0 },
        composer: { prompt: 0, completion: 0 },
        narrator: { prompt: 0, completion: 0 },
    },
    // Phase 5 (§6): hot-swappable extractor/composer configuration bundles.
    presets: [],
    activePreset: null,
    // Phase 6 (§6): the compressor. Auto-compress is DEFAULT-OFF — GOAL.md §13
    // gates enabling it by default on the G2 human review of the torture test.
    compress: { auto: false, maxVisible: 40, mergeCount: 10 },
    // §6: "A text box lists keys that are permanently triggered." Comma or
    // newline separated lorebook trigger keywords; matching entries are always
    // included in the composer's lorebook block (deduped against the triggered
    // set by world+uid — an entry never appears twice).
    permanentLoreKeys: '',
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
async function collectInput(turnId) {
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
        lorebook: readLorebook(await readPermanentLorebook()),
        characterCard: ctx().name2 ?? '',
        narratorPrompt: ctx().systemPrompt ?? '',
        userRequest: activeRequestText(meta),
        // Script-tracked goal FACTS (S6): the counters are computed here, never
        // by the model. goalFacts drops completed goals.
        goals: goalFacts(meta.goals ?? [], GOAL_COUNTER_KEY),
        previousNote: previousNoteFor(list),
        settings: settings(),
        // §5 (critique finding 12): which goals/requests were ACTIVE when this
        // note was composed — they end up in injection.goalsActive/userRequestsActive.
        goalIds: (meta.goals ?? []).filter((g) => !g.complete).map((g) => g.id),
        requestIds: (meta.requests ?? []).filter((r) => !r.complete).map((r) => r.id),
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

function readLorebook(extra = []) {
    // §6: an entry never appears twice — triggered and permanent entries are
    // merged by world+uid (mergeLoreEntries).
    const merged = mergeLoreEntries([...lorebookEntries.values()], extra);
    return merged
        .map((e) => `- ${e.comment ?? `entry ${e.uid}`}: ${e.content ?? ''}`)
        .join('\n');
}

/**
 * §6: "A text box lists keys that are permanently triggered." Entries whose
 * trigger keys match are looked up straight from the active world books, so
 * they reach the composer EVERY turn — not only when ST's scan happens to
 * trigger them. Cheap per generation (the books are already in memory).
 */
async function readPermanentLorebook() {
    try {
        const wanted = String(settings().permanentLoreKeys ?? '')
            .split(/[,\n]/).map((k) => k.trim().toLowerCase()).filter(Boolean);
        if (wanted.length === 0) {
            return [];
        }
        const wi = await import('/scripts/world-info.js');
        // BOTH the globally-selected books AND the chat's own book
        // (chat_metadata.world_info, METADATA_KEY in world-info.js:94) — the
        // chat book is not in selected_world_info and was silently skipped.
        const books = [...new Set([
            ...(wi.selected_world_info ?? []),
            ...(String(ctx().chatMetadata?.world_info ?? '') ? [String(ctx().chatMetadata.world_info)] : []),
        ])];
        const out = [];
        for (const world of books) {
            const book = await wi.loadWorldInfo(world);
            for (const e of Object.values(book?.entries ?? {})) {
                if (!e || e.disable || typeof e.content !== 'string') {
                    continue;
                }
                const keys = [...(e.key ?? []), ...(e.keysecondary ?? [])].map((k) => String(k).toLowerCase());
                if (keys.some((k) => wanted.includes(k))) {
                    out.push({ world, uid: e.uid, comment: e.comment ?? '', content: e.content });
                }
            }
        }
        return out;
    } catch (err) {
        // Trap 14: every decline logs one line.
        log.warn('lorebook', `permanent-keys lookup failed: ${redact(String(err?.message ?? err))}`);
        return [];
    }
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
    try {
        saveMetadata();
    } catch (err) {
        // The mutation is already applied in memory; a metadata save failure
        // must say so loudly but never lose or block the edit.
        log.warn('store', `metadata save failed: ${redact(String(err?.message ?? err))}`);
    }
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

/* ------------------------------------------------------ spend and presets */

/**
 * The spend counter (§6): provider-reported usage only, priced by the USER's
 * table. Per-chat state (chat_metadata.copilot.spend), so totals survive a
 * reload and never leak between chats.
 */
function recordRoleSpend(role, usage) {
    const u = { tokensIn: usage?.tokensIn ?? 0, tokensOut: usage?.tokensOut ?? 0 };
    const price = settings().pricing?.[role] ?? {};
    withMeta((root) => {
        root.spend = root.spend ?? emptySpend();
        recordSpend(root.spend, role, u, price);
        return { ok: true, reason: null };
    });
    if (u.tokensIn || u.tokensOut) {
        log.info('spend', `${role}: +${u.tokensIn}/${u.tokensOut} provider-reported tokens`);
    } else {
        log.info('spend', `${role}: no provider usage reported (streamed?) — counted as zero`);
    }
}

/** Current per-chat spend totals, per role and combined. */
function spendTotals() {
    return spendSummary(ctx().chatMetadata?.copilot?.spend ?? emptySpend());
}

// Presets are USER configuration, not chat data — they live in the extension
// settings and survive across chats (§6: hot-swappable bundles).
function savePreset(name) {
    const s = settings();
    const preset = presetFromSettings(name, s);
    if (!preset.name) {
        return { ok: false, reason: 'a preset needs a name' };
    }
    saveSettings({ presets: upsertPreset(s.presets ?? [], preset), activePreset: preset.id });
    log.info('presets', `preset saved: "${preset.name}"`);
    return { ok: true, reason: null, id: preset.id };
}

function applyPresetById(id) {
    const s = settings();
    const preset = (s.presets ?? []).find((p) => p.id === id);
    if (!preset) {
        return { ok: false, reason: 'preset not found' };
    }
    const patch = applyPreset(preset);
    // saveSettings merges shallowly — merge the role configs ourselves so a
    // preset swap never drops fields it does not carry.
    saveSettings({
        extractor: { ...s.extractor, ...patch.extractor },
        composer: { ...s.composer, ...patch.composer },
        activePreset: id,
    });
    log.info('presets', `preset applied: "${preset.name}"`);
    return { ok: true, reason: null, name: preset.name };
}

function deletePreset(id) {
    const s = settings();
    saveSettings({
        presets: removePreset(s.presets ?? [], id),
        activePreset: s.activePreset === id ? null : s.activePreset,
    });
    log.info('presets', 'preset deleted');
    return { ok: true, reason: null };
}

/* ------------------------------------------------------------- compressor */

/**
 * The model call for compression: the EXTRACTOR's chain with the dedicated
 * compress prompt (§6), judged by I4's own gate (not the composer's prose
 * bounds — same rule as the extractor).
 */
function compressorCall(messages) {
    const s = settings();
    return callWithFallback({
        models: s.extractor?.chain ?? [],
        retries: s.extractor?.retries ?? 1,
        key: apiKey(),
        baseUrl: s.baseUrl,
        messages,
        temperature: s.extractor?.temperature ?? 0.2,
        maxTokens: s.extractor?.maxTokens,
        minWords: 1,
        maxWords: 20000,
        onEvent: (e) => {
            if (e.kind === 'attempt') {
                log[e.ok ? 'info' : 'warn']('compress', `${e.model}: ${e.ok ? 'ok' : `rejected (${e.reason}) — ${e.detail}`}`);
            }
        },
    }).then((r) => ({
        ok: r.ok,
        text: r.text,
        model: r.model ?? '',
        tokensIn: r.attempts.reduce((n, a) => n + (a.tokensIn || 0), 0),
        tokensOut: r.attempts.reduce((n, a) => n + (a.tokensOut || 0), 0),
        reason: r.summary,
    }));
}

/**
 * Manual compression over visible entries (§6: the selection table). The
 * snapshot goes into chat_metadata (I3, capped at 5) and the merged record is
 * remembered for undo.
 */
async function runManualCompression(indices) {
    try {
        const list = chat();
        const entries = collectExtractions(list);
        const sel = validateSelection(indices);
        if (!sel.ok) {
            log.warn('compress', `refused: ${sel.reason}`);
            return { ok: false, reason: sel.reason };
        }
        const res = await compressEntries(list, entries, indices, {
            callModel: compressorCall, now: Date.now(), prompt: settings().compressorPrompt,
        });
        if (!res.ok) {
            // I4: nothing changed — and the user is told (panel + log).
            log.warn('compress', `refused: ${res.reason}`);
            return { ok: false, reason: res.reason };
        }
        recordRoleSpend('extractor', {
            tokensIn: res.merged?.tokensIn ?? 0, tokensOut: res.merged?.tokensOut ?? 0,
        });
        withMeta((root) => {
            root.snapshots = pushSnapshot(root.snapshots ?? [], res.snapshot);
            root.lastCompression = res.merged;
            return { ok: true, reason: null };
        });
        saveChatConditional?.();
        log.info('compress', `merged ${res.originals.length} extractions into ${res.merged.id} (${res.merged.text.length} chars, sources kept)`);
        return { ok: true, reason: null, id: res.merged.id, merged: res.originals.length };
    } catch (err) {
        log.error('compress', `compression threw: ${redact(String(err?.message ?? err))}`);
        return { ok: false, reason: String((err && err.message) || err) };
    }
}

/** Undo the last compression exactly (I2). */
function undoLastCompression() {
    try {
        const meta = ctx().chatMetadata?.copilot ?? {};
        const merged = meta.lastCompression;
        const res = undoCompressionAt(chat(), merged);
        if (!res.ok) {
            log.warn('compress', `undo refused: ${res.reason}`);
            return { ok: false, reason: res.reason };
        }
        withMeta((root) => {
            delete root.lastCompression;
            return { ok: true, reason: null };
        });
        saveChatConditional?.();
        log.info('compress', `undo: ${merged.sources.length} originals restored`);
        return { ok: true, reason: null };
    } catch (err) {
        log.error('compress', `undo threw: ${redact(String(err?.message ?? err))}`);
        return { ok: false, reason: String((err && err.message) || err) };
    }
}

/**
 * Auto-compress (§6): more than `maxVisible` visible extractions → merge the
 * `mergeCount` oldest contiguous usable run. NEVER runs unless the user turns
 * it on — G2 gates enabling it by default.
 */
async function runAutoCompression() {
    const s = settings();
    const list = chat();
    const entries = collectExtractions(list);
    const indices = autoSelect(entries, {
        maxVisible: s.compress?.maxVisible ?? 40,
        mergeCount: s.compress?.mergeCount ?? 10,
    });
    if (indices.length < 2) {
        log.info('compress', `auto: nothing to merge (${entries.length} visible, threshold ${s.compress?.maxVisible ?? 40})`);
        return { ok: true, reason: null, merged: 0 };
    }
    const res = await runManualCompression(indices);
    log.info('compress', `auto: ${res.ok ? `merged ${res.merged}` : `skipped — ${res.reason}`}`);
    return res;
}

/** Pin (unmashable) or protect (auto-merge excludes it) one extraction. */
function toggleEntryFlag(messageIndex, swipeIndex, field) {
    try {
        const message = chat()?.[Number(messageIndex)];
        const record = readSwipeRecordOrNull(message, Number(swipeIndex));
        if (!record?.extraction) {
            return { ok: false, reason: 'no extraction there' };
        }
        record.extraction[field] = !record.extraction[field];
        writeSwipeRecord(message, Number(swipeIndex), {});
        log.info('compress', `extraction ${record.extraction.id}: ${field} = ${record.extraction[field]}`);
        return { ok: true, reason: null, value: record.extraction[field] };
    } catch (err) {
        log.error('compress', `flag toggle threw: ${redact(String(err?.message ?? err))}`);
        return { ok: false, reason: String((err && err.message) || err) };
    }
}

/* ------------------------------------------------------- import / export */

/** Bundle this chat's copilot state (extractions, goals, requests). */
function exportStateToBundle() {
    const meta = ctx().chatMetadata?.copilot ?? {};
    const bundle = exportChatState(chat(), meta);
    log.info('transfer', `exported ${bundle.extractions.length} extractions, ${bundle.goals.length} goals, ${bundle.requests.length} requests`);
    return bundle;
}

/**
 * Import a bundle into this chat (S9). The pre-import snapshot is kept in
 * chat_metadata so "Restore pre-import snapshot" is always one click away.
 */
function importStateFromBundle(state) {
    try {
        const metaRoot = ctx().chatMetadata;
        if (!metaRoot) {
            return { ok: false, reason: 'no chat metadata' };
        }
        const meta = metaRoot.copilot ?? (metaRoot.copilot = {});
        const res = importChatState(chat(), meta, state);
        if (!res.ok) {
            log.warn('transfer', `import refused: ${res.reason}`);
            return { ok: false, reason: res.reason };
        }
        meta.preImportSnapshot = { snapshot: res.snapshot, metaSnapshot: res.metaSnapshot, createdSlots: res.createdSlots };
        saveMetadata();
        saveChatConditional?.();
        log.info('transfer', `imported ${res.added} extractions, ${meta.goals?.length ?? 0} goals, ${meta.requests?.length ?? 0} requests (snapshot kept for undo)`);
        return { ok: true, reason: null, added: res.added };
    } catch (err) {
        log.error('transfer', `import threw: ${redact(String(err?.message ?? err))}`);
        return { ok: false, reason: String((err && err.message) || err) };
    }
}

/** Restore the pre-import snapshot exactly (S9). */
function restorePreImport() {
    try {
        const metaRoot = ctx().chatMetadata;
        const meta = metaRoot?.copilot ?? {};
        const res = restoreImport(chat(), meta, meta.preImportSnapshot);
        if (!res.ok) {
            log.warn('transfer', `restore refused: ${res.reason}`);
            return { ok: false, reason: res.reason };
        }
        delete meta.preImportSnapshot;
        saveMetadata();
        saveChatConditional?.();
        log.info('transfer', 'pre-import snapshot restored (S9)');
        return { ok: true, reason: null };
    } catch (err) {
        log.error('transfer', `restore threw: ${redact(String(err?.message ?? err))}`);
        return { ok: false, reason: String((err && err.message) || err) };
    }
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
    if (opts.position === 'none') {
        // 'none' means log-only: the note is composed, stored and bound — just
        // never spliced into the prompt.
        return prompt;
    }
    if (opts.position === 'first') {
        return `${block}\n\n${prompt}`;
    }
    if (opts.position === 'before_last') {
        // The string prompt is one assembled blob with no message boundaries —
        // 'before_last' is honored on the ARRAY shape. Downgrading it here used
        // to be SILENT (critique finding 9); it now says so (trap 14).
        log.info('inject', "position 'before_last' is not separable in the string prompt shape — injected at end (the array shape honors it)");
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
/**
 * Trap 7: a popup left open must never hang a generation. Every popup is raced
 * against a timeout that resolves to its documented benign answer (critique
 * round 1 found both popups awaited forever — a chat change does not resolve
 * a Popup promise).
 */
function popupWithTimeout(promise, ms, fallback, label) {
    let timer = null;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
            log.warn('popup', `${label} unanswered for ${ms}ms — using the benign default '${fallback}' (trap 7)`);
            resolve(fallback);
        }, ms);
    });
    return Promise.race([
        Promise.resolve(promise).finally(() => clearTimeout(timer)),
        timeout,
    ]);
}

async function askRerollChoice() {
    try {
        const PopupCls = ctx().Popup;
        if (!PopupCls?.show?.confirm) {
            log.warn('reroll', 'no Popup in the ST context — defaulting to a new note');
            return 'new';
        }
        // Benign default on timeout = 'reuse' (no model call — decision record 4).
        return await popupWithTimeout(
            PopupCls.show.confirm(
                'Copilot note for this swipe',
                'Compose a NEW composer note for this generation, or REUSE the current one?',
                { okButton: 'Compose a new note', cancelButton: 'Reuse the current note' },
            ).then((result) => (result === 1 ? 'new' : 'reuse')),
            45000, 'reuse', 'reroll popup',
        );
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
        // Benign default on timeout = 'new' (use what was composed; matches the
        // catch default). Never hangs the generation (trap 7).
        return await popupWithTimeout(
            call(html, POPUP_TYPE.CONFIRM, null, {
                okButton: 'Use the NEW note',
                cancelButton: 'Use the OLD note',
                customButtons: [
                    { text: 'Reroll (compose again)', result: 1001 },
                    { text: 'Cancel (no note)', result: 1002 },
                ],
            }).then((result) => {
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
            }),
            60000, 'new', 'diff popup',
        );
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
    const droppedPending = clearPending(SKIP.STALE_GENERATION);
    if (droppedPending) {
        // Trap 14 + I1 (F13, critique round 1): dropping a composed note and its
        // extraction with NO log line is undiagnosable. Say it happened.
        log.warn('inject', `dropped a pending note/extraction (${droppedPending}) — the previous generation never landed a reply`);
    }
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
    // ST's EventEmitter SWALLOWS listener errors (eventemitter.js:145-151:
    // console.error + continue with the generation). A throw in here would
    // silently send the request without the note — exactly the failure shape
    // that cost this project its first seven turns. Whatever happens lands in
    // the log (trap 14).
    try {
        await injectIntoUnsafe(payload, shape);
    } catch (err) {
        log.error('inject', `injection threw — the request continues WITHOUT the note: ${redact(String(err?.message ?? err))}`);
    }
}

async function injectIntoUnsafe(payload, shape) {
    const token = currentTokenSafe();
    if (injectedTokens.has(token)) {
        log.info('inject', `already injected for token ${token} — ignoring the duplicate hook (trap: fires twice)`);
        return;
    }

    const s = settings();
    const turn = log.turn(String(token));

    // S5/I5: garbage output ends the turn with NO note — the chat continues.
    // The previous note is reused ONLY by explicit user choice (the reroll
    // popup's "reuse"), never as a silent fallback: injecting stale guidance
    // after a failed compose is exactly the quiet divergence §6 forbids.
    let note = null;
    let composerRecord = null;
    let extractionRecord = null;
    // Hoisted out of the compose loop — setPending runs outside it (a batch-1
    // edit referenced `input` there and threw "input is not defined" on EVERY
    // turn: caught live by the S1 scenario run).
    let activeGoalIds = [];
    let activeRequestIds = [];

    // Phase 3: the popup's "reuse the current one" — no model call, the note
    // goes in again, and the record SAYS it was reused instead of pretending a
    // fresh composition happened.
    //
    // F6 (critique round 1): `lastNote` is in-memory — after a reload or chat
    // switch it is null and 'reuse' silently composed a NEW note instead. Fall
    // back to the STORED note so the user's choice survives.
    const storedNote = lastNote ?? previousNoteFor(chat());
    const wantsReuse = Boolean(rerollChoice && rerollChoice.token === token
        && rerollChoice.choice === 'reuse' && storedNote);
    if (wantsReuse) {
        note = storedNote;
        turn.reroll = 'reused the previous note (user choice)';
        composerRecord = {
            text: note, model: '(reused from the previous turn)',
            tokensIn: 0, tokensOut: 0, createdAt: Date.now(), staleFlag: false, edited: false,
        };
        turn.composer = composerRecord;
        log.info('reroll', `reusing the current note for token ${token} — no model call`);
    } else {
        const isRerollTurn = Boolean(rerollChoice && rerollChoice.token === token);
        const oldNote = storedNote ?? '';
        let input = await collectInput(token);
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

            // Spend (phase 5): provider-reported usage per role, counted even
            // when the attempt failed — it was spent regardless.
            if (composed.spend?.extractor) {
                recordRoleSpend('extractor', composed.spend.extractor);
            }
            if (composed.spend?.composer) {
                recordRoleSpend('composer', composed.spend.composer);
            }

            // Panel detail (§6): what each role was asked, and every attempt on
            // the fallback chain with its raw output — failures shown, not hidden.
            turn.inputs = composed.inputs ?? null;
            turn.lorebookText = composed.lorebook ?? '';
            turn.attempts = (composed.attempts ?? []).map((a) => ({
                model: a.model ?? null,
                ok: a.ok === true,
                reason: a.reason ?? null,
                attemptIndex: a.attemptIndex ?? 0,
                tokensIn: a.tokensIn ?? 0,
                tokensOut: a.tokensOut ?? 0,
                text: typeof a.text === 'string' ? a.text.slice(0, 2000) : '',
            }));

            if (!composed.ok) {
                turn.skipReason = composed.reason;
                turn.failure = { reason: composed.reason, detail: composed.detail ?? '' };
                // I1 (F1, critique round 1): the pipeline KEEPS the extraction
                // even when the composer fails — carry it so recordSkip can
                // store it. Without this the extractor's output was destroyed.
                extractionRecord = composed.extraction ?? null;
                turn.extraction = extractionRecord;
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
            activeGoalIds = input.goalIds ?? [];
            activeRequestIds = input.requestIds ?? [];

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
                recordSkip(log, SKIP.SUPPRESSED, 'diff popup: cancel — no note this turn', token, extractionRecord);
                injectedTokens.add(token);
                return;
            }
            // 'reroll' — compose again from fresh input (bounded).
            rerolls += 1;
            if (rerolls >= 2) {
                log.warn('reroll', 'diff popup reroll limit reached — keeping the newest composition');
                break;
            }
            input = await collectInput(token);
        }
    }

    if (!note) {
        recordSkip(log, SKIP.NO_NOTE, turn.failure?.detail ?? turn.failure?.reason ?? '', token,
            extractionRecord ?? turn.extraction ?? null);
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
        goalIds: activeGoalIds,
        requestIds: activeRequestIds,
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
    log.info('store', `message received — token=${token} pending=${has ? has.token : (hasPendingSkip(token) ? 'skip' : 'none')}`);
    // Bind whenever a NOTE or a SKIP is pending for this token (F1: a failed
    // turn carries a skip record that must land on the reply).
    if (!has && !hasPendingSkip(token)) {
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
        const what = result.skipped ? 'skip record' : 'note';
        turn.injection = `${turn.injection ?? what} -> bound to message ${result.messageIndex} swipe ${result.swipeIndex}`;
        log.info('store', `${what} bound to message ${result.messageIndex} swipe ${result.swipeIndex}`);
        saveChatConditional?.();
    } else {
        log.warn('store', `note could not be bound: ${result.reason}`);
    }
    injectedTokens.delete(token);
    // Reviewer-3: auto-compress is AUTOMATIC when the setting is on (G2 gates
    // the DEFAULT, not the wiring). Fire-and-forget — a slow merge must never
    // block the turn (I5).
    maybeAutoCompress();
}

/**
 * §6 "Auto: when more than X extractions exist, merge the Y oldest" — the real
 * behavior behind the panel's checkbox (critique round 1 found the checkbox
 * decorative: nothing read the setting).
 */
function maybeAutoCompress() {
    try {
        const s = settings();
        if (!s.compress?.auto) {
            return;
        }
        const visible = collectExtractions(chat()).length;
        const threshold = s.compress?.maxVisible ?? 40;
        if (visible <= threshold) {
            return;
        }
        log.info('compress', `auto: ${visible} visible > ${threshold} — merging the oldest usable run`);
        runAutoCompression().catch((err) => {
            log.warn('compress', `auto-compress failed: ${redact(String(err?.message ?? err))}`);
        });
    } catch (err) {
        log.warn('compress', `auto-compress check failed: ${redact(String(err?.message ?? err))}`);
    }
}

function onChatChanged() {
    // Trap 7: everything in flight is abandoned on a chat change.
    const droppedOnSwitch = clearPending(SKIP.CHAT_CHANGED);
    resetTokens();
    injectedTokens.clear();
    lorebookEntries = new Map();
    lastNote = null;
    clearNote();
    log.info('chat', `chat changed — pending state cleared${droppedOnSwitch ? ` (dropped a pending ${droppedOnSwitch})` : ''}`);
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
        let watched = false;
        try {
            const url = typeof input === 'string' ? input : (input?.url ?? '');
            const isBackend = /\/api\/backends\/(chat-completions|text-completions)\/generate/.test(url);
            if (isBackend && typeof init?.body === 'string') {
                watched = true;
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
        const res = await original(input, init);
        if (watched) {
            // Spend (§6): the NARRATOR's provider-reported usage, read from the
            // response. A streamed response reports nothing (PROBLEMS.md §4) —
            // counted as zero and SAID so, never estimated.
            try {
                res.clone().json().then((body) => {
                    const u = body?.usage;
                    recordRoleSpend('narrator', {
                        tokensIn: u?.prompt_tokens ?? 0,
                        tokensOut: u?.completion_tokens ?? 0,
                    });
                }).catch(() => {
                    log.info('spend', 'narrator: response carried no JSON usage (streamed?) — counted as zero');
                });
            } catch { /* unreadable response — nothing to count */ }
        }
        return res;
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
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-up up"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="copilot-head">
                    <button type="button" data-act="copy">Copy log</button>
                    <button type="button" data-act="clear">Clear</button>
                    <button type="button" data-act="toggle">Toggle</button>
                </div>
                <pre class="copilot-body"></pre>
                <div class="copilot-goals"></div>
                <div class="copilot-presets"></div>
                <div class="copilot-spend"></div>
                <div class="copilot-lore"></div>
                <div class="copilot-compress"></div>
                <div class="copilot-transfer"></div>
                <div class="copilot-settings"></div>
                <div class="copilot-records"></div>
            </div>
        </div>`;
    const host = document.getElementById('extensions_settings2')
        || document.getElementById('extensions_settings')
        || document.body;
    host.appendChild(panel);

    // NO toggle listener here on purpose: ST has a GLOBAL delegated handler
    // for every `.inline-drawer-toggle` click (script.js:12131) that slides the
    // content and flips the chevron. Binding our own toggle on top of it
    // double-toggled the drawer on each click — it opened and instantly closed
    // (user report with screenshot). The markup above ships OPEN so the log is
    // visible on install; ST's own handler owns the accordion from there.

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

    // ---- Presets (phase 5, §6): hot-swappable extractor/composer bundles.
    const presetsEl = panel.querySelector('.copilot-presets');
    const renderPresets = () => {
        try {
            const s = settings();
            const list = s.presets ?? [];
            presetsEl.innerHTML = `
                <div class="copilot-gr-head"><strong>presets</strong></div>
                <div class="copilot-gr-add">
                    <select data-gr="preset-select">
                        ${list.map((p) => `<option value="${escapeHtml(p.id)}"${p.id === s.activePreset ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
                    </select>
                    <button type="button" data-act="apply-preset">Apply</button>
                    <button type="button" data-act="delete-preset">Delete</button>
                </div>
                <div class="copilot-gr-add">
                    <input type="text" data-gr="preset-name" placeholder="new preset name (saves the current config)" />
                    <button type="button" data-act="save-preset">Save current as preset</button>
                </div>`;
        } catch (err) {
            presetsEl.textContent = `presets unavailable: ${redact(String(err?.message ?? err))}`;
        }
    };
    presetsEl.addEventListener('click', (ev) => {
        const btn = ev.target.closest?.('button[data-act]');
        if (!btn) {
            return;
        }
        const val = (name) => presetsEl.querySelector(`[data-gr="${name}"]`)?.value ?? '';
        if (btn.dataset.act === 'save-preset') {
            const name = val('preset-name').trim();
            if (name) {
                savePreset(name);
            }
        } else if (btn.dataset.act === 'apply-preset') {
            applyPresetById(val('preset-select'));
        } else if (btn.dataset.act === 'delete-preset') {
            deletePreset(val('preset-select'));
        }
        renderPresets();
        render();
    });

    // ---- The spend counter (phase 5, §6): user-editable per-token prices and
    // provider-reported totals, per role and combined.
    const spendEl = panel.querySelector('.copilot-spend');
    const renderSpend = () => {
        try {
            const s = settings();
            const p = s.pricing ?? {};
            const t = spendTotals();
            const row = (role) => `
                <div class="copilot-gr-add">
                    <span class="copilot-spend-role">${role}</span>
                    <input type="text" data-price="${role}-prompt" value="${escapeHtml(String(p[role]?.prompt ?? 0))}" size="10" title="price per input token" />
                    <input type="text" data-price="${role}-completion" value="${escapeHtml(String(p[role]?.completion ?? 0))}" size="10" title="price per output token" />
                    <span class="copilot-spend-total">${t.roles[role].tokensIn}/${t.roles[role].tokensOut} tok · $${t.roles[role].costUsd.toFixed(6)} · ${t.roles[role].calls} calls</span>
                </div>`;
            spendEl.innerHTML = `
                <div class="copilot-gr-head"><strong>spend</strong> <em class="copilot-spend-note">provider-reported usage only; prices are per token, yours to edit</em></div>
                ${row('extractor')}
                ${row('composer')}
                ${row('narrator')}
                <div class="copilot-gr-add">
                    <span class="copilot-spend-role">combined</span>
                    <span class="copilot-spend-total">${t.combined.tokensIn}/${t.combined.tokensOut} tok · $${t.combined.costUsd.toFixed(6)} · ${t.combined.calls} calls</span>
                    <button type="button" data-act="save-prices">Save prices</button>
                </div>`;
        } catch (err) {
            spendEl.textContent = `spend unavailable: ${redact(String(err?.message ?? err))}`;
        }
    };
    spendEl.addEventListener('click', (ev) => {
        const btn = ev.target.closest?.('button[data-act="save-prices"]');
        if (!btn) {
            return;
        }
        const price = (name) => Number(spendEl.querySelector(`[data-price="${name}"]`)?.value) || 0;
        saveSettings({
            pricing: {
                extractor: { prompt: price('extractor-prompt'), completion: price('extractor-completion') },
                composer: { prompt: price('composer-prompt'), completion: price('composer-completion') },
                narrator: { prompt: price('narrator-prompt'), completion: price('narrator-completion') },
            },
        });
        log.info('spend', 'pricing table saved');
        renderSpend();
        render();
    });

    // ---- The lorebook box (§6): keys that are permanently triggered.
    const loreEl = panel.querySelector('.copilot-lore');
    const renderLore = () => {
        try {
            // Keep unsaved typing across re-renders (the log subscriber fires
            // mid-edit) — same guard as the transfer box.
            const keep = loreEl.querySelector('[data-gr="lore-keys"]')?.value;
            loreEl.innerHTML = `
                <div class="copilot-gr-head"><strong>lorebook</strong>
                    <em class="copilot-spend-note">permanently triggered keys (comma or newline separated) — always in the composer's lorebook block</em>
                </div>
                <textarea data-gr="lore-keys" rows="2" placeholder="e.g. turbine, ancient_map"></textarea>
                <div class="copilot-gr-add"><button type="button" data-act="lore-save">Save</button></div>`;
            const ta = loreEl.querySelector('[data-gr="lore-keys"]');
            if (ta) {
                ta.value = keep ?? String(settings().permanentLoreKeys ?? '');
            }
        } catch (err) {
            loreEl.textContent = `lorebook box unavailable: ${redact(String(err?.message ?? err))}`;
        }
    };
    loreEl.addEventListener('click', (ev) => {
        const btn = ev.target.closest?.('button[data-act="lore-save"]');
        if (!btn) {
            return;
        }
        const value = String(loreEl.querySelector('[data-gr="lore-keys"]')?.value ?? '');
        saveSettings({ permanentLoreKeys: value });
        const count = value.split(/[,\n]/).map((k) => k.trim()).filter(Boolean).length;
        log.info('lorebook', `permanently triggered keys saved (${count} keys)`);
    });

    // ---- The compressor (phase 6, §6): one card per visible extraction with
    // a checkbox (contiguous selections only), pin/protect toggles, and the
    // auto-compress controls. Auto-compress is DEFAULT-OFF (G2 gate).
    const compressEl = panel.querySelector('.copilot-compress');
    const renderCompress = () => {
        try {
            const s = settings();
            const entries = collectExtractions(ctx().chat ?? []);
            compressEl.innerHTML = `
                <div class="copilot-gr-head"><strong>compressor</strong>
                    <em class="copilot-spend-note">merge a contiguous range; originals are kept and hidden (I1/I2)</em>
                </div>
                <div class="copilot-gr-add">
                    <button type="button" data-act="compress-run">Compress selected</button>
                    <button type="button" data-act="compress-undo">Undo last compression</button>
                </div>
                ${entries.map((e, i) => `
                    <div class="copilot-gr-item" data-cidx="${i}" data-mi="${e.messageIndex}" data-si="${e.swipeIndex}">
                        <label><input type="checkbox" data-csel="${i}" /> #${i} (msg ${e.messageIndex})</label>
                        <span class="copilot-c-text">${escapeHtml(String(e.extraction.text ?? '').slice(0, 90))}</span>
                        <button type="button" data-act="toggle-pin">${e.extraction.pinned ? 'Unpin' : 'Pin'}</button>
                        <button type="button" data-act="toggle-protect">${e.extraction.protected ? 'Unprotect' : 'Protect'}</button>
                    </div>`).join('')}
                <div class="copilot-gr-add">
                    <label><input type="checkbox" data-cset="auto"${s.compress?.auto ? ' checked' : ''} /> auto-compress (default OFF — G2 gate)</label>
                    <input type="text" data-cset="maxVisible" value="${escapeHtml(String(s.compress?.maxVisible ?? 40))}" size="4" title="merge only when more than this many exist" />
                    <input type="text" data-cset="mergeCount" value="${escapeHtml(String(s.compress?.mergeCount ?? 10))}" size="4" title="how many oldest to merge" />
                    <button type="button" data-act="compress-settings">Save</button>
                    <button type="button" data-act="compress-auto">Run auto-compress now</button>
                </div>`;
        } catch (err) {
            compressEl.textContent = `compressor unavailable: ${redact(String(err?.message ?? err))}`;
        }
    };
    compressEl.addEventListener('click', async (ev) => {
        const btn = ev.target.closest?.('button[data-act]');
        if (!btn) {
            return;
        }
        const item = btn.closest('.copilot-gr-item');
        const act = btn.dataset.act;
        if (act === 'compress-run') {
            const indices = [...compressEl.querySelectorAll('[data-csel]')]
                .filter((c) => c.checked)
                .map((c) => Number(c.dataset.csel));
            await runManualCompression(indices);
        } else if (act === 'compress-undo') {
            undoLastCompression();
        } else if (act === 'compress-auto') {
            await runAutoCompression();
        } else if (act === 'compress-settings') {
            const val = (name) => Number(compressEl.querySelector(`[data-cset="${name}"]`)?.value) || 0;
            const auto = Boolean(compressEl.querySelector('[data-cset="auto"]')?.checked);
            saveSettings({ compress: { auto, maxVisible: val('maxVisible') || 40, mergeCount: val('mergeCount') || 10 } });
            log.info('compress', `settings saved: auto=${auto} maxVisible=${val('maxVisible')} mergeCount=${val('mergeCount')}`);
        } else if ((act === 'toggle-pin' || act === 'toggle-protect') && item) {
            toggleEntryFlag(Number(item.dataset.mi), Number(item.dataset.si), act === 'toggle-pin' ? 'pinned' : 'protected');
        }
        renderCompress();
        render();
    });

    // ---- Import / export (phase 7, §6 / S9): carry memory between chats.
    // Every import keeps a pre-import snapshot; restore is one click.
    const transferEl = panel.querySelector('.copilot-transfer');
    const renderTransfer = () => {
        try {
            // Keep whatever the user has in the box across re-renders — the
            // export flow writes into it and then re-renders.
            const keep = transferEl.querySelector('[data-gr="transfer-json"]')?.value ?? '';
            transferEl.innerHTML = `
                <div class="copilot-gr-head"><strong>import / export</strong>
                    <em class="copilot-spend-note">carry memory between chats (S9) — a snapshot is kept before every import</em>
                </div>
                <div class="copilot-gr-add">
                    <button type="button" data-act="export-state">Export chat state</button>
                    <button type="button" data-act="import-state">Import into this chat</button>
                    <button type="button" data-act="restore-import">Restore pre-import snapshot</button>
                </div>
                <textarea data-gr="transfer-json" rows="4" placeholder="exported bundle JSON appears here; paste a bundle here to import it"></textarea>`;
            const ta = transferEl.querySelector('[data-gr="transfer-json"]');
            if (ta && keep) {
                ta.value = keep;
            }
        } catch (err) {
            transferEl.textContent = `transfer unavailable: ${redact(String(err?.message ?? err))}`;
        }
    };
    transferEl.addEventListener('click', async (ev) => {
        const btn = ev.target.closest?.('button[data-act]');
        if (!btn) {
            return;
        }
        const ta = transferEl.querySelector('[data-gr="transfer-json"]');
        if (btn.dataset.act === 'export-state') {
            const bundle = exportStateToBundle();
            // The log line inside export re-renders this section (subscriber!),
            // detaching the textarea — so render FIRST, then write into the
            // FRESH node.
            renderTransfer();
            const fresh = transferEl.querySelector('[data-gr="transfer-json"]');
            if (fresh) {
                fresh.value = JSON.stringify(bundle);
            }
            render();
            return;
        }
        if (btn.dataset.act === 'import-state') {
            let state = null;
            try {
                state = JSON.parse(ta ? ta.value : '');
            } catch {
                log.warn('transfer', 'import refused: the box does not contain valid JSON');
            }
            if (state) {
                importStateFromBundle(state);
            }
        } else if (btn.dataset.act === 'restore-import') {
            restorePreImport();
        }
        renderTransfer();
        render();
    });

    // ---- The configuration surface (§6; critique F9/finding 2: every setting
    // used to be console-only while README promised fields). Every control here
    // is WIRED — no decorative inputs (trap 10).
    const settingsEl = panel.querySelector('.copilot-settings');
    const renderSettings = () => {
        try {
            const s = settings();
            // Keep unsaved typing across re-renders (log lines re-render the panel).
            const keep = {};
            for (const el of settingsEl.querySelectorAll('[data-set]')) {
                keep[el.dataset.set] = el.value;
            }
            const put = (name, v) => {
                const el = settingsEl.querySelector(`[data-set="${name}"]`);
                if (el) {
                    el.value = keep[name] ?? String(v ?? '');
                }
            };
            settingsEl.innerHTML = `
                <div class="copilot-gr-head"><strong>settings</strong>
                    <em class="copilot-spend-note">§6 configuration — chains are comma-separated; a blank key uses the ST secret</em>
                </div>
                <div class="copilot-set-grid">
                    <label>API key <input type="password" data-set="apiKey" placeholder="blank = the api_key_openrouter secret" /></label>
                    <label>baseUrl <input type="text" data-set="baseUrl" /></label>
                    <label>extractor chain <input type="text" data-set="extractorChain" /></label>
                    <label>extractor temp / tokens <input type="text" data-set="extractorTemp" size="4" /> <input type="text" data-set="extractorMaxTokens" size="6" /></label>
                    <label>composer chain <input type="text" data-set="composerChain" /></label>
                    <label>composer temp / tokens <input type="text" data-set="composerTemp" size="4" /> <input type="text" data-set="composerMaxTokens" size="6" /></label>
                    <label>note words min / max <input type="text" data-set="minWords" size="4" /> <input type="text" data-set="maxWords" size="4" /></label>
                    <label>injection position
                        <select data-set="injectPosition">
                            <option value="end">end of the prompt</option>
                            <option value="before_last">before the last message</option>
                            <option value="none">none (log only)</option>
                        </select>
                    </label>
                </div>
                <details><summary>prompt templates (namespaced {{copilot.*}} blocks)</summary>
                    <label>extractor <textarea data-set="promptExtractor" rows="5"></textarea></label>
                    <label>composer <textarea data-set="promptComposer" rows="5"></textarea></label>
                    <label>compressor <textarea data-set="promptCompressor" rows="5"></textarea></label>
                </details>
                <div class="copilot-gr-add"><button type="button" data-act="settings-save">Save settings</button></div>`;
            put('apiKey', '');
            put('baseUrl', s.baseUrl ?? '');
            put('extractorChain', (s.extractor?.chain ?? []).join(', '));
            put('extractorTemp', s.extractor?.temperature ?? 0.2);
            put('extractorMaxTokens', s.extractor?.maxTokens ?? '');
            put('composerChain', (s.composer?.chain ?? []).join(', '));
            put('composerTemp', s.composer?.temperature ?? 0.7);
            put('composerMaxTokens', s.composer?.maxTokens ?? '');
            put('minWords', s.composer?.minWords ?? 15);
            put('maxWords', s.composer?.maxWords ?? 120);
            put('injectPosition', s.injection?.position ?? 'end');
            put('promptExtractor', s.extractor?.prompt ?? '');
            put('promptComposer', s.composer?.prompt ?? '');
            put('promptCompressor', s.compressorPrompt ?? '');
        } catch (err) {
            settingsEl.textContent = `settings unavailable: ${redact(String(err?.message ?? err))}`;
        }
    };
    settingsEl.addEventListener('click', (ev) => {
        const btn = ev.target.closest?.('button[data-act="settings-save"]');
        if (!btn) {
            return;
        }
        try {
            const get = (name) => String(settingsEl.querySelector(`[data-set="${name}"]`)?.value ?? '');
            const chain = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
            const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : fallback);
            const s = settings();
            saveSettings({
                ...(get('apiKey') ? { apiKey: get('apiKey') } : {}),
                baseUrl: get('baseUrl') || DEFAULTS.baseUrl,
                extractor: {
                    ...s.extractor,
                    chain: chain(get('extractorChain')),
                    temperature: num(get('extractorTemp'), 0.2),
                    maxTokens: num(get('extractorMaxTokens'), undefined),
                    ...(get('promptExtractor') ? { prompt: get('promptExtractor') } : {}),
                },
                composer: {
                    ...s.composer,
                    chain: chain(get('composerChain')),
                    temperature: num(get('composerTemp'), 0.7),
                    maxTokens: num(get('composerMaxTokens'), undefined),
                    minWords: num(get('minWords'), 15),
                    maxWords: num(get('maxWords'), 120),
                    ...(get('promptComposer') ? { prompt: get('promptComposer') } : {}),
                },
                injection: {
                    ...s.injection,
                    position: get('injectPosition') || 'end',
                },
                ...(get('promptCompressor') ? { compressorPrompt: get('promptCompressor') } : {}),
            });
            log.info('settings', `settings saved from the panel (${chain(get('extractorChain')).length}/${chain(get('composerChain')).length} models in the chains)`);
        } catch (err) {
            log.warn('settings', `save failed: ${redact(String(err?.message ?? err))}`);
        }
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
        // Refresh the browser/goals/spend unless the user is typing in them.
        if (!recordsEl.contains(document.activeElement) && !goalsEl.contains(document.activeElement)
            && !spendEl.contains(document.activeElement) && !presetsEl.contains(document.activeElement)
            && !compressEl.contains(document.activeElement) && !transferEl.contains(document.activeElement)
            && !loreEl.contains(document.activeElement) && !settingsEl.contains(document.activeElement)) {
            renderRecords();
            renderGoals();
            renderPresets();
            renderSpend();
            renderLore();
            renderCompress();
            renderTransfer();
            renderSettings();
        }
    });
    render();
    renderRecords();
    renderGoals();
    renderPresets();
    renderSpend();
    renderLore();
    renderCompress();
    renderTransfer();
    renderSettings();
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
        spendTotals, savePreset, applyPresetById, deletePreset,
        compress: runManualCompression, undoCompression: undoLastCompression,
        autoCompress: runAutoCompression, toggleEntryFlag,
        exportState: exportStateToBundle, importState: importStateFromBundle,
        restoreImport: restorePreImport,
    };

    log.info('boot', `copilot wired up — build ${BUILD_ID}`);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}