/**
 * Copilot data schema — records, factories and validators.
 *
 * GOAL.md §5 fixes this shape. Nothing here may remove or rename a §5 field;
 * additive fields are marked `// ADDED` with the reason, and every one of them
 * is listed in docs/SCHEMA.md for the G1 review.
 *
 * Pure module: no DOM, no storage, no network. Everything here is unit-testable
 * in isolation, which is the point — the previous build's schema defects were
 * only ever discovered in a browser.
 */

/** Bumped only with a migration in schema/migrate.js. */
export const SCHEMA_VERSION = 1;

/** Refuse to load a record written by a newer build rather than guessing. */
export const MAX_SUPPORTED_VERSION = 1;

/* ------------------------------------------------------------------ helpers */

let idCounter = 0;

/**
 * Short, collision-resistant, human-readable id.
 * Ids must never be reused, and must be safe to store inside a JSON chat file.
 * @param {string} prefix
 */
export function newId(prefix = 'x') {
    idCounter = (idCounter + 1) % 0xffff;
    const rand = Math.floor(Math.random() * 0xffffff).toString(36);
    return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`;
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/* --------------------------------------------------------------- extraction */

/**
 * @typedef {object} Extraction
 * @property {string} id
 * @property {string} text
 * @property {string} model
 * @property {number} tokensIn
 * @property {number} tokensOut
 * @property {number} createdAt
 * @property {boolean} edited
 * @property {boolean} protected   Survives auto-compression (GOAL.md §6).
 * @property {boolean} pinned      Never mashed, ever.
 * @property {string[]} [sources]  Ids merged into this one by the compressor.
 * @property {string} [compressedInto] Set on an original that has been merged. I2.
 */

/**
 * @param {Partial<Extraction>} [init]
 * @returns {Extraction}
 */
export function makeExtraction(init = {}) {
    return {
        id: init.id || newId('ext'),
        text: typeof init.text === 'string' ? init.text : '',
        model: init.model || '',
        tokensIn: Number(init.tokensIn) || 0,
        tokensOut: Number(init.tokensOut) || 0,
        createdAt: Number(init.createdAt) || Date.now(),
        edited: init.edited === true,
        protected: init.protected === true,
        pinned: init.pinned === true,
        ...(Array.isArray(init.sources) && init.sources.length ? { sources: [...init.sources] } : {}),
        ...(isNonEmptyString(init.compressedInto) ? { compressedInto: init.compressedInto } : {}),
    };
}

/**
 * I2: an original that has been merged still exists and is marked; it is merely
 * hidden from the composer. This predicate is the ONLY definition of "hidden".
 * @param {Extraction} e
 */
export function isCompressedAway(e) {
    return isNonEmptyString(e?.compressedInto);
}

/**
 * What the composer is allowed to read: everything not merged into something else.
 * @param {Extraction[]} all
 */
export function visibleExtractions(all) {
    if (!Array.isArray(all)) {
        return [];
    }
    return all.filter((e) => e && !isCompressedAway(e));
}

/**
 * I2 wording: the compressor's output is a NEW record carrying `sources`, and the
 * originals are marked `compressedInto` — never deleted.
 * @param {Extraction} merged The new compressed record.
 * @param {Extraction[]} originals
 */
export function markCompression(merged, originals) {
    merged.sources = originals.map((o) => o.id);
    merged.protected = true;
    for (const o of originals) {
        o.compressedInto = merged.id;
    }
    return merged;
}

/** Undo I2 exactly. @param {Extraction[]} originals */
export function undoCompression(originals) {
    for (const o of originals) {
        delete o.compressedInto;
    }
    return originals;
}

/* ----------------------------------------------------------------- composer */

/**
 * @typedef {object} ComposerAttempt
 * @property {number} createdAt
 * @property {string} model
 * @property {boolean} ok
 * @property {string} [rejectReason]  Why it was rejected by the validator.
 * @property {string} [raw]           Raw output, redacted, kept for the debug panel.
 * @property {number} [tokensIn]
 * @property {number} [tokensOut]
 * @property {number} [latencyMs]
 * @property {number} [attemptIndex]  0 = first model, 1 = retry, 2 = fallback…
 * @property {string} [finishReason]
 */

/**
 * @typedef {object} Composer
 * @property {string} text
 * @property {string} model
 * @property {number} tokensIn
 * @property {number} tokensOut
 * @property {number} createdAt
 * @property {boolean} staleFlag   Set when a source extraction is edited later.
 * @property {boolean} edited
 * @property {ComposerAttempt[]} [attempts]      // ADDED: §6 requires failures be shown.
 * @property {string[]} [extractionIds]           // ADDED: which extractions fed this note.
 * @property {number} [latencyMs]                 // ADDED: debug panel "time to completion".
 */

/**
 * @param {Partial<Composer>} [init]
 * @returns {Composer}
 */
export function makeComposer(init = {}) {
    return {
        text: typeof init.text === 'string' ? init.text : '',
        model: init.model || '',
        tokensIn: Number(init.tokensIn) || 0,
        tokensOut: Number(init.tokensOut) || 0,
        createdAt: Number(init.createdAt) || Date.now(),
        staleFlag: init.staleFlag === true,
        edited: init.edited === true,
        ...(Array.isArray(init.attempts) ? { attempts: init.attempts.map((a) => ({ ...a })) } : { attempts: [] }),
        ...(Array.isArray(init.extractionIds) ? { extractionIds: [...init.extractionIds] } : {}),
        ...(Number.isFinite(init.latencyMs) ? { latencyMs: init.latencyMs } : {}),
    };
}

/** §6: editing an extraction flags the dependent composer entry with a visible warning. */
export function markStale(composer, reason) {
    composer.staleFlag = true;
    if (reason && !composer.staleReason) {
        composer.staleReason = reason; // ADDED: which extraction changed.
    }
    return composer;
}

/* ---------------------------------------------------------------- injection */

/**
 * @typedef {object} Injection
 * @property {boolean} injected       Script-verified against the real outgoing prompt.
 * @property {string} position        Configured position label, e.g. 'before_last', 'end'.
 * @property {object} finalPromptRef  Pointer that lets the debug panel prove the match.
 * @property {string[]} goalsActive
 * @property {string[]} userRequestsActive
 * @property {number} [injectedAt]    // ADDED: trap-7 safe "spent" marker (D7 in the old build).
 * @property {string} [skipReason]    // ADDED: trap 14 — every decline logs one line.
 * @property {number} [noteChars]
 * @property {string} [noteHash]      // ADDED: proof token searched for in the outgoing prompt.
 */

/**
 * A pointer into the outgoing prompt, not a copy of it (I8: the store is bounded
 * by the chat file, and a whole prompt copy would grow without bound — trap 8).
 *
 * @param {Partial<Injection>} [init]
 * @returns {Injection}
 */
export function makeInjection(init = {}) {
    return {
        injected: init.injected === true,
        position: init.position || 'end',
        finalPromptRef: init.finalPromptRef || null,
        goalsActive: Array.isArray(init.goalsActive) ? [...init.goalsActive] : [],
        userRequestsActive: Array.isArray(init.userRequestsActive) ? [...init.userRequestsActive] : [],
        ...(Number.isFinite(init.injectedAt) ? { injectedAt: init.injectedAt } : {}),
        ...(isNonEmptyString(init.skipReason) ? { skipReason: init.skipReason } : {}),
        ...(Number.isFinite(init.noteChars) ? { noteChars: init.noteChars } : {}),
        ...(isNonEmptyString(init.noteHash) ? { noteHash: init.noteHash } : {}),
    };
}

/**
 * The record for ONE swipe of ONE message.
 * @typedef {object} SwipeRecord
 * @property {number} version
 * @property {Extraction|null} extraction
 * @property {Composer|null} composer
 * @property {Injection|null} injection
 * @property {string[]} [history]     // ADDED: superseded values, never pruned (I1).
 */

/**
 * @param {Partial<SwipeRecord>} [init]
 * @returns {SwipeRecord}
 */
export function makeSwipeRecord(init = {}) {
    return {
        version: SCHEMA_VERSION,
        extraction: init.extraction ? makeExtraction(init.extraction) : null,
        composer: init.composer ? makeComposer(init.composer) : null,
        injection: init.injection ? makeInjection(init.injection) : null,
        ...(Array.isArray(init.history) ? { history: [...init.history] } : {}),
    };
}

/** An empty slot for a swipe that has no copilot data yet. */
export function emptySwipeRecord() {
    return makeSwipeRecord({});
}

/* --------------------------------------------------------------- validation */

/**
 * I6: corrupt or missing copilot data degrades gracefully to "no data".
 * Never throws. Never partially applies.
 * @param {unknown} raw
 * @returns {SwipeRecord}
 */
export function coerceSwipeRecord(raw) {
    if (!raw || typeof raw !== 'object') {
        return emptySwipeRecord();
    }
    const rec = emptySwipeRecord();
    rec.version = Number.isInteger(raw.version) ? raw.version : SCHEMA_VERSION;
    if (raw.extraction && typeof raw.extraction === 'object' && isNonEmptyString(raw.extraction.text)) {
        rec.extraction = makeExtraction(raw.extraction);
    }
    if (raw.composer && typeof raw.composer === 'object' && isNonEmptyString(raw.composer.text)) {
        rec.composer = makeComposer(raw.composer);
    }
    if (raw.injection && typeof raw.injection === 'object') {
        rec.injection = makeInjection(raw.injection);
    }
    if (Array.isArray(raw.history)) {
        rec.history = raw.history.filter((h) => h && typeof h === 'object');
    }
    return rec;
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isSwipeRecord(raw) {
    return Boolean(raw) && typeof raw === 'object'
        && ('extraction' in raw || 'composer' in raw || 'injection' in raw);
}

/* ------------------------------------------------------------------- goals */

/**
 * @typedef {object} Goal
 * @property {string} id
 * @property {string} text
 * @property {number|'forever'} remainingTurns
 * @property {Record<string, number>} turnCounters  Script-tracked. The LLM never counts.
 * @property {number} createdAt
 * @property {boolean} complete
 */

/**
 * @param {Partial<Goal>} [init]
 * @returns {Goal}
 */
export function makeGoal(init = {}) {
    return {
        id: init.id || newId('goal'),
        text: typeof init.text === 'string' ? init.text : '',
        remainingTurns: init.remainingTurns === 'forever' ? 'forever' : Math.max(0, Number(init.remainingTurns) || 0),
        turnCounters: init.turnCounters && typeof init.turnCounters === 'object' ? { ...init.turnCounters } : {},
        createdAt: Number(init.createdAt) || Date.now(),
        complete: init.complete === true,
    };
}

/**
 * The facts handed to the composer. Script-tracked, per GOAL.md §5 and S6.
 * The LLM is told these as facts; it is never asked to do arithmetic.
 *
 * @param {Goal[]} goals
 * @param {string} [now] Injection key the counters belong to (usually the chat id).
 * @returns {Array<{id: string, text: string, turnsRemaining: number|'forever', turnsElapsed: number, complete: boolean}>}
 */
export function goalFacts(goals, now = 'default') {
    if (!Array.isArray(goals)) {
        return [];
    }
    return goals.filter((g) => g && !g.complete).map((g) => {
        const elapsed = Number(g.turnCounters?.[now]) || 0;
        return {
            id: g.id,
            text: g.text,
            turnsElapsed: elapsed,
            turnsRemaining: g.remainingTurns === 'forever' ? 'forever' : Math.max(0, g.remainingTurns - elapsed),
            complete: false,
        };
    });
}

/**
 * Advance every goal by one narrator turn.
 * Mutates and returns the same array so callers can persist in place.
 * @param {Goal[]} goals
 * @param {string} [now]
 */
export function tickGoals(goals, now = 'default') {
    if (!Array.isArray(goals)) {
        return [];
    }
    for (const g of goals) {
        if (!g || g.complete) {
            continue;
        }
        g.turnCounters = g.turnCounters || {};
        g.turnCounters[now] = (Number(g.turnCounters[now]) || 0) + 1;
        if (g.remainingTurns !== 'forever') {
            const used = Object.values(g.turnCounters).reduce((a, b) => a + (Number(b) || 0), 0);
            if (used >= g.remainingTurns) {
                g.complete = true;
            }
        }
    }
    return goals;
}

/* ----------------------------------------------------------- user requests */

/**
 * @typedef {object} UserRequest
 * @property {string} id
 * @property {string} text
 * @property {number|'forever'} remainingTurns
 * @property {number} createdAt
 * @property {boolean} complete
 * @property {string} [scope] Free-text hint (e.g. 'scene', 'tone') — added for the UI.
 */

/**
 * @param {Partial<UserRequest>} [init]
 * @returns {UserRequest}
 */
export function makeUserRequest(init = {}) {
    return {
        id: init.id || newId('req'),
        text: typeof init.text === 'string' ? init.text : '',
        remainingTurns: init.remainingTurns === 'forever' ? 'forever' : Math.max(0, Number(init.remainingTurns) || 0),
        createdAt: Number(init.createdAt) || Date.now(),
        complete: init.complete === true,
        ...(isNonEmptyString(init.scope) ? { scope: init.scope } : {}),
    };
}

/* --------------------------------------------------------------- snapshots */

/**
 * I3: snapshot before any bulk operation; keep the last five.
 * @typedef {object} Snapshot
 * @property {string} id
 * @property {number} createdAt
 * @property {string} reason
 * @property {object} payload
 * @property {number} bytes
 */

export const MAX_SNAPSHOTS = 5;

/**
 * @param {{reason: string, payload: unknown}} init
 * @returns {Snapshot}
 */
export function makeSnapshot(init) {
    const payload = init?.payload;
    let bytes = 0;
    try {
        bytes = JSON.stringify(payload ?? null).length;
    } catch {
        bytes = 0;
    }
    return {
        id: newId('snap'),
        createdAt: Date.now(),
        reason: String(init?.reason || 'manual'),
        payload: payload ?? null,
        bytes,
    };
}

/**
 * I3: keep the last 5, drop the oldest.
 * @param {Snapshot[]} existing
 * @param {Snapshot} fresh
 * @returns {Snapshot[]}
 */
export function pushSnapshot(existing, fresh) {
    const list = Array.isArray(existing) ? existing.filter((s) => s && typeof s === 'object') : [];
    const next = [...list, fresh];
    return next.length > MAX_SNAPSHOTS ? next.slice(next.length - MAX_SNAPSHOTS) : next;
}

/* ------------------------------------------------------------ note helpers */

/** The note that gets injected, or null. Single source of truth (trap 15). */
export function noteTextOf(record) {
    const c = record?.composer;
    if (!c || typeof c.text !== 'string' || c.text.trim() === '') {
        return null;
    }
    return c.text;
}

/** Short, stable proof token for I7/10.8: search the outgoing prompt for it. */
export function noteHash(text) {
    if (typeof text !== 'string' || text === '') {
        return null;
    }
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `cp${h.toString(36)}`;
}