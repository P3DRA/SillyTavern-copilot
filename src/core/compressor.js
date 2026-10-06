/**
 * The compressor (GOAL.md §6; invariants I1-I4; the torture test §10.7).
 *
 * This is the most dangerous feature in the project (PROBLEMS.md P6: it
 * destroyed the previous build's data). The rules it encodes:
 *
 *  - I1: nothing is destroyed. Compression CREATES a merged record; originals
 *    stay on disk marked `compressedInto`.
 *  - I2: the merged record carries `sources: [ids]`; undo restores the previous
 *    state exactly.
 *  - I3: a snapshot is taken before the bulk operation; restore works.
 *  - I4: the compressor's output is accepted ONLY if it is non-empty, parses in
 *    the expected format, and is SHORTER than its inputs combined. If
 *    validation fails, NOTHING changes and the user is told.
 *  - §6: manual selections must be CONTIGUOUS (no 20 and 23 without 21 and 22);
 *    auto-compress merges the Y oldest once more than X exist, and the merged
 *    result is protected (never re-merged); pinned entries are unmashable.
 *
 * Pure module: it takes a model-call function and plain chat data. The host
 * supplies storage and UI.
 */

import {
    makeExtraction, markCompression, undoCompression, isCompressedAway,
} from '../schema/records.js';
import {
    appendExtraExtraction, removeExtraExtraction, snapshotChat, writeSwipeRecord,
} from '../schema/store.js';
import { render, renderEntries } from './prompts.js';

/**
 * The dedicated compress prompt (§6: "selected entries go to an extractor with
 * a dedicated compress prompt"). The output format is the `<compressed>` tag —
 * validated before anything is committed (I4).
 */
export const COMPRESS_PROMPT = `You are a memory compressor. You are given a numbered list of story facts extracted from a roleplay chat. Merge them into ONE shorter fact list that loses nothing important.

Rules:
- Keep every concrete fact: names, places, objects, promises, injuries, relationships, unresolved tensions.
- Drop redundancy and filler only.
- Write in the same language as the facts.
- Output ONLY inside <compressed>...</compressed> tags.
- The result must be SHORTER than the input list.

{{copilot.extractions}}`;

const TAG = 'compressed';

/** Extract `<compressed>...</compressed>` content; null when absent/empty. */
export function extractCompressed(text) {
    if (typeof text !== 'string') {
        return null;
    }
    const m = /<compressed>([\s\S]*?)<\/compressed>/i.exec(text);
    const inner = m ? m[1].trim() : null;
    return inner ? inner : null;
}

/**
 * §6: a manual selection must be contiguous — "No skipping entries (e.g. 20
 * and 23 without 21 and 22)".
 *
 * @param {number[]} indices Positions in the visible extraction list.
 * @returns {{ok: boolean, reason: string|null}}
 */
export function validateSelection(indices) {
    if (!Array.isArray(indices) || indices.length < 2) {
        return { ok: false, reason: 'select at least two entries to merge' };
    }
    const sorted = [...indices].sort((a, b) => a - b);
    if (sorted.some((i) => !Number.isInteger(i) || i < 0)) {
        return { ok: false, reason: 'invalid selection' };
    }
    for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i] === sorted[i - 1]) {
            return { ok: false, reason: 'the same entry is selected twice' };
        }
        if (sorted[i] !== sorted[i - 1] + 1) {
            return { ok: false, reason: 'selection must be contiguous — no skipping entries (§6)' };
        }
    }
    return { ok: true, reason: null };
}

/**
 * I4: accept the compressor's output ONLY when it is non-empty, parses in the
 * expected format, and is shorter than its inputs combined.
 *
 * @param {string} raw model output
 * @param {string[]} inputTexts the selected extractions' texts
 * @returns {{ok: boolean, reason: string|null, text: string|null}}
 */
export function validateCompressorOutput(raw, inputTexts) {
    const text = extractCompressed(raw);
    if (!text) {
        return { ok: false, reason: 'I4: output did not parse in the expected <compressed> format', text: null };
    }
    const inputChars = (Array.isArray(inputTexts) ? inputTexts : [])
        .reduce((n, t) => n + String(t ?? '').length, 0);
    if (text.length >= inputChars) {
        return { ok: false, reason: `I4: output is not shorter than its inputs (${text.length} >= ${inputChars} chars)`, text: null };
    }
    return { ok: true, reason: null, text };
}

/**
 * §6 auto-compress: when MORE than `maxVisible` extractions exist, merge the
 * `mergeCount` oldest. Protected, pinned, and already-merged entries are never
 * selected — and because §6 also requires contiguity ("no skipping entries"),
 * a pinned entry ENDS a run: the selection is the oldest contiguous window of
 * usable entries, never a set with holes.
 *
 * @param {Array<{extraction: object}>} entries from collectExtractions (visible only).
 * @param {{maxVisible?: number, mergeCount?: number}} opts
 * @returns {number[]} indices into `entries`, contiguous by construction.
 */
export function autoSelect(entries, opts = {}) {
    const maxVisible = Number.isInteger(opts.maxVisible) ? opts.maxVisible : 40;
    const mergeCount = Number.isInteger(opts.mergeCount) ? opts.mergeCount : 10;
    const list = Array.isArray(entries) ? entries : [];
    const usable = (e) => Boolean(e && e.extraction
        && e.extraction.protected !== true
        && e.extraction.pinned !== true
        && !isCompressedAway(e.extraction));
    const usableCount = list.filter(usable).length;
    if (usableCount <= maxVisible) {
        return [];
    }
    for (let start = 0; start + mergeCount <= list.length; start += 1) {
        const window = [];
        for (let i = start; i < start + mergeCount; i += 1) {
            if (!usable(list[i])) {
                break;
            }
            window.push(i);
        }
        if (window.length === mergeCount) {
            return window;
        }
    }
    return [];
}

/**
 * Commit a compression (I1/I2/I3 in one place).
 *
 * Synchronous and total: snapshot first, then mark, then append. There is no
 * await between the first mutation and the last — a killed process can lose
 * the (not yet saved) mutation but can never half-apply it (§10.7 step 7).
 *
 * @param {object[]} chat the live chat array.
 * @param {Array<{extraction: object, messageIndex: number, swipeIndex: number}>} entries the selection.
 * @param {string} mergedText validated merged text.
 * @param {{model?: string, tokensIn?: number, tokensOut?: number, now?: number}} [meta]
 * @returns {{ok: boolean, reason: string|null, merged: object|null, originals: object[]}}
 */
export function commitCompression(chat, entries, mergedText, meta = {}) {
    const sel = validateSelection((entries ?? []).map((_, i) => i));
    if (!sel.ok) {
        return { ok: false, reason: sel.reason, merged: null, originals: [] };
    }
    const originals = (entries ?? []).map((e) => e?.extraction).filter(Boolean);
    if (originals.length !== (entries ?? []).length || originals.length < 2) {
        return { ok: false, reason: 'invalid selection entries', merged: null, originals: [] };
    }
    // I3: snapshot BEFORE the bulk operation — restore must be able to undo
    // even a successful compression, exactly.
    const snapshot = snapshotChat(chat);
    const merged = makeExtraction({
        text: mergedText,
        model: meta.model ?? 'compressor',
        tokensIn: meta.tokensIn ?? 0,
        tokensOut: meta.tokensOut ?? 0,
        createdAt: meta.now ?? Date.now(),
    });
    markCompression(merged, originals);
    // The merged record lives with the LAST entry of the range — still per
    // swipe, still carried by every fork up to that message (I6).
    const last = entries[entries.length - 1];
    appendExtraExtraction(chat[last.messageIndex], last.swipeIndex, merged);
    // Refresh every touched record's MIRROR (message.extra.copilot) — a stale
    // mirror is a stale clone that would survive an undo byte-for-byte.
    for (const e of entries) {
        writeSwipeRecord(chat[e.messageIndex], e.swipeIndex, {});
    }
    return { ok: true, reason: null, merged, originals, snapshot };
}

/**
 * Run the compressor over a selection and commit it — the full §6 operation
 * with I3's snapshot and I4's validation gate. Nothing is mutated unless the
 * output validates.
 *
 * @param {object[]} chat
 * @param {Array<{extraction: object, messageIndex: number, swipeIndex: number}>} entries visible entries (collectExtractions order).
 * @param {number[]} indices which of `entries` to merge (must be contiguous).
 * @param {{callModel: (messages: object[]) => Promise<{ok: boolean, text?: string, model?: string, tokensIn?: number, tokensOut?: number, reason?: string}>, model?: string, now?: number}} deps
 * @returns {Promise<{ok: boolean, reason: string|null, merged?: object, snapshot?: object, raw?: string}>}
 */
export async function compressEntries(chat, entries, indices, deps = {}) {
    const sel = validateSelection(indices);
    if (!sel.ok) {
        return { ok: false, reason: sel.reason };
    }
    const chosen = indices.map((i) => entries?.[i]).filter(Boolean);
    if (chosen.length !== indices.length) {
        return { ok: false, reason: 'selection references missing entries' };
    }
    const inputTexts = chosen.map((e) => e.extraction.text);
    // render() returns { text, ... } — the pipeline reads `.text` off it too.
    // `deps.prompt` is the user-editable compress prompt (§6) — wired, not
    // decorative (critique trap-10 class).
    const promptText = render(deps.prompt || COMPRESS_PROMPT, {
        extractions: renderEntries(chosen.map((e) => ({ text: e.extraction.text, source: e.messageIndex + 1 }))),
    }).text;
    const res = await deps.callModel([{ role: 'system', content: promptText }]);
    if (!res || !res.ok) {
        // I4: nothing changes on a failed call either — and the user is told.
        return { ok: false, reason: `compressor call failed: ${res?.reason ?? 'no result'}`, raw: res?.text ?? '' };
    }
    const v = validateCompressorOutput(res.text, inputTexts);
    if (!v.ok) {
        return { ok: false, reason: v.reason, raw: res.text ?? '' };
    }
    return commitCompression(chat, chosen, v.text, {
        model: res.model ?? deps.model ?? 'compressor',
        tokensIn: res.tokensIn ?? 0,
        tokensOut: res.tokensOut ?? 0,
        now: deps.now,
    });
}

/**
 * Undo a committed compression exactly (I2): drop the merged record and clear
 * every original's `compressedInto` marker.
 *
 * @param {object[]} chat
 * @param {object} merged the merged extraction (with `sources`).
 */
export function undoCompressionAt(chat, merged) {
    if (!merged || !Array.isArray(merged.sources) || merged.sources.length === 0) {
        return { ok: false, reason: 'nothing to undo' };
    }
    const originals = [];
    const mergedSlots = [];
    // Walk every record (including hidden originals) to find the sources —
    // FIRST PASS ONLY. I4 (F7, critique round 1): validate BEFORE mutating. A
    // partial state (a source message deleted) must change NOTHING.
    for (let mi = 0; mi < (chat?.length ?? 0); mi += 1) {
        const msg = chat[mi];
        const infos = Array.isArray(msg?.swipe_info) ? msg.swipe_info : [];
        for (let si = 0; si < infos.length; si += 1) {
            const rec = infos[si]?.extra?.copilot?.record;
            if (!rec || typeof rec !== 'object') {
                continue;
            }
            const all = [
                ...(rec.extraction ? [rec.extraction] : []),
                ...(Array.isArray(rec.extractions) ? rec.extractions.filter(Boolean) : []),
            ];
            for (const ex of all) {
                if (merged.sources.includes(ex.id)) {
                    originals.push({ ex, mi, si });
                }
            }
            if (Array.isArray(rec.extractions) && rec.extractions.some((e) => e && e.id === merged.id)) {
                mergedSlots.push({ msg, si });
            }
        }
    }
    if (originals.length !== merged.sources.length) {
        return { ok: false, reason: `undo found ${originals.length} of ${merged.sources.length} originals — nothing changed` };
    }
    // SECOND PASS: only now touch anything.
    for (const slot of mergedSlots) {
        removeExtraExtraction(slot.msg, slot.si, merged.id);
    }
    undoCompression(originals.map((o) => o.ex));
    // Refresh the mirrors AFTER the marks are cleared — refreshing earlier
    // would leave the stale marked clone in message.extra, and "undo" would
    // not be byte-identical (I2).
    for (const o of originals) {
        writeSwipeRecord(chat[o.mi], o.si, {});
    }
    return { ok: true, reason: null };
}
