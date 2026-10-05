/**
 * User edits to copilot records (phase 3: "editing the last note" and "editing
 * an extraction sets the stale warning on the composer entry").
 *
 * Two rules, both from invariants:
 *
 *  - I1: nothing an edit supersedes is thrown away. The previous value is
 *    appended to the record's `history` and never pruned.
 *  - §6: editing an extraction flags the dependent composer entry with a
 *    visible warning ("extraction changed, may not match") — the composer text
 *    was written against the OLD extraction, and silently pretending otherwise
 *    is exactly the kind of quiet divergence this project exists to prevent.
 *
 * Pure module: operates on the LIVE record object the store hands out
 * (trap 15 — writing through a read result persists), no ST imports.
 */

import { markStale } from './records.js';

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/** Append the superseded value to history. Never replaces, never prunes (I1). */
function remember(record, field, previous, now) {
    if (!Array.isArray(record.history)) {
        record.history = [];
    }
    record.history.push({ at: now, field, previous });
}

/**
 * Edit the composer's note text.
 *
 * @param {import('./records.js').SwipeRecord} record LIVE record (trap 15).
 * @param {string} newText
 * @param {{now?: number}} [opts]
 * @returns {{ok: boolean, reason: string|null, record: object}}
 */
export function applyComposerEdit(record, newText, opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    if (!record || typeof record !== 'object' || !record.composer) {
        return { ok: false, reason: 'no composer entry to edit', record };
    }
    if (!isNonEmptyString(newText)) {
        return { ok: false, reason: 'the note text is empty', record };
    }
    remember(record, 'composer', record.composer.text, now);
    record.composer.text = newText.trim();
    record.composer.edited = true;
    return { ok: true, reason: null, record };
}

/**
 * Edit an extraction's text. Flags the dependent composer entry as stale.
 *
 * @param {import('./records.js').SwipeRecord} record LIVE record (trap 15).
 * @param {string} newText
 * @param {{now?: number}} [opts]
 * @returns {{ok: boolean, reason: string|null, record: object}}
 */
export function applyExtractionEdit(record, newText, opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    if (!record || typeof record !== 'object' || !record.extraction) {
        return { ok: false, reason: 'no extraction entry to edit', record };
    }
    if (!isNonEmptyString(newText)) {
        return { ok: false, reason: 'the extraction text is empty', record };
    }
    remember(record, 'extraction', record.extraction.text, now);
    record.extraction.text = newText.trim();
    record.extraction.edited = true;
    // §6: the dependent composer entry keeps its text but carries a visible
    // warning from now on.
    if (record.composer) {
        markStale(record.composer, 'extraction changed, may not match');
    }
    return { ok: true, reason: null, record };
}
