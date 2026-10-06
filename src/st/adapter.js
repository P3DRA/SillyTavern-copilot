/**
 * The SillyTavern adapter.
 *
 * Everything that touches SillyTavern lives here, so `src/core/` stays host-free
 * and testable. This module is the ONLY place allowed to call `getContext()`,
 * `setExtensionPrompt`, `eventSource` or `chat`.
 *
 * THE ONE FACT THAT SHAPES ALL OF THIS
 *
 * Verified in phase 0 by hand through `public/script.js`: there is NO assistant
 * placeholder in `chat` before the response arrives. `chat.push()` happens at
 * `:5855` (the user message), `:6685` (the assistant message, inside `saveReply`,
 * AFTER the response) and `:7631` (import).
 *
 * So at prompt time the array ends with the USER message, and the reply will
 * land at `chat.length`. The previous build asked whether its note was filed "at
 * the slot being written", found no such slot, and declined to inject anything
 * on seven consecutive turns (PROBLEMS.md §1).
 *
 * Here, the note for a turn is composed against a predicted index and bound to
 * the real message once `saveReply` creates it. The store has no idea this
 * happened: it just gets the message and the swipe index.
 */

import { EVENT, PROMPT_TYPE, PROMPT_ROLE, INJECT_KEY, MAX_INJECTION_DEPTH } from '../st/constants.js';
import { writeSwipeRecord, readSwipeRecord, hasCopilotData } from '../schema/store.js';
import { wrapNote } from '../core/pipeline.js';
import { SKIP } from '../core/debug-log.js';

/* ------------------------------------------------------------------ context */

/**
 * Always call this fresh. Never cache the result (trap 1).
 *
 * `getContext` is NOT on `window`. SillyTavern publishes it as
 * `globalThis.SillyTavern.getContext` (`public/script.js:292-295`). The first
 * live browser test failed because this returned `{}` and `init()` bailed
 * silently — a bug no harness could have found, because it only exists in a real
 * page. `tests/t1b/st-constants.test.mjs` pins the declaration so it cannot
 * regress quietly.
 */
export function ctx() {
    return globalThis.SillyTavern?.getContext?.() ?? globalThis.getContext?.() ?? {};
}

export function chat() {
    return ctx().chat ?? [];
}

export function chatMetadata() {
    return ctx().chatMetadata ?? {};
}

export function saveMetadata() {
    return ctx().saveMetadata?.();
}

export function eventSource() {
    return ctx().eventSource;
}

export function setExtensionPrompt(key, value, position, depth, scan, role) {
    return ctx().setExtensionPrompt?.(key, value, position, depth, scan, role);
}

export function saveChatConditional() {
    return ctx().saveChatConditional?.();
}

/* ------------------------------------------------------- generation tokens */

/**
 * A monotonically increasing token, bumped on every GENERATION_STARTED.
 *
 * TRAP 7: a module-global promise awaited by the wrong generation. Every async
 * continuation checks that its token is still the current one before it writes
 * anything, and everything is cleared on chat change.
 */
let currentToken = 0;

export function nextToken() {
    currentToken += 1;
    return currentToken;
}

export function isCurrent(token) {
    return token === currentToken;
}

export function currentTokenValue() {
    return currentToken;
}

export function resetTokens() {
    currentToken = 0;
}

/* ------------------------------------------------------------ pending notes */

/**
 * Notes waiting for the message that will hold them.
 *
 * Keyed by nothing at all beyond the token: there is exactly ONE pending note
 * at a time, and it belongs to the generation in flight. That is deliberate.
 * The old design had a note store indexed by slot and version, and the
 * ambiguity between "the slot being written" and "the slot the note is filed at"
 * is what destroyed it (trap 15).
 *
 * @type {{token: number, note: string, noteHash: string|null, position: string,
 *          goalIds: string[], requestIds: string[], extraction: object|null,
 *          composer: object|null, createdAt: number}|null}
 */
let pending = null;

export function setPending(note, meta = {}) {
    pending = {
        token: currentToken,
        note,
        noteHash: meta.noteHash ?? null,
        position: meta.position ?? 'end',
        goalIds: meta.goalIds ?? [],
        requestIds: meta.requestIds ?? [],
        // The pipeline's own records ride along so all three outputs
        // (extraction, composer, injection) can be saved on the swipe —
        // the phase-1 done-when requires exactly that.
        extraction: meta.extraction ?? null,
        composer: meta.composer ?? null,
        // R2-6 (I7): a bounded trace of the turn's inputs/outputs rides the
        // record so the audit trail survives RELOADS (the DebugLog is RAM-only
        // and evicts at MAX_TURNS). Truncation is marked, never silent.
        trace: meta.trace ?? null,
        createdAt: Date.now(),
    };
    return pending;
}

export function getPending() {
    return pending;
}

/**
 * Take the pending note, but ONLY if it belongs to the current generation.
 *
 * Trap 6 in one line: a note composed at message 14 must never be written to
 * message 7 after a rewind or a fork.
 */
export function takePending(token = currentToken) {
    if (!pending || pending.token !== token) {
        return null;
    }
    const taken = pending;
    pending = null;
    return taken;
}

export function clearPending(reason) {
    const had = pending !== null || pendingSkip !== null;
    pending = null;
    pendingSkip = null;
    return had ? reason : null;
}

/**
 * Skips waiting for the message that will hold their reason.
 *
 * F1 (critique round 1): a skip on an ORDINARY turn happens while the last
 * message is still the USER's — there is no reply slot to write to yet. The
 * skip is forward-referenced exactly like the note and written at
 * MESSAGE_RECEIVED, so the reason AND the extractor's output survive (I1,
 * trap 14). Before this, every ordinary-turn failure silently destroyed both.
 */
let pendingSkip = null;

export function setPendingSkip(reason, detail = '', token = currentToken, extraction = null) {
    pendingSkip = {
        token,
        reason,
        detail: detail ?? '',
        extraction: extraction ?? null,
        createdAt: Date.now(),
    };
    return pendingSkip;
}

export function takePendingSkip(token = currentToken) {
    if (!pendingSkip || pendingSkip.token !== token) {
        return null;
    }
    const taken = pendingSkip;
    pendingSkip = null;
    return taken;
}

/** Non-destructive: is a skip waiting for this generation's reply? */
export function hasPendingSkip(token = currentToken) {
    return Boolean(pendingSkip && pendingSkip.token === token);
}

/* ---------------------------------------------------------------- injection */

/**
 * Publish a note into SillyTavern's extension-prompt registry.
 *
 * G1 chose "register-then-assemble": the registry is read while the prompt is
 * BEING ASSEMBLED, which is before the awaited prompt-ready hooks fire, so this
 * is the route that gives GOAL.md §6's configurable injection position real
 * meaning on chat completions.
 *
 * @param {string} note
 * @param {{position?: string, depth?: number, role?: number}} [opts]
 */
export function registerNote(note, opts = {}) {
    const body = wrapNote(note);
    if (body === '') {
        return false;
    }
    const position = opts.position ?? 'in_chat';
    const depth = Number.isFinite(opts.depth) ? Math.min(opts.depth, MAX_INJECTION_DEPTH) : 0;
    const role = opts.role ?? PROMPT_ROLE.SYSTEM;

    setExtensionPrompt(
        INJECT_KEY.NOTE,
        body,
        position === 'in_prompt' ? PROMPT_TYPE.IN_PROMPT : (position === 'none' ? PROMPT_TYPE.NONE : PROMPT_TYPE.IN_CHAT),
        depth,
        false,
        role,
    );
    return true;
}

/** Remove our note from the registry. Called at the start of every turn. */
export function clearNote() {
    setExtensionPrompt(INJECT_KEY.NOTE, '', PROMPT_TYPE.NONE, 0);
}

/* ------------------------------------------------------------ binding a note */

/**
 * Write the note's records onto the message that now holds the reply.
 *
 * Called from MESSAGE_RECEIVED, which is AFTER `saveReply` pushed the message —
 * so `chat[chat.length - 1]` is the reply this note was written for.
 *
 * @param {number} token
 * @returns {{bound: boolean, messageIndex: number, swipeIndex: number, reason: string|null}}
 */
export function bindToMessage(token) {
    const note = takePending(token);
    const skip = takePendingSkip(token);
    if (!note && !skip) {
        return { bound: false, messageIndex: -1, swipeIndex: -1, reason: SKIP.STALE_GENERATION };
    }
    const list = chat();
    if (!Array.isArray(list) || list.length === 0 || list[list.length - 1]?.is_user) {
        // T-R2-6 (I1, trap 14): taken data must NEVER leave without a write.
        // MESSAGE_RECEIVED fires from several branches (script.js:6632/6657/
        // 6679/6722 + 'first_message'); any that lands with a user message last
        // used to silently destroy the turn's note AND extraction. Re-arm both.
        const salvage = note?.extraction ?? skip?.extraction ?? null;
        if (note) {
            setPending(note.note, {
                noteHash: note.noteHash,
                position: note.position,
                injected: note.injected,
                extraction: note.extraction,
                composer: note.composer,
                goalIds: note.goalIds,
                requestIds: note.requestIds,
            });
        }
        if (skip || salvage) {
            setPendingSkip(SKIP.SLOT_MISMATCH, 'the arriving message was not an assistant reply', token, salvage);
        }
        return { bound: false, messageIndex: list.length - 1, swipeIndex: -1, reason: SKIP.SLOT_MISMATCH, reArmed: true };
    }
    const messageIndex = list.length - 1;
    const message = list[messageIndex];
    // ST sets swipe_id before generating, so this is the slot being written.
    const swipeIndex = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;

    if (!note) {
        // A failed or suppressed turn (F1): the reply arrives with NO note, but
        // the reason and the extractor's output belong on it (I1, trap 14).
        writeSwipeRecord(message, swipeIndex, {
            ...(skip.extraction ? { extraction: skip.extraction } : {}),
            injection: {
                injected: false,
                position: 'none',
                finalPromptRef: { messageIndex, swipeIndex, at: Date.now() },
                goalsActive: [],
                userRequestsActive: [],
                skipReason: skip.reason,
            },
        });
        return { bound: true, messageIndex, swipeIndex, reason: null, skipped: true };
    }

    // All three pipeline outputs land on this swipe: the extraction (absent
    // when the turn reused a note without one — R2-19: a fabricated empty
    // extraction is a provenance lie), the composer record and the injection
    // record. `injected` reflects the ACTUAL splice (R2-9: position 'none'
    // means log-only and must not claim script-verified injection).
    writeSwipeRecord(message, swipeIndex, {
        ...(note.extraction ? { extraction: note.extraction } : {}),
        composer: note.composer
            ? { ...note.composer, text: note.composer.text || note.note }
            : {
                text: note.note,
                model: note.model ?? '',
                tokensIn: note.tokensIn ?? 0,
                tokensOut: note.tokensOut ?? 0,
                createdAt: note.createdAt ?? Date.now(),
                staleFlag: false,
                edited: false,
            },
        ...(note.trace ? { trace: note.trace } : {}),
        injection: {
            injected: note.injected !== false,
            position: note.position,
            finalPromptRef: { messageIndex, swipeIndex, at: Date.now() },
            goalsActive: note.goalIds,
            userRequestsActive: note.requestIds,
            injectedAt: Date.now(),
            noteChars: note.note.length,
            noteHash: note.noteHash,
        },
    });
    return { bound: true, messageIndex, swipeIndex, reason: null };
}

/**
 * Record that we did NOT inject, and why (trap 14).
 * "No injection, no log" is undiagnosable.
 *
 * @param {object} log
 * @param {string} reason One of SKIP.
 * @param {string} [detail]
 * @param {number} [token]
 * @param {object|null} [extraction] I1: even a failed turn stores what the
 *   extractor produced — nothing an automatic operation produced is dropped.
 */
export function recordSkip(log, reason, detail = '', token = currentToken, extraction = null) {
    const taken = takePending(token);
    const list = chat();
    const messageIndex = list.length - 1;
    const message = list[messageIndex];
    if (message && !message.is_user) {
        const swipeIndex = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
        // T-R2-11: fold the pending note's extraction exactly like the
        // forward-reference path — the two paths used to disagree and the
        // immediate one dropped it silently.
        const ext = extraction ?? taken?.extraction ?? null;
        writeSwipeRecord(message, swipeIndex, {
            ...(ext ? { extraction: ext } : {}),
            injection: {
                injected: false,
                position: 'none',
                finalPromptRef: { messageIndex, swipeIndex, at: Date.now() },
                goalsActive: [],
                userRequestsActive: [],
                skipReason: reason,
            },
        });
        log?.warn('inject-skipped', `${reason}${detail ? ` — ${detail}` : ''}`);
        return reason;
    }
    // F1: on an ORDINARY turn the last message is the USER's — the reply slot
    // does not exist yet. Forward-reference the skip exactly like the note; it
    // is written at MESSAGE_RECEIVED (bindToMessage). Before this fix, every
    // ordinary-turn failure silently destroyed the reason AND the extraction.
    setPendingSkip(reason, detail, token, extraction ?? taken?.extraction ?? null);
    log?.warn('inject-skipped', `${reason}${detail ? ` — ${detail}` : ''} (record binds when the reply lands)`);
    return reason;
}

export { hasCopilotData, readSwipeRecord };