/**
 * Where copilot data physically lives, and how it is read and written safely.
 *
 * PLACEMENT (GOAL.md §5, slot verified in §7):
 * copilot data is stored per swipe, with the swipe, in the message's per-swipe
 * extra data. That slot is `swipe_info[i].extra`:
 *
 *     message N
 *     ├── swipes[i]                 ← SillyTavern: the text of swipe i
 *     ├── swipe_id                  ← SillyTavern: which swipe is current
 *     ├── swipe_info[i].extra       ← SillyTavern: PER-SWIPE extra  (ours lives here)
 *     │   └── copilot               ← OURS, authoritative
 *     └── extra                     ← SillyTavern: MIRROR of swipe_info[swipe_id].extra
 *         └── copilot               ← ours, kept in step so ST's own sync is harmless
 *
 * Why `swipe_info[i].extra` and NOT a sibling array under `message.extra`:
 *
 * `message.extra` is not a stable container. SillyTavern treats it as a mirror
 * of the current swipe's extra and replaces it wholesale, by deep clone, on
 * every swipe navigation:
 *
 *     public/script.js:6956   targetMessage.extra = structuredClone(targetSwipeInfo?.extra) ?? {};
 *
 * A sibling array such as `message.extra.copilot.swipes[i]` therefore lives
 * *inside the object that gets thrown away* and would vanish the first time the
 * user swiped — silently, and with no error anywhere. The per-swipe slot that
 * actually survives is `swipe_info[i].extra`, and ST maintains the mirror for us
 * in both directions (`syncMesToSwipe` pushes `message.extra` down at
 * script.js:6880; `syncSwipeToMes` pulls it back at script.js:6956).
 *
 * THE TWO HARD RULES THAT FOLLOW
 *
 * 1. NEVER cache a reference to `message.extra` (or to any object under it).
 *    Every sync replaces it with a fresh clone, so a held reference is detached
 *    and writes to it vanish. Always reach through `message` fresh.
 *
 * 2. Write the authoritative copy to `swipe_info[i].extra.copilot`, and mirror
 *    it into `message.extra.copilot` only when `i === message.swipe_id`.
 *    Then ST's own push copies the same data back onto the same slot, so the
 *    round trip is a no-op instead of a clobber.
 *
 * Pure module: takes a message object, mutates that object, no ST imports, so
 * every rule above is unit-testable in Node.
 */

import {
    SCHEMA_VERSION, makeSwipeRecord, coerceSwipeRecord, emptySwipeRecord, isSwipeRecord, isCompressedAway,
} from './records.js';

export const ROOT_KEY = 'copilot';

function isPlainObject(v) {
    return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Read (without creating) the copilot root for one swipe.
 * @param {object} message
 * @param {number} swipeIndex
 * @returns {{version: number}|null} null when there is no data for that swipe.
 */
export function peekSwipeRoot(message, swipeIndex) {
    if (!isPlainObject(message) || !Number.isInteger(swipeIndex) || swipeIndex < 0) {
        return null;
    }
    const extra = message.swipe_info?.[swipeIndex]?.extra;
    if (!isPlainObject(extra)) {
        return null;
    }
    const root = extra[ROOT_KEY];
    return isPlainObject(root) ? root : null;
}

/**
 * Create and return the copilot root for one swipe, creating `swipe_info` and the
 * enclosing `extra` bag as needed. Never throws (I6, trap 11).
 *
 * @param {object} message
 * @param {number} swipeIndex
 * @returns {{version: number, record: import('./records.js').SwipeRecord}}
 */
function ensureSwipeRoot(message, swipeIndex) {
    const detached = { version: SCHEMA_VERSION, record: emptySwipeRecord() };
    if (!isPlainObject(message) || !Object.isExtensible(message) || !Number.isInteger(swipeIndex) || swipeIndex < 0) {
        return detached;
    }
    try {
        if (!Array.isArray(message.swipe_info)) {
            // Backfill the way ST's own `ensureSwipes` would (script.js:6809-6812),
            // one entry per existing swipe, so indices line up with `swipes`.
            const swipeCount = Array.isArray(message.swipes) ? message.swipes.length : 0;
            message.swipe_info = Array.from({ length: Math.max(swipeCount, 1) }, () => ({
                send_date: message.send_date,
                gen_started: message.gen_started,
                gen_finished: message.gen_finished,
                extra: {},
            }));
        }
        while (message.swipe_info.length <= swipeIndex) {
            message.swipe_info.push({ send_date: message.send_date, extra: {} });
        }
        const info = message.swipe_info[swipeIndex];
        if (!isPlainObject(info)) {
            message.swipe_info[swipeIndex] = { send_date: message.send_date, extra: {} };
        }
        if (!isPlainObject(message.swipe_info[swipeIndex].extra)) {
            message.swipe_info[swipeIndex].extra = {};
        }
        const infoExtra = message.swipe_info[swipeIndex].extra;
        if (!isPlainObject(infoExtra[ROOT_KEY])) {
            infoExtra[ROOT_KEY] = { version: SCHEMA_VERSION };
        }
        const root = infoExtra[ROOT_KEY];
        if (!Number.isInteger(root.version)) {
            root.version = SCHEMA_VERSION;
        }
        return { version: root.version, record: root };
    } catch {
        return detached;
    }
}

/** Mirror the current swipe's copilot root onto `message.extra`, where ST expects it. */
function mirrorToMessageExtra(message, swipeIndex, root) {
    if (!isPlainObject(message) || !Object.isExtensible(message)) {
        return;
    }
    if (message.swipe_id !== undefined && message.swipe_id !== swipeIndex) {
        // A KNOWN live swipe that differs: touching message.extra here would
        // publish another swipe's data as the current one — worse than nothing.
        return;
    }
    // swipe_id undefined means a generation in progress — saveReply assigns
    // swipe_id and then REBUILDS swipe_info[0] wholesale from message.extra
    // (script.js:6744-6749). Without the mirror here, the record written at
    // MESSAGE_RECEIVED is silently wiped moments later. The swipe being written
    // during a generation is the swipe that is about to become live, so this is
    // the current swipe by construction.
    try {
        if (!isPlainObject(message.extra)) {
            message.extra = {};
        }
        message.extra[ROOT_KEY] = structuredClone(root);
    } catch {
        /* the authoritative copy in swipe_info is what matters */
    }
}

/**
 * The SwipeRecord for one swipe, or null when there is none.
 * The returned object IS the stored object — normalise in place, never copy.
 * Writing through it therefore persists (GOAL.md §12 trap 15).
 *
 * @param {object} message
 * @param {number} swipeIndex
 * @returns {import('./records.js').SwipeRecord|null}
 */
export function readSwipeRecordOrNull(message, swipeIndex) {
    const root = peekSwipeRoot(message, swipeIndex);
    if (!root || !isSwipeRecord(root.record)) {
        return null;
    }
    const normalised = coerceSwipeRecord(root.record);
    // F8 (critique round 1): there used to be an unknown-key SWEEP here that
    // deleted every top-level field the current schema did not know — silently
    // destroying a record written by a newer build on every read (I1, and the
    // exact opposite of migrate.js's own rule "carry anything unknown through
    // untouched"). Unknown keys now ride along untouched; migration owns
    // normalisation.
    //
    // T-R2-12: and never NULL a field that is present — coerce drops objects
    // without a text key, and the assign used to overwrite them with null ON
    // READ (present-but-oddly-shaped still beats destroyed).
    for (const k of ['extraction', 'composer', 'injection']) {
        if (normalised[k] === null && root.record[k] !== undefined && root.record[k] !== null) {
            delete normalised[k];
        }
    }
    Object.assign(root.record, normalised);
    return root.record;
}

/**
 * Read the record for one swipe. Always returns a usable record; absent or
 * corrupt data degrades to "no data" (I6). Reading never creates anything.
 *
 * @param {object} message
 * @param {number} swipeIndex
 * @returns {import('./records.js').SwipeRecord}
 */
export function readSwipeRecord(message, swipeIndex) {
    const live = readSwipeRecordOrNull(message, swipeIndex);
    return live ?? emptySwipeRecord();
}

/** True when this message has any copilot data on any swipe. @param {object} message */
export function hasCopilotData(message) {
    if (!isPlainObject(message)) {
        return false;
    }
    const infos = Array.isArray(message.swipe_info) ? message.swipe_info : [];
    return infos.some((info) => isSwipeRecord(info?.extra?.[ROOT_KEY]?.record));
}

/**
 * Create the slot if needed and return the live record.
 *
 * If a record already exists it is returned UNCHANGED. Overwriting it with a
 * fresh empty record here would silently destroy every extraction and note the
 * moment anything was written twice — which is I1, the invariant this whole
 * project exists to keep.
 *
 * @param {object} message
 * @param {number} swipeIndex
 * @returns {import('./records.js').SwipeRecord}
 */
export function ensureSwipeRecord(message, swipeIndex) {
    const root = ensureSwipeRoot(message, swipeIndex);
    // readSwipeRecordOrNull normalises in place and returns the stored object,
    // so an existing record is returned live and untouched.
    const existing = readSwipeRecordOrNull(message, swipeIndex);
    if (existing) {
        mirrorToMessageExtra(message, swipeIndex, peekSwipeRoot(message, swipeIndex));
        return existing;
    }
    const created = makeSwipeRecord({});
    // `root` is detached when the message is not writable; assigning to it then
    // is harmless and the caller still gets a usable object.
    root.record.record = created;
    mirrorToMessageExtra(message, swipeIndex, peekSwipeRoot(message, swipeIndex));
    return created;
}

/**
 * Write a patch into a swipe slot.
 *
 * I1/I8: this never removes data it does not carry. Fields absent from the patch
 * keep their current value.
 *
 * @param {object} message
 * @param {number} swipeIndex
 * @param {Partial<import('./records.js').SwipeRecord>} patch
 * @returns {import('./records.js').SwipeRecord}
 */
export function writeSwipeRecord(message, swipeIndex, patch) {
    const target = ensureSwipeRecord(message, swipeIndex);
    // I1 (critique round 1, finding 5): replacing the DATA fields preserves the
    // old values in `history` — an append/continue turn reuses the same slot
    // and ST re-emits MESSAGE_RECEIVED, which used to DESTROY the previous
    // extraction/note/injection outright. Empty-patch writes (mirror refreshes)
    // and non-data fields never touch history, so undo stays byte-identical.
    const DATA_FIELDS = ['extraction', 'composer', 'injection'];
    const replacesData = Boolean(patch) && DATA_FIELDS.some((k) => patch[k] !== undefined);
    if (replacesData) {
        const snapshot = { at: Date.now() };
        let hadData = false;
        for (const k of DATA_FIELDS) {
            if (target[k] !== undefined && target[k] !== null) {
                snapshot[k] = JSON.parse(JSON.stringify(target[k]));
                hadData = true;
            }
        }
        if (hadData) {
            // T-R2-12: history copies must not balloon — attempts carry 2k-char
            // failure raws that would be re-copied on every same-slot rewrite.
            if (snapshot.composer && Array.isArray(snapshot.composer.attempts)) {
                snapshot.composer = {
                    ...snapshot.composer,
                    attempts: snapshot.composer.attempts.map((a) => ({ ...a, raw: undefined })),
                };
            }
            target.history = [...(Array.isArray(target.history) ? target.history : []), snapshot];
        }
    }
    // R2-25: never DOWNGRADE the schema version on write (migrate.js's rule) —
    // the stamp used to force SCHEMA_VERSION over a newer build's number.
    Object.assign(target, patch, { version: Math.max(Number(target.version) || 0, SCHEMA_VERSION) });
    mirrorToMessageExtra(message, swipeIndex, peekSwipeRoot(message, swipeIndex));
    return target;
}

/**
 * The authoritative copilot root for a swipe, for the mirror to read.
 * @param {object} message
 * @param {number} swipeIndex
 */
export function swipeRootFor(message, swipeIndex) {
    return peekSwipeRoot(message, swipeIndex);
}

/**
 * Every record in the chat, paired with where it lives.
 * @param {object[]} chat
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
        const infos = Array.isArray(msg.swipe_info) ? msg.swipe_info : [];
        for (let si = 0; si < infos.length; si += 1) {
            const rec = readSwipeRecordOrNull(msg, si);
            if (!rec) {
                continue;
            }
            out.push({
                messageIndex: mi,
                swipeIndex: si,
                record: rec,
                isCurrentSwipe: si === current,
            });
        }
    }
    return out;
}

/**
 * All extractions the composer may read, oldest first, for a chat prefix.
 *
 * - Nothing after `upToMessageIndex` is visible. This makes S8 (fork at N)
 *   correct by construction rather than by a test that has to remember the rule.
 * - I2: records merged into another (`compressedInto`) are excluded here and ONLY
 *   here. They remain in `listRecords` and on disk.
 *
 * @param {object[]} chat
 * @param {{upToMessageIndex?: number, excludeSwipeAt?: {messageIndex: number, swipeIndex: number}}} [opts]
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
        // The record's own extraction PLUS any merged (compressed) entries the
        // record carries in `extractions[]` — each hidden only when it was
        // itself merged away (I2).
        const all = [
            ...(entry.record.extraction ? [entry.record.extraction] : []),
            ...(Array.isArray(entry.record.extractions) ? entry.record.extractions.filter(Boolean) : []),
        ];
        for (const extraction of all) {
            if (!isCompressedAway(extraction)) {
                out.push({
                    extraction,
                    messageIndex: entry.messageIndex,
                    swipeIndex: entry.swipeIndex,
                });
            }
        }
    }
    out.sort((a, b) => a.extraction.createdAt - b.extraction.createdAt || a.messageIndex - b.messageIndex);
    return out;
}

/**
 * Append a MERGED extraction (a compression result) to a record's extra
 * extraction list. The record's own `extraction` slot is never touched — that
 * is why merged entries need their own list (I1/I2: compression creates new
 * records and destroys nothing).
 *
 * @param {object} message
 * @param {number} swipeIndex
 * @param {object} extraction A makeExtraction() record.
 * @returns {object|null} the live record, or null when not writable.
 */
export function appendExtraExtraction(message, swipeIndex, extraction) {
    const record = ensureSwipeRecord(message, swipeIndex);
    if (!Array.isArray(record.extractions)) {
        record.extractions = [];
    }
    record.extractions.push(extraction);
    mirrorToMessageExtra(message, swipeIndex, peekSwipeRoot(message, swipeIndex));
    return record;
}

/**
 * Remove a merged extraction by id (used by undo, which must restore the
 * previous state exactly).
 * @param {object} message
 * @param {number} swipeIndex
 * @param {string} extractionId
 */
export function removeExtraExtraction(message, swipeIndex, extractionId) {
    const record = readSwipeRecordOrNull(message, swipeIndex);
    if (!record || !Array.isArray(record.extractions)) {
        return false;
    }
    const before = record.extractions.length;
    record.extractions = record.extractions.filter((e) => e && e.id !== extractionId);
    if (record.extractions.length === before) {
        return false;
    }
    if (record.extractions.length === 0) {
        // Undo must restore the state BYTE-identically (I2) — an empty array
        // key left behind would still be a difference.
        delete record.extractions;
    }
    mirrorToMessageExtra(message, swipeIndex, peekSwipeRoot(message, swipeIndex));
    return true;
}

/**
 * Trap 6 guard: a note composed at message 14 must never be shown at message 7.
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
                swipeIds: msg.swipe_info
                    .map((info, si) => (isSwipeRecord(info?.extra?.[ROOT_KEY]?.record) ? si : -1))
                    .filter((si) => si >= 0),
                state: JSON.parse(JSON.stringify(
                    msg.swipe_info.map((info) => (isPlainObject(info?.extra?.[ROOT_KEY]) ? info.extra[ROOT_KEY] : null)),
                )),
            });
        }
        return { version: SCHEMA_VERSION, messages: out };
    } catch {
        return { version: SCHEMA_VERSION, messages: [] };
    }
}

/**
 * Restore a snapshot EXACTLY (GOAL.md §10.7 steps 2 and 6).
 *
 * Restoring clears copilot data from swipes the snapshot does not mention —
 * "exact state" means post-snapshot additions are gone too.
 *
 * @param {object[]} chat
 * @param {{version: number, messages: Array<{messageIndex: number, swipeIds: number[], state: Array<object|null>}>}} snap
 */
export function restoreChat(chat, snap) {
    if (!Array.isArray(chat) || !snap || !Array.isArray(snap.messages)) {
        return 0;
    }
    const wanted = new Map(snap.messages.map((m) => [m.messageIndex, m]));
    let touched = 0;
    for (let mi = 0; mi < chat.length; mi += 1) {
        const msg = chat[mi];
        if (!isPlainObject(msg)) {
            continue;
        }
        const entry = wanted.get(mi);
        if (!entry) {
            if (hasCopilotData(msg)) {
                clearCopilotData(msg);
                touched += 1;
            }
            continue;
        }
        for (let si = 0; si < (msg.swipe_info?.length ?? 0); si += 1) {
            const saved = entry.state[si] ?? null;
            const info = msg.swipe_info[si];
            if (saved === null) {
                if (info?.extra && ROOT_KEY in info.extra) {
                    delete info.extra[ROOT_KEY];
                    touched += 1;
                }
                continue;
            }
            if (!isPlainObject(info)) {
                continue;
            }
            if (!isPlainObject(info.extra)) {
                info.extra = {};
            }
            info.extra[ROOT_KEY] = JSON.parse(JSON.stringify(saved));
            touched += 1;
        }
        // The mirror belongs to whichever swipe is current.
        const cur = Number.isInteger(msg.swipe_id) ? msg.swipe_id : 0;
        const curRoot = peekSwipeRoot(msg, cur);
        if (curRoot) {
            mirrorToMessageExtra(msg, cur, curRoot);
        } else if (isPlainObject(msg.extra) && ROOT_KEY in msg.extra) {
            delete msg.extra[ROOT_KEY];
        }
    }
    return touched;
}

/** Remove all copilot data from one message. Only used by restore and by tests. @param {object} message */
export function clearCopilotData(message) {
    if (!isPlainObject(message)) {
        return;
    }
    for (const info of (Array.isArray(message.swipe_info) ? message.swipe_info : [])) {
        if (isPlainObject(info?.extra) && ROOT_KEY in info.extra) {
            delete info.extra[ROOT_KEY];
        }
    }
    if (isPlainObject(message.extra) && ROOT_KEY in message.extra) {
        delete message.extra[ROOT_KEY];
    }
}

/**
 * Report data that does not line up with its swipe. Never auto-deletes (I1).
 * @param {object[]} chat
 */
export function audit(chat) {
    const issues = [];
    for (let mi = 0; mi < (chat?.length ?? 0); mi += 1) {
        const msg = chat[mi];
        if (!isPlainObject(msg)) {
            continue;
        }
        const infos = Array.isArray(msg.swipe_info) ? msg.swipe_info : [];
        const live = Array.isArray(msg.swipes) ? msg.swipes.length : 0;

        if (hasCopilotData(msg)) {
            infos.forEach((info, si) => {
                if (!isSwipeRecord(info?.extra?.[ROOT_KEY]?.record)) {
                    return;
                }
                if (si >= live && !(live === 0 && si === 0)) {
                    issues.push({ messageIndex: mi, kind: 'orphan-swipe', swipeIndex: si, liveSwipes: live });
                }
            });
        }

        // Checked OUTSIDE the hasCopilotData gate on purpose: a mirror whose
        // authoritative source is gone is exactly the state where the next
        // SillyTavern sync will overwrite real data, and by then
        // hasCopilotData() reports "nothing here", so gating would hide it.
        const cur = Number.isInteger(msg.swipe_id) ? msg.swipe_id : 0;
        const sourceHas = isSwipeRecord(infos[cur]?.extra?.[ROOT_KEY]?.record);
        const mirrorHas = isSwipeRecord(msg.extra?.[ROOT_KEY]?.record);
        if (mirrorHas && !sourceHas) {
            issues.push({
                messageIndex: mi,
                kind: 'mirror-without-source',
                detail: `message.extra.${ROOT_KEY} has a record but swipe_info[${cur}] does not`,
            });
        }
    }
    return issues;
}