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
import { collectExtractions, listRecords, readSwipeRecordOrNull, writeSwipeRecord, restoreChat, foldSupersededHistory } from './src/schema/store.js';
import { mergeLoreEntries, DEFAULT_EXTRACTOR_PROMPT, DEFAULT_COMPOSER_PROMPT, DEFAULT_COMPRESSOR_PROMPT } from './src/core/prompts.js';
import { applyComposerEdit, applyExtractionEdit } from './src/schema/edit.js';
import {
    noteHash, goalFacts, tickGoals, tickRequests, makeGoal, makeUserRequest,
    noteTextOf, pushSnapshot, isCompressedAway,
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
import { redact } from './src/core/redact.js';
import { normalizeKey, isPlausibleKey, resolveKey, keySource, keyProblem } from './src/core/keysource.js';
import {
    ctx, chat, eventSource, saveChatConditional, saveMetadata,
    nextToken, resetTokens, clearPending,
    setPending, getPending, bindToMessage, recordSkip, registerNote, clearNote,
    hasPendingSkip, currentTokenValue,
} from './src/st/adapter.js';

const log = new DebugLog();

// F12 (critique round 1): turn ids must be unique ACROSS chats. resetTokens()
// zeroes the generation token on every chat change, so chat B's turn "1" used
// to REUSE chat A's turn record — showing its skipReason/failure/noteFound on
// the wrong chat (I7: "what the panel shows is exactly what was sent").
let chatSeq = 0;
const turnKey = (token) => `${chatSeq}:${token}`;

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
        maxMessages: 12,
    },
    composer: {
        chain: ['qwen/qwen3.7-flash', 'sao10k/l3-lunaris-8b', 'dots-studio/dots-3-note-preview:free'],
        retries: 1,
        temperature: 0.7,
        maxChars: 8000,
        maxMessages: 20,
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
    // The compressor's own model chain (§6: the compressor is a role) — falls
    // back to the extractor's chain when empty.
    compressorChain: [],
    /** User-saved template bundles (T-R4-5: "save your current template"). */
    customTemplates: [],
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

/**
 * R2-8 / GOAL §9.2 — the key resolution chain, honestly documented:
 *   1. `settings.apiKey` — set from this panel; stored PLAINTEXT inside
 *      extension_settings (the UI says so).
 *   2. ST's server-side OpenRouter secret — read through secrets.js `findSecret`.
 *
 * T-R4-1 (BLOCKER, user report: "I always got an error 'HTTP 401'"): the old
 * code did `String(secret_state[OPENROUTER][0])` and sent THAT as the key. But
 * `secret_state[key]` is a list of secret DESCRIPTORS — `{id, value: MASKED,
 * label, active}` (src/endpoints/secrets.js getSecretState) — so the literal
 * string "[object Object]" went out as the bearer token and every turn 401'd,
 * whatever key was configured. The descriptor list only proves a secret EXISTS;
 * the VALUE comes from `findSecret`, and the server answers 403 for it unless
 * `allowKeysExposure: true` is set in config.yaml. See src/core/keysource.js.
 */
let stSecretKey = '';
/** 'unknown' | 'ok' | 'missing' | 'unreadable' — why the fallback is or is not usable. */
let stSecretStatus = 'unknown';

async function refreshSecretKey() {
    stSecretKey = '';
    stSecretStatus = 'missing';
    try {
        const sec = await import('/scripts/secrets.js');
        const name = sec.SECRET_KEYS?.OPENROUTER ?? 'api_key_openrouter';
        const entries = sec.secret_state?.[name];
        const listed = Array.isArray(entries) ? entries : (entries ? [entries] : []);
        if (listed.length === 0) {
            stSecretStatus = 'missing';
            return stSecretKey;
        }
        // The descriptors carry a MASKED value — never usable as a key. Ask the
        // server for the real one (active entry first).
        const active = listed.find((e) => e && e.active) ?? listed[0];
        const id = active && active.id ? active.id : undefined;
        const value = typeof sec.findSecret === 'function' ? await sec.findSecret(name, id) : null;
        const key = normalizeKey(value);
        if (isPlausibleKey(key)) {
            stSecretKey = key;
            stSecretStatus = 'ok';
        } else {
            // Secret present but 403/masked/null — say so; never guess.
            stSecretStatus = 'unreadable';
        }
    } catch {
        stSecretStatus = 'unreadable';
    }
    return stSecretKey;
}

function apiKey() {
    // Hand-typed keys carry stray spaces/quotes (one trailing space = endless
    // HTTP 401), and T-R4-1: nothing that cannot be a bearer token may ever
    // reach the provider.
    return resolveKey({ panelKey: settings().apiKey, secretKey: stSecretKey });
}

/** Which source supplied the key — for the pilot light and the status line. */
function apiKeySource() {
    return keySource({ panelKey: settings().apiKey, secretKey: stSecretKey });
}

/** One actionable sentence for the log and the pilot light; '' when all is well. */
function apiKeyProblem() {
    return keyProblem({ panelKey: settings().apiKey, secretKey: stSecretKey, secretStatus: stSecretStatus });
}

function saveSettings(patch) {
    const root = ctx().extensionSettings;
    if (!root) {
        return false;
    }
    root[SETTINGS_KEY] = { ...(root[SETTINGS_KEY] ?? {}), ...patch };
    // ST persists extension_settings inside its main settings payload
    // (script.js:7992 saveSettings -> :8026 extension_settings). There is no
    // ctx.saveExtensionSettings — the optional-chain call that used to live here
    // was a silent no-op and settings never reached the server. The context
    // exposes saveSettingsDebounced (st-context.js:131); ST's own extensions
    // (extensions.js:673) persist extension settings the same way.
    ctx().saveSettingsDebounced?.();
    // T-R4-2 (user report: "key really doesn't want to be kept"): the debounced
    // save is throttled (script.js:469, DEFAULT_SAVE_EDIT_TIMEOUT) — a reload
    // or tab close within that window silently LOSES the write. script.js also
    // exports the immediate `saveSettings` (script.js:7992); call it too so the
    // write hits the server now. Both paths send the same merged payload.
    import('/script.js')
        .then((m) => { try { m.saveSettings?.(); } catch { /* debounced path still runs */ } })
        .catch(() => { /* older host: the debounced call above is the fallback */ });
    return true;
}

/* ------------------------------------------------------------------- inputs */

/**
 * The character as context for the guidance writer: the name first, then the
 * card's description when one exists (capped — the composer's window is
 * budgeted and a full example dialogue must never eat it).
 */
function characterCardText() {
    try {
        const c = ctx();
        const ch = c.characters?.[c.characterId];
        const name = String(ch?.name ?? c.name2 ?? '').trim();
        const desc = String(ch?.description ?? '').trim().slice(0, 1500);
        if (!name && !desc) {
            return '';
        }
        return desc ? `${name}\n${desc}` : name;
    } catch {
        return '';
    }
}

/**
 * The narrator's standing instructions — the live system prompt. `ctx().systemPrompt`
 * (the old source) does not exist in ST's context, so the block was always
 * empty. The chat-completion system prompt is `oai_settings.main_prompt`,
 * exposed as `chatCompletionSettings` (st-context.js:226).
 */
function narratorPromptText() {
    try {
        const c = ctx();
        // T-R4-12 (user report: the block "still isn't getting any injections"):
        // on modern ST the standing instructions live in the PROMPT MANAGER's
        // collection — oai_settings.prompts, entry identifier 'main'
        // (PromptManager.getPromptById('main') reads serviceSettings.prompts).
        // `main_prompt` is a legacy field and is EMPTY there, so the old chain
        // found nothing at all.
        const prompts = c.chatCompletionSettings?.prompts;
        const fromManager = Array.isArray(prompts)
            ? prompts.find((p) => p && p.identifier === 'main' && typeof p.content === 'string' && p.content.trim())
            : null;
        for (const v of [
            fromManager?.content,
            c.chatCompletionSettings?.main_prompt,
            c.chatCompletionSettings?.system_prompt,
            c.powerUserSettings?.main_prompt,
        ]) {
            if (typeof v === 'string' && v.trim()) {
                return v.trim().slice(0, 3000);
            }
        }
    } catch {
        // Context shape drifts between ST versions — an empty block is honest.
    }
    return '';
}

/**
 * Collect the context the pipeline needs from the live chat.
 *
 * Reached through `ctx()` FRESH every time. Nothing here is cached across a
 * turn, because `chat_metadata` is reassigned by SillyTavern on load and a held
 * reference would silently diverge (trap 1).
 */
async function collectInput(turnId) {
    const list = chat();
    // T-R5-17 (user report): on a swipe/reroll the reply being REGENERATED is
    // still in the chat while the new swipe is composed — and the new swipe's
    // composer used to read the very swipe it is replacing ("a composer of
    // swipe 2 for msg4 receives msg4 swipe 1 as input"). On a swipe turn the
    // trailing ASSISTANT message is the one being replaced and is dropped from
    // every window. A user-message swipe keeps its (new) text.
    const lastMsg = list[list.length - 1];
    const dropLast = currentTurnType === 'swipe'
        && Boolean(lastMsg) && !lastMsg.is_user && !lastMsg.is_system;
    const endIdx = dropLast ? list.length - 1 : list.length;
    const messages = [];
    const window = settings().composer.maxChars;
    // User-facing knob: HOW MANY recent messages (the old chars window was
    // unintelligible). The char budget stays as a hidden safety cap.
    const maxMessages = Number(settings().composer.maxMessages ?? 20) || 20;
    // Walk backwards so a budget drops whole OLDEST messages (trap 4).
    let used = 0;
    for (let i = endIdx - 1; i >= 0; i -= 1) {
        const m = list[i];
        const text = typeof m?.mes === 'string' ? m.mes : '';
        if (text.trim() === '' || m?.is_system) {
            continue;
        }
        const cost = text.length;
        if (messages.length >= maxMessages) {
            break;
        }
        if (used + cost > window && messages.length > 0) {
            break;
        }
        messages.unshift({ role: m.is_user ? 'user' : 'assistant', text });
        used += cost;
    }

    // Extractions the composer may read: everything up to and including the
    // message we are answering, excluding the slot being written. Compressed
    // originals are excluded here and ONLY here (I2).
    //
    // T-R5-22 (user: "composer receives extractions from inactive swipes ...
    // only the active ones get sent"): only the ACTIVE swipe of each message
    // counts. The live `msg.swipe_id` IS the active marker — it moves the
    // moment the user switches swipes, so no extra storage is needed and it can
    // never go stale. An inactive swipe's extraction is kept on disk (I1) but
    // must not leak into the composer's list.
    const visible = collectExtractions(list, {
        excludeSwipeAt: { messageIndex: list.length, swipeIndex: 0 },
        currentSwipeOnly: true,
    });
    const extractions = visible.map((e) => ({ text: e.extraction.text, source: e.messageIndex + 1 }));

    // T-R4-6 (user redesign, CRITICAL): rolling-state inputs. The LATEST state
    // is the newest visible extraction; the extractor gets ONLY the messages not
    // yet folded into it — never the whole chat again ("the extractor is
    // receiving ALL messages, that makes no sense").
    // T-R5-21 (user spec): the state chain, newest last. KEY SEMANTIC: an
    // extraction produced during message N's generation covers the messages up
    // to N-1 (N's reply does not exist yet when it runs) and is then BOUND to
    // message N. So the next delta must start AT the binding — otherwise the
    // narrator's own reply at N is never extracted by anyone ("a new one
    // extracted from msg2 and 3" for the msg4 turn — not just msg3).
    const bindings = [...new Set(visible.map((e) => e.messageIndex))].sort((a, b) => a - b);
    const latestBinding = bindings.length ? bindings[bindings.length - 1] : -1;
    const beforeLatest = bindings.length > 1 ? bindings[bindings.length - 2] : -1;
    const latestEntry = visible
        .filter((e) => e.messageIndex === latestBinding && String(e.extraction.text ?? '').trim())
        .at(-1);
    const previousState = latestEntry ? String(latestEntry.extraction.text) : '';
    const previousStateSource = latestBinding;
    const spanFrom = (from) => {
        const out = [];
        for (let i = Math.max(0, from); i < endIdx; i += 1) {
            const m = list[i];
            const text = typeof m?.mes === 'string' ? m.mes : '';
            if (text.trim() === '' || m?.is_system) {
                continue;
            }
            out.push({ role: m.is_user ? 'user' : 'assistant', text });
        }
        return out;
    };
    let extractMessages;
    if (latestBinding >= 0) {
        extractMessages = spanFrom(latestBinding);
        if (extractMessages.length === 0) {
            // Everything up to endIdx is already covered (a reroll of the reply
            // the chain already spans). The fresh extraction should cover the
            // SAME span as the turn it replaces — from the previous binding —
            // so the chain stays whole: "extracted from msg2 and 3".
            extractMessages = spanFrom(beforeLatest >= 0 ? beforeLatest : Math.max(0, latestBinding - 1));
        }
    } else {
        extractMessages = messages;
    }

    const meta = ctx().chatMetadata?.copilot ?? {};
    return {
        messages,
        extractions,
        extractMessages,
        previousState,
        previousStateSource,
        lorebook: readLorebook(await readPermanentLorebook()),
        // T-R4-4: the block headed "About the character you are writing for"
        // used to carry NOTHING but the name (confusing: it read as broken), and
        // "The narrator's standing instructions" was ALWAYS empty because
        // `ctx().systemPrompt` does not exist in ST's context. Both are real
        // content now.
        characterCard: characterCardText(),
        narratorPrompt: narratorPromptText(),
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

// noteTextOf now comes from src/schema/records.js (R2-27: it was duplicated).
/** The ACTIVE-swipe record of the latest message that has one (note or extraction). */
function previousRecordFor(list) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
        const m = list[i];
        if (m?.is_user) {
            continue;
        }
        const info = m?.swipe_info?.[m.swipe_id ?? 0];
        const rec = info?.extra?.copilot?.record;
        if (rec && (noteTextOf(rec) || rec.extraction)) {
            return rec;
        }
    }
    return null;
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
 * T-R5-18: a template SAVED in the settings pins whatever shipped text existed
 * when it was saved — later fixes never reach it (the user's compressor ran the
 * old "Prose, no lists, no headers" merger and returned prose). Recognise the
 * OLD shipped signatures and say so, once per kind per session.
 */
const warnedTemplates = new Set();
function warnLegacyTemplate(kind, text) {
    if (warnedTemplates.has(kind)) {
        return;
    }
    const t = String(text ?? '');
    const legacy = (kind === 'extractor' && t.includes('<ledger>'))
        || (kind === 'composer' && t.includes('Facts recorded so far:'))
        || (kind === 'compressor' && t.includes('Prose, no lists, no headers'));
    if (!legacy) {
        return;
    }
    warnedTemplates.add(kind);
    log.warn('settings', `the ${kind} template in your settings is an OLDER shipped version — later fixes do not reach it. Press 'Restore shipped prompts' (then Save settings) to get the current format, or keep it deliberately.`);
}

/**
 * The model call for compression: the EXTRACTOR's chain with the dedicated
 * compress prompt (§6), judged by I4's own gate (not the composer's prose
 * bounds — same rule as the extractor).
 */
function compressorCall(messages) {
    const s = settings();
    warnLegacyTemplate('compressor', s.compressorPrompt ?? DEFAULT_COMPRESSOR_PROMPT);
    return callWithFallback({
        // The compressor has its own chain (the user asked for a model
        // selector); it falls back to the extractor's chain.
        models: s.compressorChain?.length ? s.compressorChain : (s.extractor?.chain ?? []),
        retries: s.extractor?.retries ?? 1,
        key: apiKey(),
        baseUrl: s.baseUrl,
        messages,
        temperature: s.extractor?.temperature ?? 0.2,
        maxTokens: s.extractor?.maxTokens,
        role: 'compressor',
        reasoning: s.extractor?.reasoning,
        retryHint: 'Merge by union in the exact <compressed> structure from the prompt — keep every fact.',
        minWords: 1,
        maxWords: 20000,
        onEvent: (e) => {
            if (e.kind === 'attempt') {
                log[e.ok ? 'info' : 'warn']('compress', `${e.model} [${e.title ?? 'copilot'}]: ${e.ok ? 'ok' : `rejected (${e.reason}) — ${e.detail}`}`);
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
async function runManualCompression(extIds) {
    // T-R2-5 (I2): overlapping compressions double-merge the same originals —
    // `compressedInto` goes last-wins while BOTH merged records claim the same
    // sources, and undo of one re-exposes facts still merged into the other.
    // One at a time; overlaps are refused with a line.
    if (compressionBusy) {
        log.warn('compress', 'a compression is already running — refusing to overlap (double-merge would corrupt undo)');
        return { ok: false, reason: 'a compression is already running' };
    }
    compressionBusy = true;
    const seqAtStart = chatSeq; // T-R2-23: refuse to commit across a chat switch
    try {
        const list = chat();
        const entries = collectExtractions(list);
        // T-R2-10 (F18): selections are resolved by EXTRACTION ID against the
        // fresh list — render-time indices silently selected different entries
        // after any intervening turn or auto-merge.
        const indices = [];
        for (const id of (Array.isArray(extIds) ? extIds : [])) {
            const i = entries.findIndex((e) => e.extraction.id === id);
            if (i >= 0 && !indices.includes(i)) {
                indices.push(i);
            }
        }
        indices.sort((a, b) => a - b);
        const sel = validateSelection(indices);
        if (!sel.ok) {
            log.warn('compress', `refused: ${sel.reason}`);
            return { ok: false, reason: sel.reason };
        }
        const res = await compressEntries(list, entries, indices, {
            callModel: compressorCall, now: Date.now(), prompt: settings().compressorPrompt,
            shouldAbort: () => chatSeq !== seqAtStart,
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
    } finally {
        compressionBusy = false;
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
    // R3-F3: autoSelect returns INDICES; runManualCompression resolves IDS.
    // Feeding indices to the id resolver made auto-compress dead — it refused
    // every run ("select at least two entries") while the log claimed merges.
    const ids = indices.map((i) => entries[i]?.extraction?.id).filter(Boolean);
    const res = await runManualCompression(ids);
    log.info('compress', `auto: ${res.ok ? `merged ${res.merged}` : `skipped — ${res.reason}`}`);
    return res;
}

/** Pin (unmashable) or protect (auto-merge excludes it) one extraction BY ID. */
function toggleEntryFlag(extId, field) {
    try {
        // T-R2-10: rows include MERGED entries (record.extractions[]) — the old
        // row-index lookup flipped the record's own extraction instead. Resolve
        // by id across every record.
        for (const entry of listRecords(chat())) {
            const rec = entry.record;
            const candidates = [
                ...(rec.extraction ? [rec.extraction] : []),
                ...(Array.isArray(rec.extractions) ? rec.extractions.filter(Boolean) : []),
            ];
            for (const ex of candidates) {
                if (ex.id === extId) {
                    ex[field] = !ex[field];
                    writeSwipeRecord(chat()[entry.messageIndex], entry.swipeIndex, {});
                    log.info('compress', `extraction ${extId}: ${field} = ${ex[field]}`);
                    return { ok: true, reason: null, value: ex[field] };
                }
            }
        }
        return { ok: false, reason: `no extraction with id ${extId}` };
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
    // M2 (round 3): 'none' means log-only on EVERY shape — the array path
    // ignored it and shipped the note on chat-completion sources while the
    // record claimed log-only.
    if (opts.position === 'none') {
        return 0;
    }
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
/** R2-1: what kind of generation is in flight — only 'real' may compose/inject. */
let generationKind = 'none';
/** T-R5-17: the ST generation type of the current turn ('normal', 'swipe', …). */
let currentTurnType = 'normal';
/** T-R2-4: exactly what was delivered this turn — the watcher verifies THIS. */
let deliveredNote = null;
/** T-R2-5: one compression at a time. */
let compressionBusy = false;
/** T-R2-2: the record ST deletes on regenerate, folded back into history. */
let supersededRecord = null;

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
    // F9 (round 3): remember which popups predate this wait — a modal appended
    // DURING it (another extension's confirm) used to be the one dismissed.
    const preexisting = new Set([...document.querySelectorAll('.popup')]);
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
            log.warn('popup', `${label} unanswered for ${ms}ms — using the benign default '${fallback}' (trap 7)`);
            // T-R2-13: the timed-out modal must stop blocking the UI. Dismiss
            // OURS — the first popup opened during this wait — using the real
            // ST button classes (.popup-button-cancel / .popup-button-close;
            // the old selectors matched nothing in ST's DOM).
            try {
                const opened = [...document.querySelectorAll('.popup')]
                    .filter((p) => p.getClientRects().length > 0 && !preexisting.has(p));
                const mine = opened[0];
                (mine?.querySelector('.popup-button-cancel')
                    || mine?.querySelector('.popup-button-close')
                    || mine?.querySelector('.popup-button-ok'))?.click();
            } catch { /* best effort */ }
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
            log.warn('reroll', 'no Popup in the ST context — defaulting to the benign answer (reuse)');
            return 'reuse';
        }
        // Benign default on timeout = 'reuse' (no model call — decision record 4).
        return await popupWithTimeout(
            PopupCls.show.confirm(
                'The composer\'s note for this swipe',
                'Compose a NEW composer note for this generation, or REUSE the current one?',
                { okButton: 'Compose a new note', cancelButton: 'Reuse the current note' },
            ).then((result) => (result === 1 ? 'new' : 'reuse')),
            45000, 'reuse', 'reroll popup',
        );
    } catch (err) {
        // T-R2-13: the benign default is 'reuse' (decision record 4) — the error
        // path used to default to 'new', the ONE answer that spends money.
        log.warn('reroll', `popup failed — defaulting to the benign answer (reuse): ${redact(String(err?.message ?? err))}`);
        return 'reuse';
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
            log.warn('reroll', 'no popup API in the ST context — keeping the fresh composition (what was asked for)');
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
        // T-R5-19 (user: "The extractor should run every swipe that asks for a
        // new composer … it's currently re using the same extraction"): this
        // popup only ever appears AFTER the user explicitly asked for a fresh
        // composition — and the fresh extraction+note are already computed and
        // paid for. The timeout default must therefore honour that request:
        // 'new'. The old T-R2-13 default ('old', "the money answer") silently
        // discarded the paid-for result and re-injected the previous swipe's
        // note — the exact wrong answer to what was asked. 5 minutes because
        // this is a READING popup (four diff blocks); trap 7 is preserved (it
        // still auto-resolves and can never hang the generation).
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
            300000, 'new', 'diff popup',
        );
    } catch (err) {
        log.warn('reroll', `diff popup failed — keeping the fresh composition (what was asked for): ${redact(String(err?.message ?? err))}`);
        return 'new';
    }
}

async function onGenerationStarted(type, opts = {}, dryRun = false) {
    // R2-1 (BLOCKER): record the KIND of this generation first — the prompt
    // hooks fire for quiet prompts (script.js:5183) and raw calls (script.js:
    // 3970, no GENERATION_STARTED at all) with dryRun:false, and only REAL
    // narrator turns may compose or inject (GOAL §0.2 rule 5).
    generationKind = dryRun ? 'dry'
        : (type === GENERATION_TYPE.QUIET || opts?.quiet_prompt) ? 'quiet'
            : (type === GENERATION_TYPE.IMPERSONATE) ? 'impersonate'
                : 'real';
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
    lastToken = nextToken(); // kept in sync by construction (R2-20: one counter)
    currentTurnType = String(type ?? 'normal');
    lorebookEntries = new Map();
    clearNote();
    const droppedPending = clearPending(SKIP.STALE_GENERATION);
    if (droppedPending) {
        // Trap 14 + I1 (F13, critique round 1): dropping a composed note and its
        // extraction with NO log line is undiagnosable. Say it happened.
        log.warn('inject', `dropped a pending note/extraction (${droppedPending}) — the previous generation never landed a reply`);
    }
    rerollChoice = null;
    // T-R2-2 (BLOCKER, I1): on a regenerate ST DELETES the old reply
    // (script.js:4344-4353 — chat.length-- + MESSAGE_DELETED) and the record
    // lives INSIDE that message: extraction, note and injection all vanish with
    // the object. GENERATION_STARTED fires BEFORE the deletion, so stash the
    // record here and fold it into the new message's history when it lands.
    supersededRecord = null;
    // R3-F5: if the message carrying the last bound record has been DELETED
    // (group regenerate, tool calls — both delete BEFORE this event and never
    // fire type 'regenerate'), recover the record from the mirror so it folds
    // into the next reply's history instead of dying (I1).
    try {
        const metaRoot = ctx().chatMetadata;
        const mirror = metaRoot?.copilot?.lastBoundRecord;
        if (mirror && mirror.record && mirror.messageIndex >= (chat()?.length ?? 0)) {
            supersededRecord = { at: Date.now(), epoch: chatSeq, token: currentTokenValue(), ...mirror.record };
            const root = metaRoot.copilot ?? (metaRoot.copilot = {});
            root.pendingSupersede = supersededRecord;
            delete root.lastBoundRecord;
            saveMetadata();
            log.info('store', 'a deleted message carried the last bound record — recovered into the supersede stash (I1)');
        }
    } catch (err) {
        log.warn('store', `mirror recovery failed: ${redact(String(err?.message ?? err))}`);
    }
    if (type === 'regenerate') {
        try {
            const list = chat();
            const msg = list[list.length - 1];
            const rec = (msg && !msg.is_user) ? readSwipeRecordOrNull(msg, Number.isInteger(msg.swipe_id) ? msg.swipe_id : 0) : null;
            if (rec && (rec.extraction || rec.composer)) {
                supersededRecord = {
                    at: Date.now(),
                    epoch: chatSeq,
                    token: currentTokenValue(),
                    extraction: rec.extraction ? JSON.parse(JSON.stringify(rec.extraction)) : undefined,
                    composer: rec.composer ? JSON.parse(JSON.stringify(rec.composer)) : undefined,
                    injection: rec.injection ? JSON.parse(JSON.stringify(rec.injection)) : undefined,
                    // R3-F4: WITHOUT the history, a second regenerate folded a
                    // history-less stash over the first — losing the original.
                    history: Array.isArray(rec.history) ? JSON.parse(JSON.stringify(rec.history)) : [],
                };
                // Persisted so a reload mid-regenerate still folds it back (and
                // so 'reuse' can find the right note afterwards).
                const metaRoot = ctx().chatMetadata;
                if (metaRoot) {
                    const root = metaRoot.copilot ?? (metaRoot.copilot = {});
                    root.pendingSupersede = supersededRecord;
                    saveMetadata();
                }
                log.info('store', `regenerate: stashed the outgoing record (${rec.extraction ? 'extraction' : ''}${rec.composer ? '+note' : ''}) — it survives the deleted message`);
            }
        } catch (err) {
            log.warn('store', `could not stash the superseded record: ${redact(String(err?.message ?? err))}`);
        }
    }
    const s = settings();
    if (!s.enabled) {
        log.info('generation', `copilot is disabled — ${SKIP.DISABLED}`);
        return;
    }
    if (!apiKey()) {
        // m8 (R3-FINDINGS): the secret refresh kicked at GENERATION_STARTED is
        // fire-and-forget, so the FIRST turn after a reload could see a stale
        // empty key. Wait for it only in that case — everything time-critical
        // (the token bump, the kind latch) is already done synchronously above.
        if (stSecretStatus === 'unknown') {
            await refreshSecretKey();
        }
        if (!apiKey()) {
            log.warn('generation', `no usable API key — ${SKIP.NO_KEY} — ${apiKeyProblem()}`);
            return;
        }
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
    // R2-20 (trap 15 class): ONE source of truth — the adapter's counter. There
    // used to be a second copy here that was NOT reset on chat change, so the
    // watcher keyed turns with a stale token.
    return currentTokenValue();
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

/**
 * R2-6 (I7): the audit trail for a turn, persisted on the record so it survives
 * reloads (the DebugLog is RAM-only). Bounded with explicit markers — a cap
 * with a marker is honest; a silent slice is a lie.
 */
const TRACE_CAP = 4000;
function traceBounded(v) {
    // F12: traces are PERSISTED to disk (and copied into exports) — redact
    // before bounding. A chat-pasted key must never survive in a trace.
    const s = redact(String(v ?? ''));
    return s.length > TRACE_CAP ? `${s.slice(0, TRACE_CAP)}… [+${s.length - TRACE_CAP} chars]` : s;
}
function buildTrace(inputs, extraction, composer) {
    return {
        at: Date.now(),
        extractorIn: traceBounded(inputs?.extractor),
        composerIn: traceBounded(inputs?.composer),
        extractorOut: traceBounded(extraction?.text),
        composerOut: traceBounded(composer?.text),
    };
}

async function onPromptReady(eventData, kind) {
    const payload = eventData ?? {};
    if (payload.dryRun) {
        log.info('inject', 'dry run prompt — nothing injected');
        return;
    }
    // R2-1 (BLOCKER, GOAL §0.2 rule 5): ST fires these hooks with dryRun:false
    // for QUIET prompts (script.js:5183-5185) and for generateRawData calls
    // (script.js:3970-3980, which emit NO GENERATION_STARTED at all). Only a
    // REAL narrator turn may compose a note or touch the prompt — quiet
    // summaries and raw extension calls must pass through untouched.
    if (generationKind !== 'real') {
        log.info('inject', `not a narrator turn (${generationKind}) — nothing composed or injected (rule 5)`);
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
    const turn = log.turn(turnKey(token));
    // T-R5-13 (user: the narrator "breaks" after two messages): the panel
    // documents maxWaitMs as the budget for "the whole extractor+composer
    // step", but each runPipeline got the FULL budget on its own — a 60s budget
    // could hold the narrator's request for 2 minutes. ONE deadline for the
    // whole step; every stage gets only what is LEFT of it.
    const turnDeadline = Date.now() + (Number(s.maxWaitMs) > 0 ? Number(s.maxWaitMs) : 60000);
    const budgetLeft = () => Math.max(1000, turnDeadline - Date.now());
    warnLegacyTemplate('extractor', s.extractor?.prompt ?? DEFAULT_EXTRACTOR_PROMPT);
    warnLegacyTemplate('composer', s.composer?.prompt ?? DEFAULT_COMPOSER_PROMPT);

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
    let turnTrace = null; // R2-6 (I7): persisted on the record at bind time

    // Phase 3: the popup's "reuse the current one" — no model call, the note
    // goes in again, and the record SAYS it was reused instead of pretending a
    // fresh composition happened.
    //
    // F6 (critique round 1): `lastNote` is in-memory — after a reload or chat
    // switch it is null and 'reuse' silently composed a NEW note instead. Fall
    // back to the STORED note so the user's choice survives — and prefer the
    // SUPERSEDED record (T-R2-2): on a regenerate the note being reused is the
    // deleted reply's, not the previous message's (trap 6 class).
    const stash = supersededRecord ?? ctx().chatMetadata?.copilot?.pendingSupersede ?? null;
    const storedNote = lastNote ?? stash?.composer?.text ?? previousNoteFor(chat());
    const wantsReuse = Boolean(rerollChoice && rerollChoice.token === token
        && rerollChoice.choice === 'reuse' && storedNote);
    let input = await collectInput(token);
    if (wantsReuse) {
        note = storedNote;
        turn.reroll = 'reused the previous note (user choice)';
        // T-R5-15 (user: "Extractor was called even though i asked to reuse the
        // last output"): reuse means reuse EVERYTHING — no model calls at all.
        // The old M4 behaviour re-ran the extractor on every swipe, which cost
        // money and rate budget for a near-identical extraction and is exactly
        // what the user did not ask for. Deviation from GOAL §4's "a swipe means
        // a new extractor run" is deliberate and recorded in PROGRESS.md.
        // T-R5-22 (user: a 'reuse' reroll left the new swipe's record with a
        // NULL extractor): the reused extraction comes from the SAME record the
        // reused note comes from. The stash only exists when ST DELETED the
        // previous message (a regenerate); a swipe ADD leaves the old record in
        // place and the copy must come from there — "msg4 swipe 2 is empty but
        // as it reuses the same composer & extraction from msg4 swipe 1 it
        // should receive that".
        const prevRecord = stash ?? previousRecordFor(chat());
        const prevExtraction = prevRecord?.extraction ?? null;
        extractionRecord = prevExtraction
            ? { ...JSON.parse(JSON.stringify(prevExtraction)), model: '(reused from the previous turn)', reused: true }
            : null;
        turn.extraction = extractionRecord;
        composerRecord = {
            text: note, model: '(reused from the previous turn)',
            tokensIn: 0, tokensOut: 0, createdAt: Date.now(), staleFlag: false, edited: false,
        };
        turn.composer = composerRecord;
        turnTrace = buildTrace(null, null, composerRecord);
        log.info('reroll', `reusing the note AND the extraction for token ${token} — no model calls at all (user choice)`);
    } else {
        const isRerollTurn = Boolean(rerollChoice && rerollChoice.token === token);
        const oldNote = storedNote ?? '';
        const oldExtraction = (input.extractions ?? []).at(-1)?.text ?? '';
        let rerolls = 0;
        for (;;) {
            const composed = await runPipeline(input, {
                key: apiKey(),
                deadlineMs: budgetLeft(),
                onEvent: (e) => {
                    if (e.kind === 'attempt') {
                        // A rejected attempt is a FAILURE and must be visible as one
                        // (phase 2: "failures are shown"), not a quiet info line.
                        log[e.ok ? 'info' : 'warn']('provider', `${e.model} [${e.title ?? 'copilot'}]: ${e.ok ? 'ok' : `rejected (${e.reason}) — ${e.detail}`}`);
                        if (!e.ok && /HTTP 40[13]/i.test(String(e.detail ?? ''))) {
                            log.error('provider', 'AUTHENTICATION REJECTED (401/403) — the provider refused the API key. Fixes, in order: (1) open the Copilot settings and paste the key into the API key field — a stray space or quote breaks it (it is trimmed automatically now) — then press Save settings; (2) if the field is blank and the key lives in ST\'s OpenRouter secret instead, this server must have allowKeysExposure: true in config.yaml, otherwise extensions cannot read that secret at all. Send one more message after fixing.');
                        }
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
                text: typeof a.text === 'string'
                    // R2-6 (I7): never truncate SILENTLY — the marker says what was cut.
                    ? (a.text.length > 2000 ? `${a.text.slice(0, 2000)}… [+${a.text.length - 2000} chars]` : a.text)
                    : '',
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
            turnTrace = buildTrace(composed.inputs, composed.extraction, composed.composer);

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
                // T-R5-19: 'Use the OLD note' is a choice about the NOTE. The
                // FRESH extraction stands — it matches the current message,
                // which is exactly why the extractor re-runs on every new
                // composition (user requirement) — and the kept note is flagged
                // stale because it was written against the older extraction.
                note = oldNote;
                composerRecord = {
                    text: note, model: '(reused — diff popup: use old)',
                    tokensIn: 0, tokensOut: 0, createdAt: Date.now(),
                    staleFlag: true, staleReason: 'kept the old note against a fresh extraction',
                };
                turn.composer = composerRecord;
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
    // R2-9 / T-R2-3: `injected` must reflect the ACTUAL splice, and delivery on
    // chat-completion sources happens through the REGISTRY (registerNote) — the
    // string hook fires first with an empty prompt buffer that openai.js never
    // sends (verified in tests/runs/S1-*: "string at end" → duplicate hook
    // ignored → FOUND). 'none' means log-only: compose, store, deliver nothing.
    const actuallyInjected = opts.position !== 'none';
    if (shape === 'array') {
        const count = injectIntoArray(payload.chat, note, opts);
        turn.injection = `array +${count} at ${opts.position}`;
    } else {
        payload.prompt = injectIntoString(payload.prompt, note, opts);
        turn.injection = actuallyInjected ? `string at ${opts.position}` : 'log only (position: none)';
    }
    turn.incomingPromptSeen = true;
    injectedTokens.add(token);

    // One writer for "what was sent" (T-R2-4): the watcher verifies THIS note,
    // not a stale module variable — 'use old' and reuse-after-reload used to
    // verify the wrong text and report "NOT FOUND" for a note that shipped.
    deliveredNote = note;
    // R3-F11 (trap 12): lastNote must track what was DELIVERED — after diff
    // popup 'use old' it kept the REJECTED note and the next "reuse" served it.
    lastNote = note;

    // Keep the note for the registry route and for binding after the reply lands.
    setPending(note, {
        noteHash: noteHash(note),
        position: opts.position,
        injected: actuallyInjected,
        extraction: extractionRecord,
        composer: composerRecord,
        goalIds: activeGoalIds,
        requestIds: activeRequestIds,
        trace: turnTrace,
        model: composerRecord?.model,
        tokensIn: composerRecord?.tokensIn,
        tokensOut: composerRecord?.tokensOut,
        createdAt: composerRecord?.createdAt,
    });

    // Also register it, so a pre-assembly path and SillyTavern's own machinery
    // stay consistent if this turn is ever re-assembled. Gated on actuallyInjected
    // AND on `note` (NOT `lastNote` — T-R2-4: after a reload lastNote is null and
    // the reused note was never delivered at all while claiming injected:true).
    if (actuallyInjected && note) {
        // T-R2-3: the REGISTRY is what actually delivers on chat-completion
        // sources (the string hook's buffer is never sent) — map the configured
        // position onto it instead of hardcoding in_chat at depth 0.
        const registryPos = opts.position === 'first' ? 'in_prompt' : 'in_chat';
        const registryDepth = opts.position === 'before_last'
            ? 1
            : (Number.isFinite(Number(opts.depth)) ? Number(opts.depth) : 0);
        registerNote(note, { position: registryPos, depth: registryDepth, role: roleCode(opts.role) });
    }

    log.info('inject', actuallyInjected
        ? `note injected (${turn.injection}), ${note.length} chars, token ${token}`
        : `note composed and stored but NOT injected — position 'none' is log-only (token ${token})`);
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
function editRecordField(messageIndex, swipeIndex, field, text, entryId) {
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
            : applyExtractionEdit(record, text, entryId !== undefined ? { entryId } : {});
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

/**
 * T-R5-23: a plain-text dump of every record in the chat, in the user's own
 * report format — one block per message (separated by `#---`), one per swipe
 * when a message has several, extractor and composer outputs indented under
 * their labels:
 *
 *   msg4
 *     swipe 0
 *       extractor
 *         …
 *       composer
 *         …
 */
function recordsDump() {
    const entries = listRecords(chat());
    const byMsg = new Map();
    for (const e of entries) {
        if (!byMsg.has(e.messageIndex)) {
            byMsg.set(e.messageIndex, []);
        }
        byMsg.get(e.messageIndex).push(e);
    }
    const indent = (text, tabs) => String(text ?? 'null')
        .split('\n')
        .map((l) => `${'\t'.repeat(tabs)}${l}`)
        .join('\n');
    const blocks = [];
    for (const [mi, recs] of [...byMsg.entries()].sort((a, b) => a[0] - b[0])) {
        const multi = recs.length > 1;
        const labelTabs = multi ? 2 : 1;
        const out = [`msg${mi}`];
        for (const e of recs) {
            if (multi) {
                out.push(`\tswipe ${e.swipeIndex}`);
            }
            const ex = e.record.extraction?.text
                ?? (Array.isArray(e.record.extractions) ? e.record.extractions.map((x) => x?.text).filter(Boolean).join('\n\n') : '');
            out.push(`${'\t'.repeat(labelTabs)}extractor`);
            out.push(indent(ex || 'null', labelTabs + 1));
            out.push(`${'\t'.repeat(labelTabs)}composer`);
            out.push(indent(e.record.composer?.text || 'null', labelTabs + 1));
        }
        blocks.push(out.join('\n'));
    }
    return blocks.join('\n#---\n');
}

/**
 * T-R4-9: open one FULL extraction in a popup — readable and editable. The
 * compressor list truncates to 90 chars and the old tag wrappers made entries
 * unreadable ("it doesn't let me read the extraction"). OK saves through the
 * normal edit path (I1 history + stale flag on the note); Cancel/ESC discards.
 */
async function viewExtraction(extId) {
    try {
        const list = chat();
        let found = null;
        let target = null;
        for (const e of listRecords(list)) {
            const all = [
                ...(e.record.extraction ? [e.record.extraction] : []),
                ...(Array.isArray(e.record.extractions) ? e.record.extractions.filter(Boolean) : []),
            ];
            const hit = all.find((x) => x && x.id === extId);
            if (hit) {
                found = e;
                target = hit;
                break;
            }
        }
        if (!found || !target) {
            log.warn('compress', 'that extraction no longer exists');
            return;
        }
        const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
        const wrap = document.createElement('div');
        const ta = document.createElement('textarea');
        ta.value = String(target.text ?? '');
        ta.rows = 22;
        ta.style.width = '100%';
        ta.style.boxSizing = 'border-box';
        wrap.append(ta);
        const popup = new Popup(wrap, POPUP_TYPE.TEXT, `extraction ${target.id} — message ${found.messageIndex}.${found.swipeIndex}`, {
            okButton: 'Save', cancelButton: 'Close', wide: true, large: true, allowVerticalScrolling: true,
        });
        const result = await popupWithTimeout(popup.show(), 600000, 0, 'extraction popup');
        if (result !== 1) {
            log.info('compress', 'extraction popup closed — nothing changed');
            return;
        }
        const res = editRecordField(found.messageIndex, found.swipeIndex, 'extraction', ta.value, target.id);
        if (res.ok) {
            log.info('compress', `extraction ${target.id} saved from the popup — the note is flagged stale`);
        } else {
            log.warn('compress', `extraction edit refused: ${res.reason}`);
        }
    } catch (err) {
        log.warn('compress', `extraction popup failed: ${redact(String(err?.message ?? err))}`);
    }
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
        // R3-F6: the turn is over even when nothing was pending (disabled /
        // no-key turns) — the latch must not stick at 'real' or a later raw
        // call passes the rule-5 gate.
        generationKind = 'none';
        return;
    }
    let result;
    try {
        result = bindToMessage(token);
    } catch (err) {
        log.error('store', `bind threw: ${redact(String(err?.message ?? err))}`);
        injectedTokens.delete(token);
        generationKind = 'none'; // R3-F6
        return;
    }
    const turn = log.turn(turnKey(token));
    if (result.bound) {
        const what = result.skipped ? 'skip record' : 'note';
        turn.injection = `${turn.injection ?? what} -> bound to message ${result.messageIndex} swipe ${result.swipeIndex}`;
        log.info('store', `${what} bound to message ${result.messageIndex} swipe ${result.swipeIndex}`);
        // T-R2-2 (I1): fold the record ST deleted on regenerate into the new
        // message's history — rerolls must never destroy original data.
        // R3-F10: a stash belongs to ONE turn and ONE chat — a regenerate whose
        // reply never landed must not fold into some later reply, and chat A's
        // stash must never fold into chat B (traps 6/7).
        const stashNow = supersededRecord ?? ctx().chatMetadata?.copilot?.pendingSupersede ?? null;
        const stashFresh = Boolean(stashNow)
            && stashNow.epoch === chatSeq
            && (!stashNow.token || stashNow.token === token);
        if (stashFresh) {
            try {
                const target = readSwipeRecordOrNull(chat()[result.messageIndex], result.swipeIndex);
                if (target) {
                    // R3-F4: the pure fold flattens the stash's own history (a
                    // second regenerate) so no original is ever replaced.
                    foldSupersededHistory(target, stashNow);
                    writeSwipeRecord(chat()[result.messageIndex], result.swipeIndex, {});
                    log.info('store', 'regenerate: the superseded record folded into history (I1 — nothing destroyed)');
                }
            } catch (err) {
                log.warn('store', `could not fold the superseded record: ${redact(String(err?.message ?? err))}`);
            }
            supersededRecord = null;
            const metaRoot = ctx().chatMetadata;
            if (metaRoot?.copilot) {
                delete metaRoot.copilot.pendingSupersede;
                saveMetadata();
            }
        } else if (stashNow) {
            // R3-F10: a stale stash (wrong token or chat) is DISCARDED with a
            // line — folding it would put one turn's record into another's.
            log.warn('store', 'a stale supersede stash was discarded (wrong turn or chat) — nothing folded');
            supersededRecord = null;
        }
        saveChatConditional?.();
    } else {
        log.warn('store', `note could not be bound: ${result.reason}`);
    }
    // R3-F5: keep a recovery mirror of the record this turn bound. Group flows
    // and tool-call deletes REMOVE the message before the next
    // GENERATION_STARTED (which then fires with type 'normal'), so the
    // regenerate-only stash never sees them — the mirror does.
    try {
        const metaRoot = ctx().chatMetadata;
        if (metaRoot && result.bound) {
            const root = metaRoot.copilot ?? (metaRoot.copilot = {});
            const recNow = readSwipeRecordOrNull(chat()[result.messageIndex], result.swipeIndex);
            root.lastBoundRecord = {
                messageIndex: result.messageIndex,
                swipeIndex: result.swipeIndex,
                record: recNow ? JSON.parse(JSON.stringify(recNow)) : null,
            };
            saveMetadata();
        }
    } catch (err) {
        log.warn('store', `could not keep the last-bound mirror: ${redact(String(err?.message ?? err))}`);
    }
    injectedTokens.delete(token);
    generationKind = 'none'; // R2-1: the turn is over — raw/quiet calls after it decline
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
        const entries = collectExtractions(chat());
        const threshold = s.compress?.maxVisible ?? 40;
        // R2-31: decide with autoSelect's notion of MERGEABLE (usable run), not
        // a raw visible count — the mismatch spammed "nothing to merge" every
        // turn once entries were protected/pinned.
        const would = autoSelect(entries, { maxVisible: threshold, mergeCount: s.compress?.mergeCount ?? 10 });
        if (would.length < 2) {
            return;
        }
        log.info('compress', `auto: ${entries.length} visible — merging the ${would.length} oldest usable`);
        runAutoCompression().catch((err) => {
            log.warn('compress', `auto-compress failed: ${redact(String(err?.message ?? err))}`);
        });
    } catch (err) {
        log.warn('compress', `auto-compress check failed: ${redact(String(err?.message ?? err))}`);
    }
}

let lastChatIdSeen = null;

function onChatChanged(chatId) {
    // T-R4-11 (user report: "── turn 1 ── now it stays capped at 1 and doesn't
    // increment"): ST's CHAT_CHANGED also fires when the SAME chat is RELOADED
    // (reloadCurrentChatUnsafe after saves, getChatResult, etc.), and every fire
    // cleared the debug log and bumped the chat epoch — so the turn counter
    // restarted on essentially every turn. Only a REAL chat switch resets this
    // state; same-chat reloads are ignored.
    const switched = chatId === undefined ? true : chatId !== lastChatIdSeen;
    if (chatId !== undefined) {
        lastChatIdSeen = chatId;
    }
    if (!switched) {
        return;
    }
    // Trap 7: everything in flight is abandoned on a chat change.
    chatSeq += 1; // F12: turn ids never collide across chats
    generationKind = 'none'; // R2-1
    rerollChoice = null; // R2-18: a cross-chat 'reuse' must never fire silently
    supersededRecord = null; // R3-F10: one chat's stash must never fold into another's
    const droppedOnSwitch = clearPending(SKIP.CHAT_CHANGED);
    resetTokens();
    injectedTokens.clear();
    lorebookEntries = new Map();
    lastNote = null;
    clearNote();
    // T-R4-5: the debug log is per-chat state (records are what persists with
    // the chat). Clearing it here is what makes "turn 1, 2, 3…" restart on a
    // new chat instead of climbing forever.
    log.clear();
    log.info('chat', `chat changed — pending state cleared, log reset${droppedOnSwitch ? ` (dropped a pending ${droppedOnSwitch})` : ''}`);
    // F11 / R2-21: migrateChat was DEAD WIRING — records written by other
    // schema versions were never migrated on load. Run it here, guarded: a
    // dry run first (it changes nothing), then the real pass only if needed.
    setTimeout(() => {
        (async () => {
            try {
                const list = chat();
                if (!Array.isArray(list) || list.length === 0) {
                    return;
                }
                const mig = await import('./src/schema/migrate.js');
                if (!mig.needsMigration(list)) {
                    return;
                }
                const dry = mig.migrateChat(list, { dryRun: true });
                log.info('migrate', `chat needs migration: inspected=${dry.inspected} would-change=${dry.changed} unreadable=${dry.unreadable} future=${dry.future}`);
                if (dry.changed > 0 || dry.unreadable > 0) {
                    const real = mig.migrateChat(list, {});
                    log.info('migrate', `chat migrated: changed=${real.changed} unreadable=${real.unreadable}`);
                    saveChatConditional?.();
                }
            } catch (err) {
                log.warn('migrate', `migration failed: ${redact(String(err?.message ?? err))}`);
            }
        })();
    }, 250);
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
        let watchChatSeq = -1;
        try {
            const url = typeof input === 'string' ? input : (input?.url ?? '');
            const isBackend = /\/api\/backends\/(chat-completions|text-completions)\/generate/.test(url);
            // F16 (critique round 1): only OUR turns are watched. Quiet
            // generations and other extensions call the same endpoint — they
            // must not be logged as "note NOT FOUND" nor counted as narrator
            // spend. generationKind is latched 'real' at GENERATION_STARTED and
            // cleared at reply/chat-change — exactly the in-flight window.
            // (B1, round 3: this condition used `turnInFlight`, which was
            // declared NOWHERE — the watcher threw on every request and the
            // script-verified chain + narrator spend were dead on the shipped
            // build, while every available gate stayed green.)
            if (isBackend && typeof init?.body === 'string' && generationKind === 'real') {
                watched = true;
                watchChatSeq = chatSeq;
                const turn = log.turn(turnKey(currentTokenSafe()));
                turn.outgoingPromptSeen = true;
                turn.outgoingBody = init.body;
                // T-R2-4: verify exactly what THIS turn delivered (deliveredNote) —
                // verifying a stale module variable reported "NOT FOUND" for notes
                // that shipped ('use old', reuse-after-reload).
                const check = verifyInOutgoing(init.body, deliveredNote ?? '');
                // R2-12: never flip an already-set flag — an unrelated request must
                // not overwrite a verified result.
                if (turn.noteFoundOutgoing === undefined || turn.noteFoundOutgoing === null || turn.noteFoundOutgoing === false) {
                    turn.noteFoundOutgoing = check.found;
                }
                turn.finishedAt = Date.now();
                log[check.found ? 'info' : 'warn'](
                    'outgoing',
                    `${url.split('/api/')[1]} — note ${check.found ? 'FOUND' : 'NOT FOUND'} in the real outgoing request`,
                );
            }
        } catch (err) {
            log.error('outgoing', `watcher failed: ${redact(String(err?.message ?? err))}`);
        }
        let res;
        try {
            res = await original(input, init);
        } catch (err) {
            // T-R5-14: a request that dies at the FETCH layer (aborted, blocked
            // by the browser, network down) used to leave NO trace at all — the
            // user just saw the narrator never answer. Name the killer.
            if (watched) {
                log.error('outgoing', `the narrator's request FAILED before completing: ${redact(String(err?.name ?? 'Error'))}: ${redact(String(err?.message ?? err))}`);
            }
            throw err;
        }
        if (watched) {
            // T-R5-14: the HTTP outcome IS the evidence. "the narrator didn't
            // answer" must never be a mystery again — status first, then the
            // error body when there is one.
            try {
                const bodyClone = res.clone();
                bodyClone.text().then((text) => {
                    let parsed = null;
                    try {
                        parsed = JSON.parse(text);
                    } catch { /* not JSON — shown raw below */ }
                    const errObj = parsed?.error;
                    const rateLimited = res.status === 429 || /429|too many requests|rate.?limit/i.test(String(text));
                    const rateHint = () => {
                        if (!rateLimited) {
                            return;
                        }
                        log.error('outgoing', "RATE LIMITED: the narrator shares the model's rate budget with the copilot's extractor/composer calls (they fire right before it). Fixes, in order: (1) put a different model in the extractor and composer chains in the copilot settings — the narrator then gets the whole budget; (2) set retries to 0 so a bad answer is not retried; (3) wait a minute and press Retry. The note and extraction ARE stored — only this turn's reply was lost.");
                    };
                    if (errObj) {
                        const msg = typeof errObj === 'string' ? errObj : (errObj.message ?? JSON.stringify(errObj));
                        log.error('outgoing', `the narrator's request returned an ERROR (HTTP ${res.status}): ${redact(String(msg)).slice(0, 300)}`);
                        rateHint();
                        return;
                    }
                    if (!res.ok) {
                        log.error('outgoing', `the narrator's request came back HTTP ${res.status}: ${redact(text).slice(0, 300)}`);
                        rateHint();
                        return;
                    }
                    log.info('outgoing', `the narrator's request completed HTTP ${res.status}`);
                }).catch(() => {
                    if (!res.ok) {
                        log.error('outgoing', `the narrator's request came back HTTP ${res.status} (body unreadable)`);
                    }
                });
            } catch { /* clone refused — nothing to read */ }
            // Spend (§6): the NARRATOR's provider-reported usage, read from the
            // response. A streamed response reports nothing (PROBLEMS.md §4) —
            // counted as zero and SAID so, never estimated.
            try {
                res.clone().json().then((body) => {
                    // F16: attribute to the chat that was live at REQUEST time —
                    // a chat switch mid-flight must not leak usage into the
                    // wrong chat's spend (drop it WITH a line instead).
                    if (chatSeq !== watchChatSeq) {
                        log.warn('spend', 'narrator usage arrived after a chat switch — dropped (belongs to another chat)');
                        return;
                    }
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
                <span class="copilot-pilot" title="status light: green = active and running, red = off (disabled or no API key)">●</span>
                <code class="copilot-build">build ${BUILD_ID}</code>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-up up"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="copilot-head">
                    <button type="button" data-act="toggle" title="Enable or disable the extension. Disabled = no extractor/composer calls, no injection. The pilot light turns red.">Toggle</button>
                </div>
                <div class="copilot-goals"></div>
                <div class="copilot-presets"></div>
                <div class="copilot-spend"></div>
                <div class="copilot-lore"></div>
                <div class="copilot-compress"></div>
                <div class="copilot-transfer"></div>
                <div class="copilot-settings"></div>
                <div class="copilot-records"></div>
                <div class="copilot-log">
                    <div class="copilot-gr-head" title="Per-turn diagnostics: models, timings, prompt sizes, failures — for THIS chat only (the log resets on a chat change). Copy gives the plain text."><strong>debug log</strong>
                        <em class="copilot-spend-note">this chat's turns — formatted for reading; copy gives the plain text</em>
                    </div>
                    <div class="copilot-head">
                        <button type="button" data-act="copy" title="Copy the whole debug log (unredacted copy is trimmed only by the clipboard) to the clipboard.">Copy log</button>
                        <button type="button" data-act="clear" title="Empty the on-screen log. Nothing stored with the chat is touched.">Clear</button>
                    </div>
                    <pre class="copilot-body"></pre>
                </div>
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
    // T-R4-5 (user request): the DISPLAY is formatted — turn headers separated,
    // failures in red, section labels bold. The Copy button keeps giving the
    // plain text (the audit artifact, I7).
    const render = () => {
        const lines = log.toText({ maxPerLine: 400 }).split('\n');
        body.innerHTML = lines.map((line) => {
            const cls = /^── turn /.test(line) ? ' copilot-log-line-turn'
                : /FAILURES/.test(line) ? ' copilot-log-line-fail'
                    : /^(copilot debug log|events:)/.test(line) ? ' copilot-log-line-meta'
                        : /^ {2}[a-z][a-z -]*:/.test(line) ? ' copilot-log-line-label'
                            : '';
            return `<span class="copilot-log-line${cls}">${escapeHtml(line) || '&nbsp;'}</span>`;
        }).join('');
    };

    // ---- Pilot light (user report: "add a pilot light that shows if it's
    // active or not"). ONE glanceable lamp in the drawer header, driven by the
    // same two gates the turn path uses (index.js `onGenerationStarted`):
    //   GREEN = enabled AND a key resolves → the next narrator turn will run.
    //   RED   = disabled, or no key from either source → turns are skipped.
    // The tooltip names WHICH gate is closed, because "red" alone is not
    // actionable. Never throws: the lamp is decoration and must not break the
    // panel (I5).
    const pilotEl = panel.querySelector('.copilot-pilot');
    const toggleBtn = panel.querySelector('[data-act="toggle"]');
    const renderPilot = () => {
        try {
            const s = settings();
            const hasKey = Boolean(apiKey());
            const on = Boolean(s.enabled) && hasKey;
            pilotEl.classList.toggle('copilot-pilot-on', on);
            pilotEl.classList.toggle('copilot-pilot-off', !on);
            // T-R4-2 (user report: "pilot light not working"): the button said
            // just "Toggle", so a user who had flipped it OFF could not tell
            // which state they were in or which way it would go. The label is
            // now the ACTION, and the lamp itself is clickable.
            if (toggleBtn) {
                toggleBtn.textContent = s.enabled ? 'Disable copilot' : 'Enable copilot';
            }
            const why = !s.enabled
                ? "copilot is DISABLED — click this lamp or press 'Enable copilot' above"
                : (!hasKey
                    ? (apiKeyProblem() || 'no API key')
                    : `active — key from ${apiKeySource() === 'panel' ? 'the panel field' : 'ST\'s server secret'}, extractor + composer will run on the next narrator turn`);
            pilotEl.title = `${on ? 'copilot is ON' : 'copilot is OFF'}: ${why}`;
            pilotEl.setAttribute('aria-label', on ? 'copilot active' : 'copilot off');
        } catch {
            // Decoration only — a failure here must never take the panel down.
        }
    };
    // The lamp is a real switch. stopPropagation matters: it sits INSIDE ST's
    // global `.inline-drawer-toggle` header handler (script.js:12131), which
    // would otherwise collapse the drawer on every lamp click.
    pilotEl.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const s = settings();
        saveSettings({ enabled: !s.enabled });
        log.info('panel', `copilot ${!s.enabled ? 'enabled' : 'disabled'} (pilot light clicked)`);
        renderPilot();
        render();
    });

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
                <div class="copilot-gr-head" title="Goals and requests are script-tracked counters the composer is TOLD about — the model never counts turns itself."><strong>goals &amp; requests</strong></div>
                <div class="copilot-gr-add">
                    <input type="text" data-gr="goal-text" placeholder="goal (e.g. introduce Bob)" title="A long-running thing the story should move toward. Shown to the composer as {{copilot.goals}}." />
                    <input type="text" data-gr="goal-turns" placeholder="turns (blank = forever)" size="12" title="How many narrator turns this goal stays active. Blank = never expires." />
                    <button type="button" data-act="add-goal" title="Add this goal to the chat. Stored with the chat, not the extension settings.">Add goal</button>
                </div>
                <div class="copilot-gr-add">
                    <input type="text" data-gr="req-text" placeholder="request (e.g. nudge toward the storm)" title="A short-lived instruction for the next few turns. Shown to the composer as {{copilot.userRequest}}." />
                    <input type="text" data-gr="req-turns" placeholder="turns (blank = forever)" size="12" title="How many turns this request stays active before it expires. Blank = never expires." />
                    <button type="button" data-act="add-request" title="Add this request. It is counted down once per narrator turn by the script.">Add request</button>
                </div>
                ${goals.map((g) => {
                    const elapsed = Object.values(g.turnCounters ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
                    const remaining = g.remainingTurns === 'forever' ? 'no expiry' : `${Math.max(0, g.remainingTurns - elapsed)} left`;
                    return `<div class="copilot-gr-item${g.complete ? ' copilot-gr-done' : ''}" data-id="${escapeHtml(g.id)}" title="goal: ${escapeHtml(g.text)} — ${elapsed} turns elapsed, ${remaining}">
                        <span>${escapeHtml(g.text)} — ${elapsed} turns elapsed, ${remaining}${g.complete ? ' (complete)' : ''}</span>
                        ${g.complete ? '' : '<button type="button" data-act="done-goal" title="Mark this goal complete so the composer stops seeing it as active.">Done</button>'}
                    </div>`;
                }).join('')}
                ${requests.map((r) => {
                    const remaining = r.remainingTurns === 'forever' ? 'forever' : `${Math.max(0, r.remainingTurns - (Number(r.turnsElapsed) || 0))} left`;
                    return `<div class="copilot-gr-item${r.complete ? ' copilot-gr-done' : ''}" data-id="${escapeHtml(r.id)}" title="request: ${escapeHtml(r.text)} — ${remaining}">
                        <span>${escapeHtml(r.text)} — ${remaining}${r.complete ? ' (expired)' : ''}</span>
                        <button type="button" data-act="remove-request" title="Delete this request now instead of waiting for it to expire.">Remove</button>
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
                <div class="copilot-gr-head" title="A preset is a saved bundle of the extractor/composer configuration below. Applying one overwrites the current model chains, temperatures and templates."><strong>presets</strong></div>
                <div class="copilot-gr-add">
                    <select data-gr="preset-select" title="Pick a saved preset to apply or delete.">
                        ${list.map((p) => `<option value="${escapeHtml(p.id)}"${p.id === s.activePreset ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
                    </select>
                    <button type="button" data-act="apply-preset" title="Load this preset's models, temperatures, token caps and prompt templates into the live settings.">Apply</button>
                    <button type="button" data-act="delete-preset" title="Remove this preset from the list. The live settings are not changed.">Delete</button>
                </div>
                <div class="copilot-gr-add">
                    <input type="text" data-gr="preset-name" placeholder="new preset name (saves the current config)" title="Name for a new preset — the CURRENT settings (chains, temperatures, caps, templates) are snapshotted under it." />
                    <button type="button" data-act="save-preset" title="Snapshot the current configuration under the name on the left.">Save current as preset</button>
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
                <div class="copilot-gr-head" title="Token counts and cost come from the provider's own usage report — never estimated. The narrator line is what ST spent on the story model, reported here so the total is honest."><strong>spend</strong> <em class="copilot-spend-note">provider-reported usage only; prices are per token, yours to edit</em></div>
                ${row('extractor')}
                ${row('composer')}
                ${row('narrator')}
                <div class="copilot-gr-add">
                    <span class="copilot-spend-role" title="All three roles combined.">combined</span>
                    <span class="copilot-spend-total">${t.combined.tokensIn}/${t.combined.tokensOut} tok · $${t.combined.costUsd.toFixed(6)} · ${t.combined.calls} calls</span>
                    <button type="button" data-act="save-prices" title="Store the per-token prices above so the cost column is computed your way.">Save prices</button>
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
                <div class="copilot-gr-head" title="Lorebook entries with names listed here are ALWAYS included in the composer's {{copilot.lorebook}} block, even when ST did not trigger them for this turn."><strong>lorebook</strong>
                    <em class="copilot-spend-note">permanently triggered keys (comma or newline separated) — always in the composer's lorebook block</em>
                </div>
                <textarea data-gr="lore-keys" rows="2" placeholder="e.g. turbine, ancient_map" title="Entry NAMES from the active world info / lorebook, separated by commas or newlines. Entries with these names are treated as permanently triggered and always shown to the composer."></textarea>
                <div class="copilot-gr-add"><button type="button" data-act="lore-save" title="Store these keys with the extension settings. The composer's lorebook block is rebuilt on every turn.">Save</button></div>`;
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
            const list = ctx().chat ?? [];
            // T-R4-9 (user report): only the CURRENT swipe's facts belong here —
            // merging facts from other swipes mixes realities. Facts already
            // compressed away stay visible as history, marked 📦, without a
            // checkbox (they are already folded).
            const entries = collectExtractions(list, { currentSwipeOnly: true });
            const visibleIds = new Set(entries.map((e) => e.extraction.id));
            const folded = listRecords(list)
                .filter((e) => e.isCurrentSwipe)
                .flatMap((e) => [
                    ...(e.record.extraction ? [{ extraction: e.record.extraction, messageIndex: e.messageIndex, swipeIndex: e.swipeIndex }] : []),
                    ...(Array.isArray(e.record.extractions) ? e.record.extractions.filter(Boolean).map((x) => ({ extraction: x, messageIndex: e.messageIndex, swipeIndex: e.swipeIndex })) : []),
                ])
                .filter((e) => (isCompressedAway(e.extraction) || e.extraction.sources?.length) && !visibleIds.has(e.extraction.id));
            const row = (e, tickable) => {
                const box = (isCompressedAway(e.extraction) || e.extraction.sources?.length) ? '📦 ' : '';
                return `
                    <div class="copilot-gr-item" data-cidx="${e.extraction.id}" title="extraction ${escapeHtml(String(e.extraction.id))} from message ${e.messageIndex}.${e.swipeIndex}">
                        ${tickable
                            ? `<label title="Tick to include in a compression. Only a contiguous run of ticks can be merged."><input type="checkbox" data-csel="${e.extraction.id}" /> ${box}#${e.messageIndex}.${e.swipeIndex}</label>`
                            : `<span class="copilot-c-text">${box}#${e.messageIndex}.${e.swipeIndex} (compressed)</span>`}
                        <span class="copilot-c-text">${escapeHtml(String(e.extraction.text ?? '').slice(0, 90))}</span>
                        <button type="button" data-act="view-extraction" data-ext-id="${e.extraction.id}" title="Open the FULL extraction in a popup — readable and editable. Save rewrites it and flags the note stale.">View/Edit</button>
                        ${tickable ? `
                        <button type="button" data-act="toggle-pin" data-ext-id="${e.extraction.id}" title="Pin = this fact can NEVER be merged away. Unpin to allow merging again.">${e.extraction.pinned ? 'Unpin' : 'Pin'}</button>
                        <button type="button" data-act="toggle-protect" data-ext-id="${e.extraction.id}" title="Protect = automatic merges skip this fact. Manual 'Compress selected' can still merge it.">${e.extraction.protected ? 'Unprotect' : 'Protect'}</button>` : ''}
                    </div>`;
            };
            compressEl.innerHTML = `
                <div class="copilot-gr-head" title="When the visible fact list grows long, this merges old facts into one short block. The originals are never deleted — they are folded into history and stay auditable (I1/I2)."><strong>compressor</strong>
                    <em class="copilot-spend-note">current swipe only; 📦 = already compressed; merge a contiguous range (I1/I2)</em>
                </div>
                <div class="copilot-gr-add">
                    <button type="button" data-act="compress-run" title="Merge the facts ticked below into one. Only a CONTIGUOUS ticked range can be merged.">Compress selected</button>
                    <button type="button" data-act="compress-undo" title="Put the last merge back: the merged block is removed and its originals become visible again.">Undo last compression</button>
                </div>
                ${[...entries.map((e) => row(e, true)), ...folded.map((e) => row(e, false))].join('')}
                <div class="copilot-gr-add">
                    <label title="Auto-compress (default OFF — the G2 review gates enabling it by default): when more facts exist than the threshold below, the oldest usable run is merged automatically"><input type="checkbox" data-cset="auto"${s.compress?.auto ? ' checked' : ''} /> auto-compress</label>
                    <label title="Merge only when MORE than this many extractions are visible">merge above <input type="text" data-cset="maxVisible" value="${escapeHtml(String(s.compress?.maxVisible ?? 40))}" size="4" title="visible-extractions threshold (default 40)" /></label>
                    <label title="How many of the OLDEST usable facts to merge at once">merge the oldest <input type="text" data-cset="mergeCount" value="${escapeHtml(String(s.compress?.mergeCount ?? 10))}" size="4" title="how many oldest to merge (default 10)" /></label>
                    <button type="button" data-act="compress-settings" title="Save the auto-compress settings">Save</button>
                    <button type="button" data-act="compress-auto" title="Merge the oldest usable run right now">Run auto-compress now</button>
                </div>
                ${(ctx().chatMetadata?.copilot?.snapshots ?? []).length ? `
                <div class="copilot-gr-head" title="A snapshot taken before a compression, kept for rollback. Restoring is destructive to records created after it — you are asked first."><strong>pre-op snapshots (I3)</strong>
                    <em class="copilot-spend-note">restore returns to the snapshot — records created AFTER it are removed (you will be asked first)</em>
                </div>
                ${(ctx().chatMetadata?.copilot?.snapshots ?? []).map((snap, i) => `
                    <div class="copilot-gr-item">
                        <span class="copilot-c-text">snapshot ${i + 1} — ${(snap?.messages ?? []).length} recorded messages</span>
                        <button type="button" data-act="restore-snap" data-snap="${i}" title="Roll the chat's copilot data back to this snapshot. Asks for confirmation first.">Restore</button>
                    </div>`).join('')}` : ''}`;
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
            const ids = [...compressEl.querySelectorAll('[data-csel]')]
                .filter((c) => c.checked)
                .map((c) => String(c.dataset.csel));
            await runManualCompression(ids);
        } else if (act === 'compress-undo') {
            undoLastCompression();
        } else if (act === 'compress-auto') {
            await runAutoCompression();
        } else if (act === 'compress-settings') {
            const val = (name) => Number(compressEl.querySelector(`[data-cset="${name}"]`)?.value) || 0;
            const auto = Boolean(compressEl.querySelector('[data-cset="auto"]')?.checked);
            saveSettings({ compress: { auto, maxVisible: val('maxVisible') || 40, mergeCount: val('mergeCount') || 10 } });
            log.info('compress', `settings saved: auto=${auto} maxVisible=${val('maxVisible')} mergeCount=${val('mergeCount')}`);
        } else if (act === 'view-extraction') {
            await viewExtraction(String(btn.dataset.extId ?? ''));
        } else if (act === 'toggle-pin' || act === 'toggle-protect') {
            toggleEntryFlag(String(btn.dataset.extId ?? ''), act === 'toggle-pin' ? 'pinned' : 'protected');
        } else if (act === 'restore-snap') {
            // R2-10 (I3): "restore works from the UI" — the snapshots ring was
            // written but unreachable. Restore is DESTRUCTIVE for records
            // created after the snapshot (T-R2-14), so it asks first; the
            // benign timeout answer is 'no'.
            const idx = Number(btn.dataset.snap);
            const meta = ctx().chatMetadata?.copilot ?? {};
            const snap = (meta.snapshots ?? [])[idx];
            if (!snap) {
                log.warn('compress', 'that snapshot no longer exists');
            } else {
                const visibleNow = collectExtractions(chat()).length;
                let answer = 'no';
                try {
                    const PopupCls = ctx().Popup;
                    if (PopupCls?.show?.confirm) {
                        answer = await popupWithTimeout(
                            PopupCls.show.confirm(
                                'Restore snapshot',
                                `Restore pre-op snapshot ${idx + 1}? Records created AFTER it (currently ${visibleNow} visible extractions) will be REMOVED.`,
                                { okButton: 'Restore', cancelButton: 'Keep the current state' },
                            ).then((r) => (r === 1 ? 'yes' : 'no')),
                            20000, 'no', 'restore-snapshot confirm',
                        );
                    }
                } catch {
                    answer = 'no';
                }
                if (answer === 'yes') {
                    const touched = restoreChat(chat(), snap);
                    saveChatConditional?.();
                    log.warn('compress', `snapshot ${idx + 1} restored — ${touched} record slots touched (post-snapshot records removed)`);
                } else {
                    log.info('compress', 'restore cancelled — nothing changed');
                }
            }
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
                <div class="copilot-gr-head" title="Copilot memory lives in the CHAT, not in the extension settings — this is how you carry it to another chat or machine. Imports are idempotent and a snapshot is kept first."><strong>import / export</strong>
                    <em class="copilot-spend-note">carry memory between chats (S9) — a snapshot is kept before every import</em>
                </div>
                <div class="copilot-gr-add">
                    <button type="button" data-act="export-state" title="Write every copilot record in THIS chat (extractions, notes, injections, goals, spend) into the box below as JSON.">Export chat state</button>
                    <button type="button" data-act="import-state" title="Merge the JSON in the box below into this chat. Existing records are kept; duplicates are skipped.">Import into this chat</button>
                    <button type="button" data-act="restore-import" title="UNDO the last import by restoring the snapshot taken just before it. Asks for confirmation.">Restore pre-import snapshot</button>
                </div>
                <textarea data-gr="transfer-json" rows="4" placeholder="exported bundle JSON appears here; paste a bundle here to import it" title="The export button fills this with a JSON bundle; paste a bundle here and press Import."></textarea>`;
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
            // T-R2-14: restore is destructive for post-import records — ask,
            // with the benign timeout answer 'no'.
            let answer = 'no';
            try {
                const PopupCls = ctx().Popup;
                if (PopupCls?.show?.confirm) {
                    answer = await popupWithTimeout(
                        PopupCls.show.confirm(
                            'Restore pre-import snapshot',
                            'This REMOVES the records the import added. Continue?',
                            { okButton: 'Restore', cancelButton: 'Keep them' },
                        ).then((r) => (r === 1 ? 'yes' : 'no')),
                        20000, 'no', 'restore-import confirm',
                    );
                }
            } catch {
                answer = 'no';
            }
            if (answer === 'yes') {
                restorePreImport();
            } else {
                log.info('transfer', 'restore cancelled — nothing changed');
            }
        }
        renderTransfer();
        render();
    });

    // ---- The configuration surface (§6; critique F9/finding 2: every setting
    // used to be console-only while README promised fields). Every control here
    // is WIRED — no decorative inputs (trap 10).
    // ---- Premade prompt templates (user report: "there seems to be none at the
    // moment"). A bundle fills the three template boxes below; the boxes stay
    // editable and NOTHING is saved until Save settings is pressed. All bundles
    // keep the shipped extractor and compressor; only the NOTE VOICE differs,
    // because that is the text the narrator actually reads. Every bundle keeps
    // the shipped neutrality rule (§10.5): no judging, filtering or refusing.
    const composerVariant = (extra) => `${DEFAULT_COMPOSER_PROMPT}\n\n${extra}`;
    const PREMADE_TEMPLATES = [
        {
            id: 'default',
            name: 'default — neutral guidance',
            description: 'The shipped template: neutral prose note, 15–120 words, facts first, no padding. Extractor and compressor are the shipped ones.',
        },
        {
            id: 'terse',
            name: 'terse — short continuity notes',
            description: 'For fast, chatty, or silly sessions. Notes stay near the LOW end of the word range and carry only what would break continuity if forgotten.',
            composer: composerVariant(`BREVITY OVERRIDE
Write near the LOW end of the word range: one or two sentences when the scene is
simple. Carry only what would break continuity if forgotten — names, promises,
objects, injuries, positions. Skip mood, skip scene-setting, skip anything the
narrator can see in the last few messages.`),
        },
        {
            id: 'detailed',
            name: 'detailed — deep continuity',
            description: 'For long, complex stories. Notes run near the HIGH end of the range and carry state later turns will need: knowledge, wants, promises, damage, positions, time.',
            composer: composerVariant(`DEPTH OVERRIDE
Write near the HIGH end of the word range. Beyond the current scene, carry the
state that later turns will need: who knows what, who wants what, what was
promised, what is broken or spent, where people are, what time it is. Prefer one
more true fact over a longer description of one fact.`),
        },
        {
            id: 'threads',
            name: 'threads — open plots first',
            description: 'For mystery, intrigue, and quest play. The note is ordered by open threads — unresolved questions, promises, threats, conflicting wants — so nothing is silently forgotten.',
            composer: composerVariant(`THREADS OVERRIDE
Order the note by open threads: unresolved questions, promises made, threats
looming, wants in conflict. Name each thread concretely and say where it stands.
A closed thread gets one line at most. The point of this note is that no thread
is silently forgotten.`),
        },
        {
            id: 'atmosphere',
            name: 'atmosphere — mood continuity',
            description: 'For mood-driven prose. Adds one or two established-fact sentences about light, weather, sound and distance, so the next scene keeps the same air.',
            composer: composerVariant(`ATMOSPHERE OVERRIDE
Add one or two sentences at the top: the mood of the place and moment as
established so far — light, weather, sound, distance between people. State it as
established fact, not as an instruction to generate feeling. Then the facts.`),
        },
    ];
    // Shipped bundles + the user's own saved ones (values prefixed `custom:` so
    // the two lists can never collide).
    const templateById = (id, s) => {
        const v = String(id ?? 'default');
        if (v.startsWith('custom:')) {
            const t = (s.customTemplates ?? []).find((x) => x.id === v.slice(7));
            return t
                ? { id: v, name: `${t.name} (yours)`, description: t.description || 'your own saved template', extractor: t.extractor, composer: t.composer, compressor: t.compressor }
                : null;
        }
        return PREMADE_TEMPLATES.find((t) => t.id === v) ?? null;
    };
    const settingsEl = panel.querySelector('.copilot-settings');
    const renderSettings = () => {
        try {
            const s = settings();
            // Keep unsaved typing across re-renders (log lines re-render the panel).
            const keep = {};
            for (const el of settingsEl.querySelectorAll('[data-set]')) {
                keep[el.dataset.set] = el.type === 'checkbox' ? String(el.checked) : el.value;
            }
            const put = (name, v) => {
                const el = settingsEl.querySelector(`[data-set="${name}"]`);
                if (el) {
                    el.value = keep[name] ?? String(v ?? '');
                }
            };
            settingsEl.innerHTML = `
                <div class="copilot-gr-head"><strong>settings</strong>
                    <em class="copilot-spend-note">every field saves with Save settings — the API key field is the reliable place for your key</em>
                </div>
                <div class="copilot-set-grid">
                    <label title="The OpenRouter key this extension uses for its own model calls. Most reliable source: type it here. Blank = try ST's server-side OpenRouter secret, which only works when config.yaml has allowKeysExposure: true.">API key <input type="password" data-set="apiKey" title="Hand-typed keys are trimmed automatically. Typed here = always works. Blank = ST's OpenRouter secret (needs allowKeysExposure: true on the server)." placeholder="type the key here (most reliable)" /></label>
                    <label title="A key typed above is stored PLAINTEXT in the extension settings file.">key storage <button type="button" data-act="settings-clear-key" class="copilot-danger">Clear saved key</button></label>
                    <label title="OpenAI-compatible endpoint. Only change this for a different provider.">baseUrl <input type="text" data-set="baseUrl" title="https://openrouter.ai/api/v1 by default" /></label>
                    <label title="Comma-separated model ids, tried in order — the extractor is the CHEAP per-turn fact recorder.">extractor chain <input type="text" data-set="extractorChain" title="e.g. inclusionai/ling-3.0-flash, dots-studio/dots-3-note-preview:free" /></label>
                    <label title="Comma-separated model ids for the NOTE writer — the voice the narrator reads.">composer chain <input type="text" data-set="composerChain" title="e.g. qwen/qwen3.7-flash, sao10k/l3-lunaris-8b" /></label>
                    <label title="Comma-separated model ids for merging old facts. Blank = the extractor chain.">compressor chain <input type="text" data-set="compressorChain" title="e.g. inclusionai/ling-3.0-flash" /></label>
                    <label title="Sampling temperature per role. Extractor should stay low; composer higher.">temp extractor / composer <input type="text" data-set="extractorTemp" size="4" title="extractor temperature (0.2 default)" /> <input type="text" data-set="composerTemp" size="4" title="composer temperature (0.7 default)" /></label>
                    <label title="Response token caps per role. Empty = automatic per-model budgets.">tokens extractor / composer <input type="text" data-set="extractorMaxTokens" size="6" title="empty = automatic per-model budget" /> <input type="text" data-set="composerMaxTokens" size="6" title="empty = automatic per-model budget" /></label>
                    <label title="Reasoning (thinking) effort for models that support it — sent as reasoning.effort. 'none' sends nothing, so non-reasoning models are untouched. A thinking model that burns its whole budget on reasoning can also be kept at 'low' so it actually answers.">reasoning ext / composer
                        <select data-set="extractorReasoning" title="extractor reasoning effort">
                            <option value="none">none</option>
                            <option value="low">low</option>
                            <option value="medium">medium</option>
                            <option value="high">high</option>
                        </select>
                        <select data-set="composerReasoning" title="composer reasoning effort">
                            <option value="none">none</option>
                            <option value="low">low</option>
                            <option value="medium">medium</option>
                            <option value="high">high</option>
                        </select>
                    </label>
                    <label title="How many RECENT messages each role may read (the transcripts are counted in messages, not characters).">recent messages ext / comp <input type="text" data-set="extractorMaxMessages" size="4" title="extractor: how many recent messages (default 12)" /> <input type="text" data-set="composerMaxMessages" size="4" title="composer: how many recent messages (default 20)" /></label>
                    <label title="Safety caps on the total transcript characters sent. Usually leave as-is.">safety chars ext / comp <input type="text" data-set="extractorMaxChars" size="5" title="safety cap, characters" /> <input type="text" data-set="composerMaxChars" size="5" title="safety cap, characters" /></label>
                    <label title="Note length bounds. The minimum is a garbage floor (1-2 word answers are rejected); the maximum is hard.">note words min / max <input type="text" data-set="minWords" size="4" title="soft minimum — short real notes are accepted (default 15)" /> <input type="text" data-set="maxWords" size="4" title="hard maximum (default 120)" /></label>
                    <label title="How long the whole extractor+composer step may take before the turn continues without a note.">turn budget ms <input type="text" data-set="maxWaitMs" size="7" title="maxWaitMs — a slow model never blocks the chat past this" /></label>
                    <label title="What a swipe/regenerate does: ask you, always write a new note, or reuse the current one.">reroll / swipe behavior
                        <select data-set="rerollMode" title="ask = popup; new = always compose; reuse = keep the current note">
                            <option value="ask">ask (popup)</option>
                            <option value="new">always compose new</option>
                            <option value="reuse">always reuse</option>
                        </select>
                    </label>
                    <label title="On a reroll, show old vs new extraction and note before choosing."><input type="checkbox" data-set="diffPopup" /> diff popup on rerolls</label>
                    <label title="Where the &lt;copilot&gt; note goes in the prompt. 'none' = compose and store but never send.">injection position
                        <select data-set="injectPosition" title="end / before the last message / first / none (log only)">
                            <option value="end">end of the prompt</option>
                            <option value="before_last">before the last message</option>
                            <option value="first">first</option>
                            <option value="none">none (log only)</option>
                        </select>
                    </label>
                    <label title="Registry depth (messages from the end) and the role the note is delivered as.">injection depth / role
                        <input type="text" data-set="injectDepth" size="3" title="depth: how many messages from the end" />
                        <select data-set="injectRole" title="the role the note appears as">
                            <option value="system">system</option>
                            <option value="user">user</option>
                            <option value="assistant">assistant</option>
                        </select>
                    </label>
                </div>
                <details class="copilot-help"><summary>what can be injected / what the prompts can mention</summary>
                    <p><strong>The note</strong> (the only thing injected into the narrator's prompt) is delivered
                    at the configured position/depth/role above — on chat-completions via ST's extension-prompt registry.</p>
                    <p><strong>Prompts can mention</strong> (namespaced blocks — they never collide with ST's own macros):</p>
                    <ul>
                        <li><code>{{copilot.extractions}}</code> — the current story state (facts with their places and times)</li>
                        <li><code>{{copilot.previousState}}</code> / <code>{{copilot.lastMessages}}</code> — extractor template: the state so far and the NEW messages to fold into it</li>
                        <li><code>{{copilot.lastMessages}}</code> — the recent transcript window</li>
                        <li><code>{{copilot.lorebook}}</code> — triggered + permanently-triggered lorebook entries</li>
                        <li><code>{{copilot.characterCard}}</code>, <code>{{copilot.narratorPrompt}}</code> — the character name and the narrator's standing instructions</li>
                        <li><code>{{copilot.userRequest}}</code>, <code>{{copilot.goals}}</code> — active requests and goals (with script-counted turns)</li>
                        <li><code>{{copilot.previousNote}}</code> — the note the composer must not simply repeat</li>
                        <li><code>{{copilot.language}}</code>, <code>{{copilot.minWords}}</code>, <code>{{copilot.maxWords}}</code></li>
                    </ul>
                    <p>Templates below come PRE-FILLED with the shipped defaults — editing one overrides it;
                    clearing a box and saving restores the built-in template.</p>
                </details>
                <details open><summary>prompt templates (pre-filled with the active templates)</summary>
                    <div class="copilot-tpl-row">
                        <div class="copilot-tpl-line">
                            <label title="Template bundles: the shipped ones plus any you saved. Loading one only fills the boxes below — press Save settings to actually apply it.">template
                                <select data-set="templatePick" title="Pick a bundle, then press 'Load into boxes'. Nothing changes until you press Save settings.">
                                    ${[
                                        ...PREMADE_TEMPLATES.map((t) => ({ value: t.id, name: t.name })),
                                        ...(s.customTemplates ?? []).map((t) => ({ value: `custom:${t.id}`, name: `${t.name} (yours)` })),
                                    ].map((o) => `<option value="${escapeHtml(o.value)}"${(keep.templatePick ?? 'default') === o.value ? ' selected' : ''}>${escapeHtml(o.name)}</option>`).join('')}
                                </select>
                            </label>
                            <button type="button" data-act="template-load" title="Fill the three template boxes below with the selected bundle. Review or edit them, then press Save settings.">Load into boxes</button>
                            <button type="button" data-act="template-save" title="Save the CURRENT contents of the three boxes as your own template, under the name on the next line.">Save current as template</button>
                            <button type="button" data-act="template-delete" title="Delete the selected template. Only YOUR saved templates can be deleted — the shipped ones stay.">Delete template</button>
                        </div>
                        <div class="copilot-tpl-line">
                            <label title="The name used when you press 'Save current as template'.">template name
                                <input type="text" data-set="templateName" title="e.g. my slow-burn style" />
                            </label>
                        </div>
                        <div class="copilot-tpl-desc" title="What the selected template is for.">${escapeHtml(templateById(keep.templatePick ?? 'default', s)?.description ?? PREMADE_TEMPLATES[0].description)}</div>
                    </div>
                    <label>extractor <textarea data-set="promptExtractor" rows="6" title="What the fact recorder sees. The transcript is appended as the user turn."></textarea></label>
                    <label>composer <textarea data-set="promptComposer" rows="6" title="What the note writer sees. Use the {{copilot.*}} blocks above."></textarea></label>
                    <label>compressor <textarea data-set="promptCompressor" rows="6" title="What the merge model sees. Output must be inside <compressed>...</compressed> tags and shorter than its input."></textarea></label>
                    <div class="copilot-gr-add">
                        <button type="button" data-act="settings-defaults">Restore default templates</button>
                    </div>
                </details>
                <div class="copilot-gr-add"><button type="button" data-act="settings-save">Save settings</button></div>`;
            put('apiKey', '');
            // T-R4-2 (user report: "key really doesn't want to be kept"): the
            // field renders EMPTY even when a key IS saved — secrets are never
            // echoed into the DOM — and that looked exactly like "the key did
            // not save". The placeholder now reports the SAVED state.
            const keyEl = settingsEl.querySelector('[data-set="apiKey"]');
            if (keyEl) {
                const hasStoredKey = Boolean(String(settings().apiKey ?? '').trim()) || Boolean(stSecretKey);
                keyEl.placeholder = hasStoredKey
                    ? 'a saved key is on file — type here to replace it'
                    : 'type the key here (most reliable)';
            }
            put('baseUrl', s.baseUrl ?? '');
            put('extractorChain', (s.extractor?.chain ?? []).join(', '));
            put('composerChain', (s.composer?.chain ?? []).join(', '));
            put('compressorChain', (s.compressorChain ?? []).join(', '));
            put('extractorTemp', s.extractor?.temperature ?? 0.2);
            put('composerTemp', s.composer?.temperature ?? 0.7);
            put('extractorMaxTokens', s.extractor?.maxTokens ?? '');
            put('composerMaxTokens', s.composer?.maxTokens ?? '');
            put('extractorMaxMessages', s.extractor?.maxMessages ?? 12);
            put('composerMaxMessages', s.composer?.maxMessages ?? 20);
            put('extractorMaxChars', s.extractor?.maxChars ?? 6000);
            put('composerMaxChars', s.composer?.maxChars ?? 8000);
            put('minWords', s.composer?.minWords ?? 15);
            put('maxWords', s.composer?.maxWords ?? 120);
            put('maxWaitMs', s.maxWaitMs ?? 60000);
            put('rerollMode', s.rerollMode ?? 'ask');
            const dp = settingsEl.querySelector('[data-set="diffPopup"]');
            if (dp) {
                dp.checked = keep.diffPopup !== undefined ? keep.diffPopup === 'true' : (s.diffPopup !== false);
            }
            put('injectPosition', s.injection?.position ?? 'end');
            put('injectDepth', s.injection?.depth ?? 0);
            put('injectRole', s.injection?.role ?? 'system');
            // Templates are PRE-FILLED with the ACTIVE text (default when unset)
            // — empty boxes looked like "there are no templates" (user report).
            put('promptExtractor', s.extractor?.prompt ?? DEFAULT_EXTRACTOR_PROMPT);
            put('promptComposer', s.composer?.prompt ?? DEFAULT_COMPOSER_PROMPT);
            put('promptCompressor', s.compressorPrompt ?? DEFAULT_COMPRESSOR_PROMPT);
            put('extractorReasoning', s.extractor?.reasoning ?? 'none');
            put('composerReasoning', s.composer?.reasoning ?? 'none');
        } catch (err) {
            settingsEl.textContent = `settings unavailable: ${redact(String(err?.message ?? err))}`;
        }
    };
    settingsEl.addEventListener('click', (ev) => {
        const btn = ev.target.closest?.('button[data-act="settings-save"], button[data-act="settings-clear-key"], button[data-act="settings-defaults"], button[data-act="template-load"], button[data-act="template-save"], button[data-act="template-delete"]');
        if (!btn) {
            return;
        }
        // Template bundle -> fill the boxes (NOT saved yet).
        if (btn.dataset.act === 'template-load') {
            const id = String(settingsEl.querySelector('[data-set="templatePick"]')?.value ?? 'default');
            const tpl = templateById(id, settings()) ?? PREMADE_TEMPLATES[0];
            const box = (name, v) => {
                const el = settingsEl.querySelector(`[data-set="${name}"]`);
                if (el) {
                    el.value = v;
                }
            };
            box('promptExtractor', tpl.extractor ?? DEFAULT_EXTRACTOR_PROMPT);
            box('promptComposer', tpl.composer ?? DEFAULT_COMPOSER_PROMPT);
            box('promptCompressor', tpl.compressor ?? DEFAULT_COMPRESSOR_PROMPT);
            log.info('settings', `template "${tpl.name}" loaded into the boxes — press Save settings to apply it`);
            render();
            return;
        }
        // Save the CURRENT boxes as the user's own template (T-R4-5).
        if (btn.dataset.act === 'template-save') {
            const name = String(settingsEl.querySelector('[data-set="templateName"]')?.value ?? '').trim();
            const getBox = (n) => String(settingsEl.querySelector(`[data-set="${n}"]`)?.value ?? '');
            if (!name) {
                log.warn('settings', 'give the template a name first — type it in the "template name" field');
                render();
                return;
            }
            const s0 = settings();
            saveSettings({
                customTemplates: [...(s0.customTemplates ?? []), {
                    id: `tpl_${Date.now().toString(36)}`,
                    name: name.slice(0, 60),
                    description: 'your own saved template',
                    extractor: getBox('promptExtractor') || DEFAULT_EXTRACTOR_PROMPT,
                    composer: getBox('promptComposer') || DEFAULT_COMPOSER_PROMPT,
                    compressor: getBox('promptCompressor') || DEFAULT_COMPRESSOR_PROMPT,
                }],
            });
            log.info('settings', `template "${name.slice(0, 60)}" saved from the current boxes — it is now in the template list`);
            renderSettings();
            renderPilot();
            render();
            return;
        }
        if (btn.dataset.act === 'template-delete') {
            const id = String(settingsEl.querySelector('[data-set="templatePick"]')?.value ?? '');
            const s0 = settings();
            if (!id.startsWith('custom:')) {
                log.warn('settings', 'shipped templates cannot be deleted — select one of yours in the list first');
                render();
                return;
            }
            const cid = id.slice(7);
            saveSettings({ customTemplates: (s0.customTemplates ?? []).filter((x) => x.id !== cid) });
            log.info('settings', 'your template deleted (the shipped templates are untouched)');
            renderSettings();
            render();
            return;
        }
        // T-R2-9: there used to be NO way to remove a stored key.
        if (btn.dataset.act === 'settings-clear-key') {
            saveSettings({ apiKey: '' });
            const input = settingsEl.querySelector('[data-set="apiKey"]');
            if (input) {
                input.value = '';
            }
            log.info('settings', `saved API key cleared — the panel key is gone; ST's OpenRouter secret is used instead if this server exposes it (allowKeysExposure). Status: ${stSecretStatus}`);
            renderSettings();
            renderPilot();
            render();
            return;
        }
        // Restore the built-in prompt templates (the boxes are pre-filled with
        // the ACTIVE text — user report: empty boxes looked like no templates).
        if (btn.dataset.act === 'settings-defaults') {
            const s0 = settings();
            saveSettings({
                extractor: { ...s0.extractor, prompt: undefined },
                composer: { ...s0.composer, prompt: undefined },
                compressorPrompt: undefined,
            });
            log.info('settings', 'prompt templates reset to the shipped defaults — the boxes below now show them; a later Save settings keeps them');
            renderSettings();
            render();
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
                maxWaitMs: num(get('maxWaitMs'), 60000),
                rerollMode: get('rerollMode') || 'ask',
                diffPopup: Boolean(settingsEl.querySelector('[data-set="diffPopup"]')?.checked),
                compressorChain: chain(get('compressorChain')),
                extractor: {
                    ...s.extractor,
                    chain: chain(get('extractorChain')),
                    temperature: num(get('extractorTemp'), 0.2),
                    maxTokens: num(get('extractorMaxTokens'), undefined),
                    maxChars: num(get('extractorMaxChars'), 6000),
                    maxMessages: num(get('extractorMaxMessages'), 12),
                    // m2: an EMPTY box means "use the built-in template" — the
                    // old `? :` silently kept the previous prompt (trap 10).
                    prompt: get('promptExtractor') || undefined,
                    reasoning: get('extractorReasoning') || 'none',
                },
                composer: {
                    ...s.composer,
                    chain: chain(get('composerChain')),
                    temperature: num(get('composerTemp'), 0.7),
                    maxTokens: num(get('composerMaxTokens'), undefined),
                    minWords: num(get('minWords'), 15),
                    maxWords: num(get('maxWords'), 120),
                    maxChars: num(get('composerMaxChars'), 8000),
                    maxMessages: num(get('composerMaxMessages'), 20),
                    prompt: get('promptComposer') || undefined,
                    reasoning: get('composerReasoning') || 'none',
                },
                injection: {
                    ...s.injection,
                    position: get('injectPosition') || 'end',
                    depth: num(get('injectDepth'), 0),
                    role: get('injectRole') || 'system',
                },
                compressorPrompt: get('promptCompressor') || undefined,
            });
            // T-R5-16 (user: "the extractor switches prompt middle of the
            // thing"): WHICH template text was saved must be visible — a save
            // silently re-writing an old template is otherwise undiagnosable.
            const tplLabel = (text, shipped) => (String(text ?? '').trim() === String(shipped ?? '').trim()
                ? 'shipped default'
                : `customised: "${String(text ?? '').trim().slice(0, 44)}…"`);
            log.info('settings', `settings saved from the panel (${chain(get('extractorChain')).length}/${chain(get('composerChain')).length} extractor/composer models) — extractor template: ${tplLabel(get('promptExtractor') || DEFAULT_EXTRACTOR_PROMPT, DEFAULT_EXTRACTOR_PROMPT)}; composer template: ${tplLabel(get('promptComposer') || DEFAULT_COMPOSER_PROMPT, DEFAULT_COMPOSER_PROMPT)}; compressor template: ${tplLabel(get('promptCompressor') || DEFAULT_COMPRESSOR_PROMPT, DEFAULT_COMPRESSOR_PROMPT)}`);
            renderPilot();
            // T-R4-2: re-render EXPLICITLY. The log subscriber skips it while a
            // settings control has focus — which is exactly the state after a
            // Save click — so the "saved key is on file" placeholder would stay
            // stale and the box would keep looking unsaved.
            renderSettings();
        } catch (err) {
            log.warn('settings', `save failed: ${redact(String(err?.message ?? err))}`);
        }
    });
    // The premade-template description follows the dropdown live (no save
    // needed — it is explanatory text only).
    settingsEl.addEventListener('change', (ev) => {
        if (ev.target?.dataset?.set !== 'templatePick') {
            return;
        }
        const tpl = templateById(String(ev.target.value), settings());
        const desc = settingsEl.querySelector('.copilot-tpl-desc');
        if (tpl && desc) {
            desc.textContent = tpl.description;
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
            // Reviewer-21 (trap 12): the badge belongs to the record with the
            // LATEST actual injection — list order can crown a superseded
            // (non-current-swipe) record.
            let latestIdx = -1;
            let latestAt = 0;
            entries.forEach((e, i) => {
                const at = Number(e.record?.injection?.injectedAt ?? 0);
                if (at > latestAt) {
                    latestAt = at;
                    latestIdx = i;
                }
            });
            // T-R5-23: store size is VISIBLE — a silent cap is data
            // loss; an honest size line is not.
            const totalBytes = entries.reduce((n, e) => n + JSON.stringify(e.record ?? {}).length, 0);
            const sizeLine = `<div class="copilot-gr-add"><button type="button" data-act="copy-records" title="Copy every record in this chat to the clipboard as plain text: one block per message, one per swipe, with the extractor and composer outputs.">Copy records</button><em class="copilot-badge" title="One card per message/swipe that has copilot data. Record sizes are always reported — never silently capped.">${entries.length} records — ~${Math.round(totalBytes / 1024)}KB of record data (sizes are shown, never silently capped)</em></div>`;
            // T-R4-10 (user layout): every swipe folds INSIDE its message —
            // "message {n}" is the outer fold, one fold per swipe beneath it.
            const byMessage = new Map();
            for (const e of entries) {
                if (!byMessage.has(e.messageIndex)) {
                    byMessage.set(e.messageIndex, []);
                }
                byMessage.get(e.messageIndex).push(e);
            }
            const swipeFold = (e) => {
                const rec = e.record;
                const stale = rec.composer?.staleFlag === true;
                const tr = rec.trace ?? {};
                const noInput = '(no input recorded for this turn)';
                return `
                <details class="copilot-fold copilot-swipe" data-mi="${e.messageIndex}" data-si="${e.swipeIndex}">
                    <summary title="Copilot record for message ${e.messageIndex}, swipe ${e.swipeIndex} — kept in the chat file. Click to open."><em class="copilot-badge">swipe ${e.swipeIndex}</em>
                        ${e.isCurrentSwipe ? '<em class="copilot-badge" title="This record belongs to the swipe currently shown in the chat.">current swipe</em>' : ''}
                        ${e.entriesIdx === latestIdx && latestAt > 0 ? '<em class="copilot-badge copilot-badge-latest" title="The most recently injected note in this chat.">last injected note</em>' : ''}
                        ${rec.composer?.edited ? '<em class="copilot-badge" title="The note was hand-edited in this panel.">note edited</em>' : ''}
                        ${rec.extraction?.edited ? '<em class="copilot-badge" title="The extraction was hand-edited in this panel.">extraction edited</em>' : ''}
                        ${stale ? `<em class="copilot-warn" title="The extraction changed after this note was written, so the note may not match it any more.">⚠ ${escapeHtml(rec.composer.staleReason ?? 'extraction changed, may not match')}</em>` : ''}
                    </summary>
                        <details class="copilot-fold"><summary>extraction</summary>
                            <label title="The exact prompt text the extractor model received.">input</label>
                            <pre>${escapeHtml(String(tr.extractorIn ?? noInput))}</pre>
                            <label title="The durable facts the extractor recorded from this turn. Editing it flags the note as possibly stale.">output</label>
                            <textarea data-field="extraction" rows="3" title="Extracted facts for this turn. Edit and press Save extraction to keep the change.">${escapeHtml(rec.extraction?.text ?? '')}</textarea>
                            <button type="button" data-act="save-extraction" title="Store this edited extraction. The matching note is flagged as possibly stale.">Save extraction</button>
                        </details>
                        <details class="copilot-fold"><summary>composer</summary>
                            <label title="The exact prompt text the composer model received.">input</label>
                            <pre>${escapeHtml(String(tr.composerIn ?? noInput))}</pre>
                            <label title="The &lt;copilot&gt; guidance note that was injected into the narrator's prompt for this turn.">output</label>
                            <textarea data-field="composer" rows="3" title="The guidance note written by the composer. Edit and press Save note to keep the change.">${escapeHtml(rec.composer?.text ?? '')}</textarea>
                            <button type="button" data-act="save-note" title="Store this edited note. Nothing already sent to the model changes.">Save note</button>
                        </details>
                </details>`;
            };
            recordsEl.innerHTML = sizeLine + [...byMessage.entries()].map(([mi, swipes]) => {
                return `
                <div class="copilot-record" data-msg="${mi}">
                    <details><summary title="Stored copilot records for message ${mi} — one fold per swipe. Click to open."><strong>message ${mi}</strong>
                        <em class="copilot-badge">${swipes.length} swipe${swipes.length === 1 ? '' : 's'}</em>
                    </summary>
                        ${swipes.map((e) => swipeFold({ ...e, entriesIdx: entries.indexOf(e) })).join('')}
                    </details>
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
        // T-R5-23: dump every record in the chat to the clipboard.
        if (btn.dataset.act === 'copy-records') {
            (async () => {
                try {
                    await navigator.clipboard.writeText(recordsDump());
                    log.info('panel', 'records copied to the clipboard (one block per message, one per swipe)');
                } catch (err) {
                    log.error('panel', `clipboard blocked: ${redact(String((err && err.message) || err))}`);
                }
                render();
            })();
            return;
        }
        // T-R4-10: the swipe fold carries the coordinates now (swipes live
        // inside their message fold).
        const card = btn.closest('.copilot-swipe[data-mi][data-si]');
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
            // I7 (critique finding 11): the COPY payload is the audit artifact —
            // it must not clip ("exactly what was sent"). The panel display keeps
            // its 400-char preview; the copy is effectively unclipped.
            await navigator.clipboard.writeText(log.toText({ maxPerLine: 250000 }));
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
        renderPilot();
        render();
    });
    log.subscribe(() => {
        render();
        renderPilot();
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
    renderPilot();
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
        refreshSecretKey(); // R2-8: pick up secret-store changes (fire-and-forget)
        return onGenerationStarted(type, opts ?? {}, dryRun === true);
    });
    es.on(EVENT.CHAT_COMPLETION_PROMPT_READY, (data) => onPromptReady(data, EVENT.CHAT_COMPLETION_PROMPT_READY));
    es.on(EVENT.GENERATE_AFTER_COMBINE_PROMPTS, (data) => onPromptReady(data, EVENT.GENERATE_AFTER_COMBINE_PROMPTS));
    es.on(EVENT.MESSAGE_RECEIVED, () => onMessageReceived());
    es.on(EVENT.CHAT_CHANGED, (chatId) => onChatChanged(chatId));
    es.on(EVENT.WORLD_INFO_ACTIVATED, (entries) => onWorldInfoActivated(entries));
    // R3-F6/F15 (and m4): a turn can end WITHOUT MESSAGE_RECEIVED (aborts;
    // onErrorStreaming deliberately skips it for some types). The latch must
    // not stick at 'real' — a raw call in that window passed the rule-5 gate —
    // and the registered note must not leak into quiet generations between
    // turns. Note: NO clearPending here — the reply may not have bound yet.
    const finishTurn = (what) => {
        generationKind = 'none';
        clearNote();
        log.info('generation', `${what} — turn latch reset, registered note cleared`);
    };
    es.on(EVENT.GENERATION_STOPPED, () => finishTurn('generation stopped'));
    es.on(EVENT.GENERATION_ENDED, () => finishTurn('generation ended'));
    // R3-F5: when a message carrying a record is DELETED outside a regenerate
    // (group flows, tool calls), the reply-slot record dies with it. The
    // recovery mirror (lastBoundRecord) is re-checked at every GENERATION_STARTED.
    es.on(EVENT.MESSAGE_DELETED, () => {
        log.info('store', 'message deleted — the last-bound mirror will recover its record if the next turn needs it');
    });
    // T-R4-10 (user report): swiping BACK to an earlier swipe happens without a
    // generation, so nothing re-rendered and the "current swipe" badge stayed
    // on the last-rendered swipe ("swiped 4 times and returned to swipe 2 — the
    // current swipe will still be on swipe 4"). These log lines both record the
    // event and drive the panel's re-render through the log subscriber.
    es.on(EVENT.MESSAGE_SWIPED, () => {
        log.info('store', 'swipe changed — records view refreshed for the current swipe');
    });
    es.on(EVENT.MESSAGE_EDITED, () => {
        log.info('store', 'message edited — records view refreshed');
    });

    installWatcher();
    installPanel();
    // R2-8: seed the ST-secret cache at boot. When it settles, log WHERE the
    // key came from (never the key) — this line is also what re-renders the
    // pilot light, which otherwise could stay on its boot-time state until the
    // next turn.
    refreshSecretKey().then(() => {
        // T-R4-2: say the disabled state LOUDLY at boot — the extension being
        // off is the one state where the key is never used at all.
        if (settings().enabled === false) {
            log.warn('boot', "copilot is DISABLED in its settings — nothing will run and no key will be used. Click the pilot lamp or press 'Enable copilot' in the panel.");
        }
        const src = apiKeySource();
        log.info('boot', src
            ? `API key resolved from ${src === 'panel' ? 'the panel field' : "ST's OpenRouter secret"}`
            : `no API key resolved yet — ${apiKeyProblem()}`);
    });

    // Exposed for the T3 driver and for the user in the console. Never holds a
    // secret: the settings VIEW redacts the key (F14 — it used to return the
    // plaintext apiKey while this comment claimed otherwise), and apiKey() is
    // a function, not a value.
    window.copilot = {
        log, settings: () => ({ ...settings(), apiKey: settings().apiKey ? '[redacted]' : '' }),
        saveSettings, BUILD_ID, runs: [],
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