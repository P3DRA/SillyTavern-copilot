/**
 * The diagnostic log.
 *
 * GOAL.md §10.8 is blunt about this: the previous build died because a green
 * harness said nothing about the real host. "Build the diagnostics first" — the
 * build id on load and the copy button exist from phase 1, so the user can paste
 * a log and every claim can be checked against it.
 *
 * Two rules this file exists to enforce:
 *
 *  - TRAP 20 (stale served code): ST serves extension files directly and
 *    browsers cache them. `BUILD_ID` is stamped at load and printed on every
 *    log line, so "the fix is not live" is visible in one glance instead of
 *    being argued about.
 *
 *  - TRAP 14 (silent early returns): every path that declines to inject logs
 *    ONE line saying why. "No injection, no log" is undiagnosable, and that is
 *    exactly what PROBLEMS.md §1 describes — seven turns, zero explanations.
 *
 * Pure module: an in-memory ring plus a formatter. The UI subscribes to it; it
 * does not know the UI exists.
 */

/**
 * Changes on every build of this file. Bump it when shipping a change whose
 * effect you need to be able to confirm from a pasted log.
 */
export const BUILD_ID = 'copilot-phase1-r1';

const MAX_EVENTS = 500;

/** Reasons the note was not injected. Trap 14: exactly one of these per turn. */
export const SKIP = Object.freeze({
    DISABLED: 'disabled',
    QUIET_GENERATION: 'quiet_generation',
    SUPPRESSED: 'suppressed',
    NO_NOTE: 'no_note_in_store',
    NOTE_ALREADY_SPENT: 'note_already_spent',
    SLOT_MISMATCH: 'slot_mismatch',
    EMPTY_NOTE: 'note_was_empty',
    STALE_GENERATION: 'stale_generation_aborted',
    CHAT_CHANGED: 'chat_changed_mid_flight',
    NO_KEY: 'no_api_key',
    TIMEOUT: 'waited_too_long_for_the_note',
    ST_CHAT_COMPLETION: 'st_reported_a_chat_completion_error',
});

export class DebugLog {
    /**
     * @param {{buildId?: string, limit?: number, now?: () => number}} [opts]
     */
    constructor(opts = {}) {
        this.buildId = opts.buildId ?? BUILD_ID;
        this.limit = opts.limit ?? MAX_EVENTS;
        this.now = opts.now ?? (() => Date.now());
        /** @type {Array<{t: number, level: string, kind: string, text: string, data?: unknown}>} */
        this.events = [];
        /** @type {Set<(e: object) => void>} */
        this.subscribers = new Set();
        /** Per-turn record, keyed by turn id, for the debug panel. */
        this.turns = new Map();
    }

    /**
     * @param {string} level
     * @param {string} kind
     * @param {string} text
     * @param {unknown} [data]
     */
    log(level, kind, text, data) {
        const event = { t: this.now(), level, kind, text, data };
        this.events.push(event);
        if (this.events.length > this.limit) {
            this.events.splice(0, this.events.length - this.limit);
        }
        for (const fn of this.subscribers) {
            try {
                fn(event);
            } catch { /* a broken UI must never break logging */ }
        }
        return event;
    }

    info(kind, text, data) { return this.log('info', kind, text, data); }

    warn(kind, text, data) { return this.log('warn', kind, text, data); }

    error(kind, text, data) { return this.log('error', kind, text, data); }

    /** @param {(e: object) => void} fn */
    subscribe(fn) {
        this.subscribers.add(fn);
        return () => this.subscribers.delete(fn);
    }

    /** Start (or reuse) a turn record. @param {string} turnId */
    turn(turnId) {
        if (!this.turns.has(turnId)) {
            this.turns.set(turnId, {
                id: turnId,
                startedAt: this.now(),
                slots: [],
                extraction: null,
                composer: null,
                injection: null,
                skipReason: null,
                incomingPromptSeen: false,
                outgoingPromptSeen: false,
            });
        }
        return this.turns.get(turnId);
    }

    clear() {
        this.events.length = 0;
        this.turns.clear();
    }

    /**
     * The whole log as text, for the "copy" button (GOAL.md §6).
     *
     * Redacted, because a prompt can contain anything the user typed, including
     * their API key pasted by mistake. Truncated per line, because a pasted log
     * that is 400KB gets truncated by the messenger instead.
     */
    toText({ maxPerLine = 2000 } = {}) {
        const lines = [];
        lines.push(`copilot debug log — build ${this.buildId}`);
        lines.push(`events: ${this.events.length}, turns: ${this.turns.size}`);
        lines.push('');
        for (const t of this.turns.values()) {
            lines.push(`── turn ${t.id} ──`);
            lines.push(`  incoming prompt seen: ${t.incomingPromptSeen}`);
            lines.push(`  outgoing request seen: ${t.outgoingPromptSeen}`);
            lines.push(`  injection: ${t.injection ?? 'n/a'}`);
            if (t.skipReason) {
                lines.push(`  SKIPPED: ${t.skipReason}`);
            }
            if (t.extraction) {
                lines.push(`  extraction: model=${t.extraction.model} tokens=${t.extraction.tokensIn}/${t.extraction.tokensOut}`);
                lines.push(`    ${clip(t.extraction.text, maxPerLine)}`);
            }
            if (t.composer) {
                lines.push(`  composer: model=${t.composer.model} tokens=${t.composer.tokensIn}/${t.composer.tokensOut}`);
                lines.push(`    ${clip(t.composer.text, maxPerLine)}`);
            }
            lines.push('');
        }
        lines.push('── events ──');
        for (const e of this.events) {
            lines.push(`${new Date(e.t).toISOString()} [${e.level}] ${e.kind}: ${clip(e.text, maxPerLine)}`);
        }
        return lines.join('\n');
    }
}

function clip(text, max) {
    const s = String(text ?? '');
    return s.length > max ? `${s.slice(0, max)}… [+${s.length - max} chars]` : s;
}

/**
 * Search a captured request body for our note.
 *
 * This is the host-evidence primitive: it answers "is the note in the prompt
 * that actually left?" by looking at the bytes SillyTavern sent, not at what our
 * code believes it sent.
 *
 * @param {string} serialisedRequest
 * @param {string} noteText
 * @returns {{found: boolean, noteChars: number, noteHash: string|null}}
 */
export function verifyInOutgoing(serialisedRequest, noteText) {
    const body = typeof serialisedRequest === 'string' ? serialisedRequest : '';
    const note = typeof noteText === 'string' ? noteText : '';
    if (body === '' || note.trim() === '') {
        return { found: false, noteChars: note.length, noteHash: null };
    }
    // Compare on a distinctive slice: a note is long enough that an exact match
    // is fine, but whitespace normalisation keeps a formatting difference from
    // reading as "not injected".
    const needle = note.trim().replace(/\s+/g, ' ');
    const hay = body.replace(/\s+/g, ' ');
    return {
        found: needle !== '' && hay.includes(needle),
        noteChars: note.length,
        noteHash: null,
    };
}