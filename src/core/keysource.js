/**
 * API-key source resolution — pure helpers, no ST context, unit-testable.
 *
 * T-R4-1 (BLOCKER, user report: "I couldn't get the extension to work and I
 * always got an error 'HTTP 401' even though i used the same model for the
 * narrator and copilot"): the old `refreshSecretKey()` read
 * `secret_state[OPENROUTER][0]` and sent it as the key. But in ST
 * `secret_state[key]` is a list of SECRET DESCRIPTORS —
 * `{id, value: <MASKED>, label, active}` (`src/endpoints/secrets.js`
 * getSecretState) — so `String(v[0])` produced the literal string
 * "[object Object]" and that went out as the bearer token. Every turn 401'd no
 * matter which key was configured.
 *
 * The lessons this module pins:
 *
 *  - A secret DESCRIPTOR is never a key. Only `findSecret()` returns a value.
 *  - A masked value ("sk-…xxxx", "*****xxx") is never a key.
 *  - `[object Object]` (or any other coerced junk) is never a key.
 *  - Hand-typed keys carry stray whitespace and quotes; those are stripped.
 *  - When there is no usable key we say WHICH source failed and what to do —
 *    never guess and never silently send an unauthenticated request.
 *
 * Note the server gate: `/api/secrets/find` answers 403 unless `config.yaml`
 * sets `allowKeysExposure` (or the key is one of the EXPORTABLE_KEYS, which are
 * translator URLs). So "ST's secret exists but is unreadable" is a normal state
 * and must be reported as such — with the panel field as the fix.
 */

/**
 * Strip the noise hand-typing and pasting add to a key (whitespace, wrapping
 * quotes). Does NOT guess: an unusable value is passed through unchanged so
 * `isPlausibleKey` can reject it and the caller can explain why.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeKey(raw) {
    return String(raw ?? '').trim().replace(/^['"]|['"]$/g, '');
}

/**
 * Can this value be a bearer token at all? Rejects the exact junk shapes that
 * produced 401s: coerced objects, masked secret values, and anything with
 * whitespace. Real keys are single opaque tokens (OpenRouter: `sk-or-v1-…`).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlausibleKey(value) {
    const v = normalizeKey(value);
    return v.length >= 8
        && !/\s/.test(v)
        && !v.includes('*')
        && !v.includes('…')
        && !v.includes('[object');
}

/**
 * The key to send, or null when nothing usable exists. The panel value wins
 * only when it is actually usable — a broken panel value must not shadow a
 * working secret, and vice versa.
 *
 * @param {{panelKey?: unknown, secretKey?: unknown}} sources
 * @returns {string|null}
 */
export function resolveKey(sources = {}) {
    for (const raw of [sources.panelKey, sources.secretKey]) {
        const v = normalizeKey(raw);
        if (isPlausibleKey(v)) {
            return v;
        }
    }
    return null;
}

/**
 * Where a resolved key came from — for the status line and the pilot light.
 *
 * @param {{panelKey?: unknown, secretKey?: unknown}} sources
 * @returns {'panel'|'st-secret'|null}
 */
export function keySource(sources = {}) {
    const panel = normalizeKey(sources.panelKey);
    if (isPlausibleKey(panel)) {
        return 'panel';
    }
    const secret = normalizeKey(sources.secretKey);
    return isPlausibleKey(secret) ? 'st-secret' : null;
}

/**
 * One actionable sentence explaining why there is no usable key — empty string
 * when there is no problem. This is what the log and the pilot light show, so
 * it must name the FIX, not just the failure.
 *
 * @param {{panelKey?: unknown, secretKey?: unknown, secretStatus?: string}} sources
 *   `secretStatus` is 'ok' | 'missing' | 'unreadable' | 'unknown'.
 * @returns {string}
 */
export function keyProblem(sources = {}) {
    const panel = normalizeKey(sources.panelKey);
    const secret = normalizeKey(sources.secretKey);
    if (isPlausibleKey(panel) || isPlausibleKey(secret)) {
        return '';
    }
    if (panel && !isPlausibleKey(panel)) {
        return 'the API key typed in the Copilot panel is not usable (it has spaces or quotes around it, or is not a key). Re-paste it and press Save settings.';
    }
    if (sources.secretStatus === 'unreadable') {
        return "ST's OpenRouter secret exists, but this server does not expose key values to the browser (set allowKeysExposure: true in config.yaml). Easier fix: type the key into the Copilot panel's API key field.";
    }
    if (sources.secretStatus === 'unknown') {
        return "still checking ST's key store — if this stays, type the key into the Copilot panel's API key field.";
    }
    return 'no API key anywhere — type one into the Copilot panel\'s API key field. (A blank field can fall back to ST\'s OpenRouter secret, but only a server with allowKeysExposure: true can read it.)';
}