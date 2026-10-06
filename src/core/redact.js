/**
 * Secret redaction.
 *
 * GOAL.md 9.2: the OpenRouter key must never be printed, logged, committed or
 * shipped. Every string that can reach a log, the debug panel, a test report,
 * a commit message or an agent brief goes through `redact()` first.
 *
 * Pure module: no DOM, no Node built-ins. Importable from the browser and from
 * the test runner unchanged.
 */

/** OpenRouter keys look like `sk-or-v1-<64 hex>`. */
const KEY_PATTERNS = [
    // OpenRouter, both the legacy and the current prefixes.
    /sk-or-v1-[A-Za-z0-9_-]{8,}/g,
    /sk-or-[A-Za-z0-9_-]{8,}/g,
    // F13 (round 3): the extension accepts ANY provider key (custom baseUrl)
    // — sk-proj-, sk-ant-, etc. — and query-string key=/token= values.
    // {20,} and no-ellipsis keep expected-output LITTERALS (like
    // `key=sk-or-v1-…cdef`) from matching themselves in the repo scan.
    /\bsk-[A-Za-z0-9_-]{16,}/g,
    /\b(key|token|api_key|apikey)=([^&\s"'…]{20,})/gi,
    // Anything else that looks like a bearer secret we were asked to hide.
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];

/**
 * Redact a single secret down to `prefix…last4`.
 * Short or unrecognised secrets become a fixed placeholder rather than a leak.
 *
 * @param {unknown} secret
 * @returns {string} A safe-to-print representation.
 */
export function redactSecret(secret) {
    if (typeof secret !== 'string' || secret.length === 0) {
        return '<no-secret>';
    }
    const trimmed = secret.trim();
    if (trimmed.length <= 8) {
        // Too short to reveal even four trailing characters without giving the
        // whole thing away.
        return '<redacted:short>';
    }
    const last4 = trimmed.slice(-4);
    // Show just enough to tell two keys apart in a log. An unknown prefix is
    // already an ellipsis, so do not stack two of them.
    const prefix = trimmed.startsWith('sk-or-v1-') ? 'sk-or-v1-'
        : trimmed.startsWith('sk-or-') ? 'sk-or-'
            : '';
    return `${prefix}…${last4}`;
}

/**
 * Redact any embedded secret found in arbitrary text: log lines, error objects,
 * prompt echoes, model payloads, chat messages.
 *
 * Also hides the query-string form of a URL carrying a key, which the pattern
 * above alone would miss if the key were URL-encoded.
 *
 * @param {unknown} value Anything.
 * @returns {string} Text safe to print.
 */
export function redact(value) {
    if (value === null || value === undefined) {
        return String(value);
    }
    let text;
    if (typeof value === 'string') {
        text = value;
    } else if (value instanceof Error) {
        // Stack + message can both carry the key.
        text = `${value.name}: ${value.message}\n${value.stack || ''}`;
    } else {
        try {
            text = typeof value === 'object' ? JSON.stringify(value) : String(value);
        } catch {
            // Circular or otherwise unserialisable: fall back to coercion, never throw.
            text = Object.prototype.toString.call(value);
        }
    }
    let out = text;
    for (const pattern of KEY_PATTERNS) {
        // Patterns are global; reset lastIndex so repeated calls are stable.
        pattern.lastIndex = 0;
        out = out.replace(pattern, (match) => {
            // Keep a Bearer prefix or a key=/token= prefix readable without
            // leaking the value (F13: the whole match used to vanish).
            const m = /^(\s*Bearer\s+|[\w.-]+=)/i.exec(match);
            const token = m ? match.slice(m[1].length) : match;
            return (m ? m[1] : '') + redactSecret(token);
        });
    }
    // URL-encoded form: `sk-or-v1-abc%2Ddef` or a key split across escapes.
    out = out.replace(/(sk-or-v1-|sk-or-)[A-Za-z0-9%._~+-]{8,}/g, (match) => {
        try {
            return decodeURIComponent(match) === match
                ? match
                : redactSecret(decodeURIComponent(match));
        } catch {
            return redactSecret(match);
        }
    });
    return out;
}

/**
 * Deep-redact a value for logging: returns a JSON-safe copy with every string
 * passed through `redact`. Used for request/response bodies shown in the debug
 * panel (invariant I7 — the panel shows exactly what was sent, minus secrets).
 *
 * @param {unknown} value
 * @param {number} [depth] Internal recursion guard.
 * @returns {unknown}
 */
export function redactDeep(value, depth = 0) {
    if (depth > 12) {
        return '<deep>';
    }
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value === 'string') {
        return redact(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => redactDeep(item, depth + 1));
    }
    if (value instanceof Error) {
        return redact(value);
    }
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = redactDeep(v, depth + 1);
        }
        return out;
    }
    return value;
}

/**
 * True when `text` contains something that looks like the live key.
 * Used by the T1 repository grep (GOAL.md 9.2) — it must FAIL the build.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function containsSecret(text) {
    if (typeof text !== 'string') {
        return false;
    }
    return KEY_PATTERNS.some((pattern) => {
        pattern.lastIndex = 0;
        const found = pattern.test(text);
        pattern.lastIndex = 0;
        return found;
    });
}