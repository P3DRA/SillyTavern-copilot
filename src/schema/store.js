/**
 * Where copilot data physically lives, and how it is read and written safely.
 *
 * PLACEMENT (GOAL.md §5): per-swipe, with the swipe, in the message's extra data.
 *
 *     message N
 *     └── extra.copilot = { version, swipes: [ SwipeRecord, … ] }
 *                                      ▲ index-aligned with message.swipes
 *
 * Why a parallel array indexed by swipe index:
 *   - `message.swipes[i]` is the text of swipe i and `message.swipe_id` is the
 *     current one. Both are first-class in ST and both are persisted.
 *   - The array only ever grows by appending (swipe) and shrinks only when the
 *     whole message is deleted. It never reorders, so index alignment holds.
 *   - If it ever does not hold, `readSwipeRecord` returns an empty record
 *     ("no data"), which is I6's required degradation — never a throw.
 *
 * Crucially this removes the entire bug class that killed the previous build:
 * there is no separate "slot" counter, no version counter, and no turn/slot
 * arithmetic to get wrong. The note for a generation is stored in the very
 * record that will hold that generation's text. One writer, one source of
 * truth (GOAL.md §12 trap 15).
 *
 * Pure module: takes a message object, mutates that object, calls an injected
 * `markDirty`. No ST imports, so all of it is unit-testable in Node.
 */

import {
    SCHEMA_VERSION, makeSwipeRecord, coerceSwipeRecord, emptySwipeRecord, isSwipeRecord, isCompressedAway,
} from './records.js';

export const ROOT_KEY = 'copilot';

/** Never mutate a frozen/non-object message. */
function isPlainObject(v) {
    return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The per-message container, created on demand.
 * Never throws: a frozen or exotic message yields a detached empty state that
 * the caller can use as a scratch record (I6).
 * @param {object} message
 * @returns {{version: number, swipes: object[]}}
 */
export function getMessageState(message) {
    const empty = { version: SCHEMA_VERSION, swipes: [] };
    if (!isPlainObject(message) || !Object.isExtensible(message)) {
        return empty;
    }
    try {
        if (!isPlainObject(message.extra)) {
            message.extra = {};
        }
        const root = message.extra[ROOT_KEY];
        if (!isPlainObject(root)) {
            message.extra[ROOT_KEY] = empty;
            return empty;
        }
        if (!Array.isArray(root.swipes)) {
            root.swipes = [];
        }
        if (!Number.isInteger(root.version)) {
            root.version = SCHEMA_VERSION;
        }
        return root;
    } catch {
        // Frozen `extra`, a getter that throws, a Proxy — none of these may
        // take the narrator's generation down with them (trap 11 / I5).
        return empty;
    }
}

/** True when this message has any copilot data at all. @param {object} message */
export function hasCopilotData(message) {
    if (!isPlainObject(message)) {
        return false;
    }
    const root = message.extra?.[ROOT_KEY];
    return isPlainObject(root) && Array.isArray(root.swipes) && root.swipes.some((s) => isSwipeRecord(s));
}

/**
 * Read the record for one swipe. Always returns a usable record.
 *
 * When the slot holds data, the returned object IS the stored object — normalised
 * in place, not copied. Writing through it therefore persists. Returning a copy
 * here is the exact footgun GOAL.md §12 trap 15 describes: a caller mutates a
 * "read" result, the write vanishes, and two code paths each believe they own
 * the value.
 *
 * When the slot is absent or corrupt, a detached empty record is returned and
 * nothing is written — reading never creates data (I6).
 *
 * @param {object} message
 * @param {number} swipeIndex
 * @returns {import('./records.js').SwipeRecord}
 */
export function readSwipeRecord(message, swipeIndex) {
    if (!Number.isInteger(swipeIndex) || swipeIndex < 0) {
        return emptySwipeRecord();
    }
    // Peek WITHOUT allocating: a read must not leave `extra.copilot` behind on a
    // message that never had copilot data, or `hasCopilotData` semantics and the
    // chat file both acquire phantom keys.
    const raw = isPlainObject(message) ? message.extra?.[ROOT_KEY]?.swipes?.[swipeIndex] : undefined;
    if (!isSwipeRecord(raw)) {
        return emptySwipeRecord();
    }
    const normalised = coerceSwipeRecord(raw);
    // Normalise into the stored object so the caller's reference is the truth.
    for (const key of Object.keys(raw)) {
        if (!(key in normalised)) {
            delete raw[key];
        }
    }
    Object.assign(raw, normalised);
    return raw;
}

/**
 * Create the slot if needed and return it (live reference — mutating it mutates
 * the stored record, which is what callers want during a generation).
 * @param {object} message
 * @param {number} swipeIndex
 * @returns {import('./records.js').SwipeRecord}
 */
export function ensureSwipeRecord(message, swipeIndex) {
    const state = getMessageState(message);
    while (state.swipes.length <= swipeIndex) {
        // Sparse holes would break index alignment with message.swipes.
        state.swipes.push(null);
    }
    if (!isSwipeRecord(state.swipes[swipeIndex])) {
        state.swipes[swipeIndex] = makeSwipeRecord({});
    } else {
        state.swipes[swipeIndex] = coerceSwipeRecord(state.swipes[swipeIndex]);
    }
    return state.swipes[swipeIndex];
}

/**
 * Write a record into a swipe slot.
 *
 * I1/I8: this never removes data. Writing an "empty" record replaces only the
 * fields it carries; fields it omits are preserved. To clear a field, clear it
 * in the record object first.
 *
 * @param {object} message
 * @param {number} swipeIndex
 * @param {Partial<import('./records.js').SwipeRecord>} patch
 * @returns {import('./records.js').SwipeRecord}
 */
export function writeSwipeRecord(message, swipeIndex, patch) {
    const existing = readSwipeRecord(message, swipeIndex);
    const merged = {
        ...existing,
        ...patch,
        version: SCHEMA_VERSION,
    };
    const target = ensureSwipeRecord(message, swipeIndex);
    Object.assign(target, merged);
    return target;
}

/**
 * Every record in the chat, paired with where it lives.
 * @param {object[]} chat
 * @returns {Array<{messageIndex: number, swipeIndex: number, record: object, isCurrentSwipe: boolean}>}
 */
export function listRecords(chat) {
    if (!Array.isArray(chat)) {
        return [];
    }
    const out = [];
    for (let mi = 0; mi < chat.length; mi += 1) {
        const msg = chat[mi];
        if (!hasCopilotData(msg)) {
            continue;
        }
        const current = Number.isInteger(msg.swipe_id) ? msg.swipe_id : 0;
        const swipes = msg.extra?.[ROOT_KEY]?.swipes ?? [];
        for (let si = 0; si < swipes.length; si += 1) {
            if (!isSwipeRecord(swipes[si])) {
                continue;
            }
            out.push({
                messageIndex: mi,
                swipeIndex: si,
                record: coerceSwipeRecord(swipes[si]),
                isCurrentSwipe: si === current,
            });
        }
    }
    return out;
}

/**
 * All extractions the composer may read, oldest first, for a chat prefix.
 *
 * Sources are the messages UP TO AND INCLUDING `upToMessageIndex`; nothing after
 * it is visible. This is what makes GOAL.md §10.3 S8 (fork at N) correct by
 * construction rather than by a test that has to remember the rule.
 *
 * I2: extraction records that have been merged into another (`compressedInto`)
 * are excluded here and ONLY here. They remain in `listRecords` and on disk.
 *
 * @param {object[]} chat
 * @param {{upToMessageIndex?: number, excludeSwipeAt?: {messageIndex: number, swipeIndex: number}}} [opts]
 * @returns {Array<{extraction: object, messageIndex: number, swipeIndex: number}>}
 */
export function collectExtractions(chat, opts = {}) {
    const limit = Number.isInteger(opts.upToMessageIndex) ? opts.upToMessageIndex : (chat?.length ?? 0) - 1;
    const out = [];
    for (const entry of listRecords(chat)) {
        if (entry.messageIndex > limit) {
            continue;
        }
        if (opts.excludeSwipeAt
            && entry.messageIndex === opts.excludeSwipeAt.messageIndex
            && entry.swipeIndex === opts.excludeSwipeAt.swipeIndex) {
            continue;
        }
        if (entry.record.extraction && !isCompressedAway(entry.record.extraction)) {
            out.push({
                extraction: entry.record.extraction,
                messageIndex: entry.messageIndex,
                swipeIndex: entry.swipeIndex,
            });
        }
    }
    out.sort((a, b) => a.extraction.createdAt - b.extraction.createdAt || a.messageIndex - b.messageIndex);
    return out;
}

/**
 * Guard against a stale in-flight generation writing into the wrong place
 * (GOAL.md §12 trap 6: a note composed at message 14 must never appear at 7).
 * @param {{messageIndex: number, swipeIndex: number}} a
 * @param {{messageIndex: number, swipeIndex: number}} b
 */
export function sameSlot(a, b) {
    return Boolean(a) && Boolean(b)
        && a.messageIndex === b.messageIndex
        && a.swipeIndex === b.swipeIndex;
}

/* --------------------------------------------------------------- integrity */

/**
 * I3 snapshot: deep copy of every copilot record in a chat.
 * Kept for snapshot/restore and for the S8 fork assertion.
 * @param {object[]} chat
 */
export function snapshotChat(chat) {
    try {
        const out = [];
        for (let mi = 0; mi < (chat?.length ?? 0); mi += 1) {
            const msg = chat[mi];
            if (!hasCopilotData(msg)) {
                continue;
            }
            out.push({
                messageIndex: mi,
                state: JSON.parse(JSON.stringify(msg.extra[ROOT_KEY])),
            });
        }
        return { version: SCHEMA_VERSION, messages: out };
    } catch {
        return { version: SCHEMA_VERSION, messages: [] };
    }
}

/**
 * Restore a snapshot EXACTLY (GOAL.md §10.7 step 2: byte-identical to before).
 *
 * Restoring clears copilot data from messages that the snapshot does not
 * mention — that is what "exact state" means, and skipping it is how a restore
 * silently leaves post-snapshot data behind.
 *
 * @param {object[]} chat
 * @param {{version: number, messages: Array<{messageIndex: number, state: object}>}} snap
 */
export function restoreChat(chat, snap) {
    if (!Array.isArray(chat) || !snap || !Array.isArray(snap.messages)) {
        return 0;
    }
    const wanted = new Set(snap.messages.map((m) => m.messageIndex));
    let touched = 0;
    for (let mi = 0; mi < chat.length; mi += 1) {
        const msg = chat[mi];
        if (!wanted.has(mi)) {
            if (hasCopilotData(msg)) {
                delete msg.extra[ROOT_KEY];
                touched += 1;
            }
            continue;
        }
        const entry = snap.messages.find((m) => m.messageIndex === mi);
        if (!msg || typeof msg !== 'object') {
            continue;
        }
        if (!msg.extra || typeof msg.extra !== 'object') {
            msg.extra = {};
        }
        msg.extra[ROOT_KEY] = JSON.parse(JSON.stringify(entry.state));
        touched += 1;
    }
    return touched;
}

/**
 * Diagnostics for the debug panel: data that does not line up with its swipe.
 * Reported, never auto-deleted (I1).
 * @param {object[]} chat
 */
export function audit(chat) {
    const issues = [];
    for (let mi = 0; mi < (chat?.length ?? 0); mi += 1) {
        const msg = chat[mi];
        if (!hasCopilotData(msg)) {
            continue;
        }
        const stored = msg.extra[ROOT_KEY].swipes.length;
        const live = Array.isArray(msg.swipes) ? msg.swipes.length : 0;
        if (stored > live && !(live === 0 && stored === 1)) {
            issues.push({ messageIndex: mi, kind: 'orphan-swipes', stored, live });
        }
        if (Number.isInteger(msg.swipe_id) && msg.swipe_id >= Math.max(stored, 1)) {
            issues.push({ messageIndex: mi, kind: 'swipe-id-past-data', swipeId: msg.swipe_id, stored });
        }
    }
    return issues;
}