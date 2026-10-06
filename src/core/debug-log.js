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

import { redact } from './redact.js';

/**
 * Changes on every build of this file. Bump it when shipping a change whose
 * effect you need to be able to confirm from a pasted log.
 */
export const BUILD_ID = 'copilot-phase8-r1';

const MAX_EVENTS = 500;

/** Turn records hold request bodies; keep only the most recent ones in memory. */
const MAX_TURNS = 50;

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
        this.maxTurns = opts.maxTurns ?? MAX_TURNS;
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
            while (this.turns.size >= this.maxTurns) {
                this.turns.delete(this.turns.keys().next().value);
            }
            this.turns.set(turnId, {
                id: turnId,
                startedAt: this.now(),
                finishedAt: null,
                slots: [],
                extraction: null,
                composer: null,
                injection: null,
                skipReason: null,
                failure: null,
                pipelineMs: null,
                // Script-verified, not self-reported: set from the bytes of the
                // outgoing request by the fetch watcher (verifyInOutgoing).
                noteFoundOutgoing: null,
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
     * The whole log as text, for the panel and the "copy" button (GOAL.md §6).
     *
     * Phase-2 done-when: correct models, token counts, TIMINGS and a
     * SCRIPT-VERIFIED `injected` flag are shown, failures are shown, and the
     * copy button gives readable text.
     *
     * Redacted on EVERY line, because a prompt can contain anything the user
     * typed, including their API key pasted by mistake. Truncated per line,
     * because a pasted log that is 400KB gets truncated by the messenger
     * instead.
     */
    toText({ maxPerLine = 2000 } = {}) {
        const lines = [];
        const push = (s) => lines.push(clip(redact(String(s)), maxPerLine));
        const failures = this.events.filter((e) => e.level === 'warn' || e.level === 'error').length;
        push(`copilot debug log — build ${this.buildId}`);
        push(`events: ${this.events.length}, turns: ${this.turns.size}, failures: ${failures}`);
        lines.push('');
        for (const t of this.turns.values()) {
            const totalMs = (t.finishedAt ?? this.now()) - t.startedAt;
            push(`── turn ${t.id} ──`);
            push(`  timings: total=${totalMs}ms${t.pipelineMs !== null ? ` pipeline=${t.pipelineMs}ms` : ''}`);
            push(`  script-verified injected (found in the outgoing request): ${t.noteFoundOutgoing === null ? 'not verified' : t.noteFoundOutgoing}`);
            push(`  incoming prompt seen: ${t.incomingPromptSeen}`);
            push(`  outgoing request seen: ${t.outgoingPromptSeen}`);
            push(`  injection: ${t.injection ?? 'n/a'}`);
            if (t.reroll) {
                push(`  reroll: ${t.reroll}`);
            }
            if (t.skipReason) {
                push(`  FAILURES: SKIPPED: ${t.skipReason}`);
            }
            if (t.failure) {
                push(`  FAILURES: ${t.failure.reason ?? 'unknown'}${t.failure.detail ? ` — ${t.failure.detail}` : ''}`);
            }
            if (t.extraction) {
                push(`  extraction: model=${t.extraction.model} tokensIn=${t.extraction.tokensIn} tokensOut=${t.extraction.tokensOut}${stamp(t.extraction.createdAt)}`);
                push('    input:');
                for (const line of markedInput(t, 'extractor')) {
                    push(line);
                }
                push('    output:');
                push(`      ${t.extraction.text}`);
            }
            if (t.composer) {
                push(`  composer: model=${t.composer.model} tokensIn=${t.composer.tokensIn} tokensOut=${t.composer.tokensOut}${stamp(t.composer.createdAt)}${t.composer.staleFlag ? ` ⚠ STALE: ${t.composer.staleReason ?? 'extraction changed, may not match'}` : ''}`);
                push('    input:');
                for (const line of markedInput(t, 'composer')) {
                    push(line);
                }
                push('    output:');
                push(`      ${t.composer.text}`);
            } else if (t.inputs && t.inputs.composer) {
                // R2-6 (I7): a FAILED composer turn must still show the input it
                // failed on — hiding it made failures undiagnosable.
                push('  composer: FAILED — the input it failed on:');
                push('    input:');
                for (const line of markedInput(t, 'composer')) {
                    push(line);
                }
            }
            if (Array.isArray(t.attempts) && t.attempts.length > 0) {
                push('  attempts (the fallback chain, in order):');
                for (const a of t.attempts) {
                    push(`    ${a.model ?? '?'} attempt ${(a.attemptIndex ?? 0) + 1}: ${a.ok ? 'ok' : `REJECTED (${a.reason ?? 'unknown'})`}`);
                    if (!a.ok && a.text) {
                        push(`      raw: ${a.text}`);
                    }
                }
            }
            lines.push('');
        }
        push('── failures ──');
        const failureEvents = this.events.filter((e) => e.level === 'warn' || e.level === 'error');
        if (failureEvents.length === 0) {
            push('  (none)');
        } else {
            for (const e of failureEvents) {
                push(`${new Date(e.t).toISOString()} [${e.level}] ${e.kind}: ${e.text}`);
            }
        }
        lines.push('');
        push('── events ──');
        for (const e of this.events) {
            push(`${new Date(e.t).toISOString()} [${e.level}] ${e.kind}: ${e.text}`);
        }
        return lines.join('\n');
    }
}

function clip(text, max) {
    const s = String(text ?? '');
    return s.length > max ? `${s.slice(0, max)}… [+${s.length - max} chars]` : s;
}

function stamp(ms) {
    return Number.isFinite(ms) ? ` at ${new Date(ms).toISOString()}` : '';
}

/**
 * The input sent to one role, one line per line, with `(i)` on the lines that
 * came from the lorebook (GOAL.md §6: "(i) marker on parts that came from
 * lorebook/world info etc."). The markers exist ONLY in this display — the
 * model never sees them.
 */
function markedInput(turn, role) {
    const text = turn.inputs?.[role];
    if (typeof text !== 'string' || text === '') {
        return ['      (not recorded)'];
    }
    const lore = new Set(String(turn.lorebookText ?? '').split('\n').map((l) => l.trim()).filter(Boolean));
    return text.split('\n').map((line) => {
        const trimmed = line.trim();
        return trimmed !== '' && lore.has(trimmed) ? `      (i) ${line}` : `      ${line}`;
    });
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
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    const needle = norm(note);
    if (norm(body).includes(needle)) {
        return { found: true, noteChars: note.length, noteHash: null };
    }
    // The JSON-ESCAPED form: inside a serialised request body a quote is \" and
    // a newline is \n, so a note containing either reads differently in the
    // bytes than in memory. This exact mismatch reported "NOT FOUND" for a note
    // with a quoted phrase that was demonstrably in the request.
    const escaped = JSON.stringify(note).slice(1, -1).trim();
    if (escaped !== '' && body.includes(escaped)) {
        return { found: true, noteChars: note.length, noteHash: null };
    }
    // Finally, parse the payload and search the message contents unescaped.
    try {
        const payload = JSON.parse(body);
        const texts = [];
        if (Array.isArray(payload?.messages)) {
            for (const m of payload.messages) {
                texts.push(typeof m?.content === 'string' ? m.content : '');
            }
        }
        if (typeof payload?.prompt === 'string') {
            texts.push(payload.prompt);
        }
        if (norm(texts.join('\n')).includes(needle)) {
            return { found: true, noteChars: note.length, noteHash: null };
        }
    } catch { /* not JSON — the raw checks above already ran */ }
    return { found: false, noteChars: note.length, noteHash: null };
}