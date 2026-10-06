/**
 * Import / export of copilot state between chats (GOAL.md §6; S9: "import into
 * a new chat; restore the pre-import snapshot").
 *
 * The rules:
 *  - I3: a SNAPSHOT is taken before the import; restoring it must be exact.
 *  - I1: importing CREATES records. Existing data is never overwritten — an
 *    extraction whose id already exists is skipped, not replaced.
 *  - I6: hostile or corrupt input degrades to "nothing imported", never throws.
 *
 * What travels: every extraction (including merged entries and their
 * `sources`/`compressedInto` links, `protected`/`pinned` flags), plus goals and
 * user requests. Notes and injection records are per-generation and stay
 * behind — they describe turns that belong to the source chat.
 *
 * Pure module: plain data in, plain data out.
 */

import {
    makeExtraction, makeGoal, makeUserRequest,
} from './records.js';
import { listRecords, snapshotChat, restoreChat, appendExtraExtraction, ROOT_KEY } from './store.js';

export const TRANSFER_VERSION = 1;

/**
 * Bundle everything the composer reads from a chat.
 * @param {object[]} chat
 * @param {{goals?: object[], requests?: object[]}} [meta] chat_metadata.copilot
 */
export function exportChatState(chat, meta = {}) {
    const extractions = [];
    for (const entry of listRecords(chat)) {
        const rec = entry.record;
        const all = [
            ...(rec.extraction ? [rec.extraction] : []),
            ...(Array.isArray(rec.extractions) ? rec.extractions.filter(Boolean) : []),
        ];
        for (const ex of all) {
            extractions.push(makeExtraction(ex));
        }
    }
    return {
        version: TRANSFER_VERSION,
        exportedAt: Date.now(),
        extractions,
        goals: (Array.isArray(meta.goals) ? meta.goals : []).map((g) => makeGoal(g)),
        requests: (Array.isArray(meta.requests) ? meta.requests : []).map((r) => makeUserRequest(r)),
    };
}

/** Hostile-input check: a bundle is only usable when it looks like one. */
export function validateBundle(state) {
    if (!state || typeof state !== 'object' || !Array.isArray(state.extractions)) {
        return { ok: false, reason: 'not an exported copilot bundle' };
    }
    if (Number.isInteger(state.version) && state.version > TRANSFER_VERSION) {
        return { ok: false, reason: `bundle written by a newer copilot (v${state.version})` };
    }
    return { ok: true, reason: null };
}

/**
 * Import a bundle into a chat — snapshot first (I3), then append. The imported
 * extractions ride in the LAST message record's `extractions[]`, keeping their
 * ids so `sources`/`compressedInto` links stay meaningful.
 *
 * @param {object[]} chat target chat (non-empty).
 * @param {object} meta target chat_metadata.copilot (mutated for goals/requests).
 * @param {object} state the exported bundle.
 * @returns {{ok: boolean, reason: string|null, added: number, snapshot: object|null, metaSnapshot: object|null}}
 */
export function importChatState(chat, meta, state) {
    const v = validateBundle(state);
    if (!v.ok) {
        return { ok: false, reason: v.reason, added: 0, snapshot: null, metaSnapshot: null };
    }
    if (!Array.isArray(chat) || chat.length === 0) {
        return { ok: false, reason: 'the target chat has no message to attach the import to', added: 0, snapshot: null, metaSnapshot: null };
    }
    // I3: the pre-import snapshot — messages AND metadata.
    const snapshot = snapshotChat(chat);
    const metaSnapshot = structuredClone(meta ?? {});

    // What already exists (ids) — importing twice must not duplicate (I1).
    const known = new Set();
    for (const entry of listRecords(chat)) {
        const rec = entry.record;
        const all = [
            ...(rec.extraction ? [rec.extraction] : []),
            ...(Array.isArray(rec.extractions) ? rec.extractions.filter(Boolean) : []),
        ];
        for (const ex of all) {
            if (ex && ex.id) {
                known.add(ex.id);
            }
        }
    }

    const messageIndex = chat.length - 1;
    const last = chat[messageIndex];
    const swipeIndex = Number.isInteger(last?.swipe_id) ? last.swipe_id : 0;
    let added = 0;
    const createdSlots = [];
    for (const raw of state.extractions) {
        if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string' || raw.text.trim() === '') {
            continue;
        }
        const ex = makeExtraction(raw);
        if (known.has(ex.id)) {
            continue;
        }
        // Remember slots this import had to CREATE from nothing — restore must
        // be able to remove them again or "exact" is a lie.
        const hadInfo = Boolean(Array.isArray(last.swipe_info) && last.swipe_info[swipeIndex]);
        appendExtraExtraction(last, swipeIndex, ex);
        if (!hadInfo && Array.isArray(last.swipe_info) && last.swipe_info[swipeIndex]
            && !createdSlots.some((c) => c.messageIndex === messageIndex && c.swipeIndex === swipeIndex)) {
            createdSlots.push({ messageIndex, swipeIndex });
        }
        known.add(ex.id);
        added += 1;
    }

    // Goals and requests: merge, skipping ids already present.
    const goalIds = new Set((meta.goals ?? []).map((g) => g.id));
    for (const raw of (Array.isArray(state.goals) ? state.goals : [])) {
        const g = makeGoal(raw);
        if (!goalIds.has(g.id)) {
            meta.goals = [...(meta.goals ?? []), g];
            goalIds.add(g.id);
        }
    }
    const reqIds = new Set((meta.requests ?? []).map((r) => r.id));
    for (const raw of (Array.isArray(state.requests) ? state.requests : [])) {
        const r = makeUserRequest(raw);
        if (!reqIds.has(r.id)) {
            meta.requests = [...(meta.requests ?? []), r];
            reqIds.add(r.id);
        }
    }

    return { ok: true, reason: null, added, snapshot, metaSnapshot, createdSlots };
}

/**
 * Restore the pre-import snapshot exactly (S9).
 *
 * @param {object[]} chat
 * @param {object} meta chat_metadata.copilot — mutated back to its snapshot.
 * @param {{snapshot: object, metaSnapshot: object, createdSlots?: Array<{messageIndex: number, swipeIndex: number}>}} saved from importChatState.
 */
export function restoreImport(chat, meta, saved) {
    if (!saved || !saved.snapshot) {
        return { ok: false, reason: 'no pre-import snapshot' };
    }
    const restored = restoreChat(chat, saved.snapshot);
    if (restored && restored.ok === false) {
        return { ok: false, reason: restored.reason ?? 'restore failed' };
    }
    // Remove any swipe_info slots the import had to create — restore means
    // EXACTLY the pre-import structure, scaffolding included.
    for (const slot of (saved.createdSlots ?? [])) {
        const msg = chat?.[slot.messageIndex];
        const info = msg?.swipe_info?.[slot.swipeIndex];
        if (info && !(info.extra && info.extra[ROOT_KEY] && typeof info.extra[ROOT_KEY] === 'object')) {
            msg.swipe_info.splice(slot.swipeIndex, 1);
        }
    }
    // Metadata: remove exactly what the import added — safest is to reset the
    // tracked lists to the snapshot's copies (I1: nothing else is touched).
    const snap = saved.metaSnapshot ?? {};
    meta.goals = Array.isArray(snap.goals) ? snap.goals : [];
    meta.requests = Array.isArray(snap.requests) ? snap.requests : [];
    return { ok: true, reason: null };
}
