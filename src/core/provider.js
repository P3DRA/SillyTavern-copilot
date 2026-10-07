/**
 * The copilot's model client.
 *
 * GOAL.md hard rule 5: all extension model calls go **directly** to the provider
 * via `fetch`, with the key and the model from our own settings — never through
 * SillyTavern's main connection, never via `generateQuietPrompt`.
 *
 * Verified during phase 0:
 *  - SillyTavern disables CSP (`src/server-main.js:104-106`) and installs no
 *    client-side fetch interception, so a direct call is permitted.
 *  - OpenRouter answers a preflight with `access-control-allow-origin: *` and
 *    allows the `Authorization` header (research/cors-evidence.md).
 *  - `stream: true` yields NO usage anywhere in ST, so the spend counter
 *    requires `stream: false`. That is deliberate, not an oversight.
 *  - SillyTavern keeps `reasoning` and `content` as SEPARATE accumulators and
 *    never merges them, so both key spellings are read defensively.
 *
 * `fetchImpl` is injected so tests drive the exact same code path with the mock
 * provider. A mock that replaces the transport AND the shape can hide a real
 * mismatch, and the previous build's failures all came from mocks that could not
 * see the host.
 */

import { judge, REJECT } from './garbage.js';
import { redact, redactSecret } from './redact.js';

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Per-model token budgets (trap 17).
 *
 * `max_tokens` is per MODEL, not per chain: a reasoning model that spends its
 * budget thinking returns an EMPTY content field, and sending it the next
 * model's smaller budget is how the previous build mistook that for a parse
 * failure.
 *
 * Note what these are NOT. They are a starting budget only. The previous build
 * trusted a name regex to decide which models think, missed `qwen3.7-flash`
 * entirely, and then treated its empty answer as a parse failure. **We do not
 * rely on the name here.** `isReasoningModel()` picks a better *first guess*;
 * the thing that actually protects us is that an empty answer carrying reasoning
 * is recognised as a budget problem and retried at 4x, whatever the model is
 * called. The default is deliberately generous for that reason.
 */
export const MODEL_BUDGETS = Object.freeze({
    'qwen/qwen3.7-flash': 4096,
    'inclusionai/ling-3.1-flash': 2048,
    'sao10k/l3-lunaris-8b': 2048,
    'mistralai/mistral-nemo': 1024,
    default: 2048,
});

/**
 * A coarse hint used ONLY to pick the first token budget.
 *
 * Known to be incomplete, and that is acceptable: an unknown model gets the
 * generous default, and the THINKING_ONLY retry covers every model this misses.
 * Do not add logic here that depends on it being right.
 */
const REASONING_HINT = /(?:^|[-:/])(?:r\d|o\d|gpt-5|thinking|reason|qwq|step)/i;

export function isReasoningModel(model) {
    return REASONING_HINT.test(String(model || ''));
}

export function maxTokensFor(model, override) {
    // The ORDER here carries two lessons:
    //  - Trap 17: a chain needs PER-MODEL budgets — MODEL_BUDGETS supplies
    //    defaults so one blanket number cannot silently break a reasoning model.
    //  - R3-F2 (blocker): when the TABLE beat a numeric override, the budget
    //    retries (×4 reasoning, ×2 truncation) re-sent the SAME budget forever
    //    (qwen3.7-flash: [4096,4096,4096,…]) — an unbounded metered loop inside
    //    ST's awaited hook. An explicit per-call number is either the USER's
    //    setting or a retry escalation: it must WIN. The table is the default
    //    when nothing is specified. A per-model map wins per model.
    if (override && typeof override === 'object'
        && Number.isFinite(Number(override[model])) && Number(override[model]) > 0) {
        return Math.floor(Number(override[model]));
    }
    if (Number.isFinite(override) && override > 0) {
        return Math.floor(override);
    }
    if (Object.hasOwn(MODEL_BUDGETS, model)) {
        return MODEL_BUDGETS[model];
    }
    return isReasoningModel(model) ? 4096 : MODEL_BUDGETS.default;
}

/** Why an attempt failed, in a form the debug panel can print verbatim. */
export const FAIL = Object.freeze({
    NO_KEY: 'no_key',
    NO_MODEL: 'no_model',
    NETWORK: 'network',
    HTTP: 'http',
    DEAD_KEY: 'dead_key',
    EMPTY: REJECT.EMPTY,
    THINKING_ONLY: REJECT.THINKING_ONLY,
    MISSING_TAG: REJECT.MISSING_TAG,
    UNCLOSED_TAG: REJECT.UNCLOSED_TAG,
    TOO_SHORT: REJECT.TOO_SHORT,
    TOO_LONG: REJECT.TOO_LONG,
    REFUSED: REJECT.REFUSED,
    NOT_PROSE: REJECT.NOT_PROSE,
    MALFORMED: 'malformed',
    ABORTED: 'aborted',
});

/**
 * One metered attempt against one model.
 *
 * Never throws for an expected failure; returns a result object with `ok:false`
 * and a reason. An unexpected throw is caught and reported as MALFORMED, because
 * a provider error must never escape into the narrator's generation (I5).
 *
 * @param {object} args
 * @param {string} args.model
 * @param {Array<{role: string, content: string}>} args.messages
 * @param {string} args.key
 * @param {string} [args.baseUrl]
 * @param {typeof fetch} [args.fetchImpl]
 * @param {number} [args.maxTokens]
 * @param {number} [args.temperature]
 * @param {string} [args.tag]        Required tag for the judge.
 * @param {number} [args.minWords]
 * @param {number} [args.maxWords]
 * @param {boolean} [args.json]
 * @param {AbortSignal} [args.signal]
 * @param {(event: object) => void} [args.onEvent]  Progress for the debug log.
 * @returns {Promise<object>} attempt record
 */
/**
 * T-R4-8: a retry must never be byte-identical (user: "composer was fired twice
 * with the exact same prompt" — the second call was a retry and carried no
 * signal about what was wrong). The first retry appends one short correction
 * line; it is never appended twice.
 */
function hintedMessages(args) {
    const hint = typeof args.retryHint === 'string' ? args.retryHint.trim() : '';
    if (!hint || args._hinted || !Array.isArray(args.messages)) {
        return args.messages;
    }
    return [...args.messages, { role: 'user', content: hint }];
}

export async function attempt(args) {
    const {
        model, messages, key, baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch,
        temperature = 0.7, tag = null, json = false, signal,
        onEvent = () => {},
    } = args;

    // T-R4-7 (user request): the provider's debug screen should show WHICH
    // copilot role is calling — "SillyTavern-Copilot-Extractor" etc.
    const role = typeof args.role === 'string' && args.role.trim() ? args.role.trim() : 'copilot';
    const title = `SillyTavern-Copilot-${role.charAt(0).toUpperCase()}${role.slice(1)}`;

    const started = Date.now();
    const record = {
        model, ok: false, reason: null, detail: '', text: '', reasoning: '',
        tokensIn: 0, tokensOut: 0, latencyMs: 0, finishReason: null, status: null,
        // T-R5-24: which agent this attempt belongs to — shown in the log so
        // the user can verify it against the provider's activity table.
        title,
    };

    const finish = (patch = {}) => {
        Object.assign(record, patch);
        record.latencyMs = Date.now() - started;
        onEvent({ kind: 'attempt', ...record });
        return record;
    };

    if (!model) {
        return finish({ reason: FAIL.NO_MODEL, detail: 'no model configured for this role' });
    }
    if (!key) {
        return finish({ reason: FAIL.NO_KEY, detail: 'no API key set in the copilot settings' });
    }
    if (typeof fetchImpl !== 'function') {
        return finish({ reason: FAIL.NETWORK, detail: 'fetch is unavailable in this environment' });
    }

    let maxTokens = maxTokensFor(model, args.maxTokens);
    const body = {
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false, // usage is not returned on a stream (verified, phase 0)
        // T-R5-24: third identification channel. OpenRouter's activity "App"
        // column has been observed filling from whatever it grabbed (the same
        // call labelled differently across tables), so the role rides in `user`
        // (visible in request details) too.
        user: title,
    };
    if (json) {
        body.response_format = { type: 'json_object' };
    }
    // T-R4-1 (user request): reasoning effort for models that support it
    // (OpenRouter's `reasoning: { effort }`). 'none'/unset sends nothing, so
    // models without reasoning are unaffected.
    const effort = typeof args.reasoning === 'string' ? args.reasoning.trim().toLowerCase() : '';
    if (effort && effort !== 'none') {
        body.reasoning = { effort };
    }

    onEvent({ kind: 'request', model, maxTokens, messages, title, bodyPreview: redact(JSON.stringify(body)) });

    // Trap 7 / F4 (critique round 1): a hung fetch must never hang the
    // generation. Implemented with a plain ref'd setTimeout + AbortController —
    // portable everywhere. m1 (round 3): when a deadlineAt is given, EACH
    // attempt sees the REMAINING budget — the old per-stage number let a hung
    // chain hold ST's awaited hook ≈ #attempts × stageBudget.
    const timeoutMs = Number.isFinite(args.deadlineAt)
        ? Math.max(500, args.deadlineAt - Date.now())
        : (args.timeoutMs ?? 120000);
    const timeoutController = new AbortController();
    const timeoutTimer = setTimeout(() => timeoutController.abort(), timeoutMs);
    let effectiveSignal = timeoutController.signal;
    if (signal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
        try {
            effectiveSignal = AbortSignal.any([signal, timeoutController.signal]);
        } catch {
            effectiveSignal = timeoutController.signal;
        }
    }

    let res;
    try {
        res = await fetchImpl(`${baseUrl || DEFAULT_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${key}`,
                // T-R5-24: the provider's "App" column falls back to the
                // Referer — so the role rides there too, not just in X-Title.
                // Whichever channel its UI reads, it shows WHICH copilot agent
                // (extractor / composer / compressor) made the call.
                'HTTP-Referer': `https://sillytavern.github.io/SillyTavern-Docs/?app=${encodeURIComponent(title)}`,
                'X-Title': title,
            },
            body: JSON.stringify(body),
            signal: effectiveSignal,
        });
    } catch (err) {
        clearTimeout(timeoutTimer);
        if (timeoutController.signal.aborted) {
            return finish({ reason: FAIL.NETWORK, detail: `timed out after ${timeoutMs}ms (trap 7)` });
        }
        if (effectiveSignal?.aborted || signal?.aborted) {
            return finish({ reason: FAIL.ABORTED, detail: 'the request was aborted' });
        }
        return finish({ reason: FAIL.NETWORK, detail: redact(String(err?.message ?? err)) });
    }
    clearTimeout(timeoutTimer);

    record.status = res.status;
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        // A dead key is terminal for the whole run (GOAL.md 9.3): report it so
        // the pipeline stops trying models rather than burning the fallback chain.
        if (res.status === 401 || res.status === 402) {
            return finish({
                reason: FAIL.DEAD_KEY,
                detail: `HTTP ${res.status} with key ${redactSecret(key)} — the key looks dead or out of credit`,
            });
        }
        return finish({ reason: FAIL.HTTP, detail: `HTTP ${res.status}: ${redact(text).slice(0, 300)}` });
    }

    let payload;
    try {
        payload = await res.json();
    } catch (err) {
        return finish({ reason: FAIL.MALFORMED, detail: `response was not JSON: ${redact(String(err?.message ?? err))}` });
    }
    // A 200 can still carry an error object (verified in phase 0).
    if (payload?.error) {
        const msg = payload.error?.message ?? JSON.stringify(payload.error);
        return finish({ reason: FAIL.HTTP, detail: `provider returned 200 with an error: ${redact(String(msg)).slice(0, 300)}` });
    }

    const choice = payload?.choices?.[0];
    const message = choice?.message ?? {};
    // ST keeps these separate and the key spelling differs by source.
    const content = typeof message.content === 'string' ? message.content : '';
    const reasoning = typeof message.reasoning === 'string' ? message.reasoning
        : (typeof message.reasoning_content === 'string' ? message.reasoning_content : '');
    const usage = payload?.usage ?? {};
    record.tokensIn = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    record.tokensOut = usage.completion_tokens ?? usage.output_tokens ?? 0;
    record.finishReason = choice?.finish_reason ?? null;
    record.reasoning = reasoning;

    const verdict = judge(content, { tag, reasoning, minWords: args.minWords, maxWords: args.maxWords });

    // Two symptoms of the same underlying cause — the model ran out of budget —
    // and both are worth retrying on the SAME model with MORE budget before we
    // give up on it and walk the fallback chain.
    //
    // THINKING_ONLY (trap 17): empty content, reasoning tokens spent. Found live:
    // a reasoning model spends the whole allowance thinking and answers nothing.
    if (verdict.reason === REJECT.THINKING_ONLY && maxTokens < 32768 && (args.budgetDepth ?? 0) < 2) {
        onEvent({
            kind: 'reasoning-budget-retry', model, from: maxTokens, to: maxTokens * 4,
            droppedAttempt: { tokensIn: record.tokensIn ?? 0, tokensOut: record.tokensOut ?? 0, reason: verdict.reason },
        });
        const retry = await attempt({ ...args, messages: hintedMessages(args), _hinted: true, maxTokens: maxTokens * 4, budgetDepth: (args.budgetDepth ?? 0) + 1 });
        // F5 (critique round 1): the DROPPED attempt consumed real tokens
        // (thinking) — fold its usage into the returned record so spend
        // accounting and the failure log see every cent (it used to vanish).
        return {
            ...retry,
            budgetRetried: true,
            tokensIn: (retry.tokensIn ?? 0) + (record.tokensIn ?? 0),
            tokensOut: (retry.tokensOut ?? 0) + (record.tokensOut ?? 0),
        };
    }

    // UNCLOSED_TAG (trap 4): the model opened `<copilot>` and was cut off
    // mid-answer. Found live: mistralai/mistral-nemo did this at 700 tokens.
    // Retrying the same model with more room is far likelier to succeed than
    // declaring the model incapable, and the bigger cost is only paid when the
    // small budget has already failed.
    if (verdict.reason === REJECT.UNCLOSED_TAG && maxTokens < 32768 && (args.budgetDepth ?? 0) < 2) {
        onEvent({
            kind: 'truncation-budget-retry', model, from: maxTokens, to: maxTokens * 2,
            droppedAttempt: { tokensIn: record.tokensIn ?? 0, tokensOut: record.tokensOut ?? 0, reason: verdict.reason },
        });
        const retry = await attempt({ ...args, messages: hintedMessages(args), _hinted: true, maxTokens: maxTokens * 2, budgetDepth: (args.budgetDepth ?? 0) + 1 });
        return {
            ...retry,
            budgetRetried: true,
            tokensIn: (retry.tokensIn ?? 0) + (record.tokensIn ?? 0),
            tokensOut: (retry.tokensOut ?? 0) + (record.tokensOut ?? 0),
        };
    }

    return finish({
        ok: verdict.ok,
        text: verdict.text,
        reason: verdict.ok ? null : verdict.reason,
        detail: verdict.detail,
        words: verdict.words,
    });
}

/**
 * The fallback chain: try each model in turn, retrying each `retries` times
 * before moving on (GOAL.md §6).
 *
 * Records EVERY attempt, including failures — §6 requires failures be visible
 * with the raw output and the reason.
 *
 * @param {object} args
 * @param {string[]} args.models          Fallback chain, in order.
 * @param {number} [args.retries]         Attempts per model before moving on.
 *   (Refusals always keep their TEXT in the result for the record and always
 *   route to the next model — there is no mode where they become output.)
 * @param {(event: object) => void} [args.onEvent]
 * @returns {Promise<{ok: boolean, text: string, model: string|null, attempts: object[], deadKey: boolean, summary: string}>}
 */
export async function callWithFallback(args) {
    const {
        models, retries = 1, onEvent = () => {},
    } = args;
    const chain = (Array.isArray(models) ? models : []).filter(Boolean);
    /** @type {object[]} */
    const attempts = [];
    /** The first refusal seen, kept so its TEXT is never lost even if the chain fails. */
    let firstRefusal = null;

    if (chain.length === 0) {
        const rec = { model: null, ok: false, reason: FAIL.NO_MODEL, detail: 'the fallback chain is empty', text: '', tokensIn: 0, tokensOut: 0 };
        attempts.push(rec);
        return { ok: false, text: '', model: null, attempts, deadKey: false, summary: 'no models configured' };
    }

    for (const model of chain) {
        for (let tryIndex = 0; tryIndex <= retries; tryIndex += 1) {
            // T-R4-8: retries carry the correction hint (once).
            const rec = await attempt({
                ...args,
                model,
                ...(tryIndex > 0 ? { messages: hintedMessages(args), _hinted: true } : {}),
            });
            rec.attemptIndex = tryIndex;
            attempts.push(rec);
            if (rec.ok) {
                return {
                    ok: true,
                    text: rec.text,
                    model,
                    attempts,
                    deadKey: false,
                    summary: `ok with ${model} on attempt ${tryIndex + 1}`,
                };
            }
            // A refusal is garbage by GOAL.md 6, so it ROUTES TO THE NEXT MODEL like any
            // other garbage. That is not politeness: §10.4 certifies models for
            // roles by observing which ones refuse, so walking the chain is how a
            // model that will actually do the work gets found.
            //
            // What it must never do is become usable output. The text is kept for
            // the record and the debug panel, flagged `refused`, and `ok` stays
            // false so no caller promotes a refusal into an injected note.
            if (rec.reason === FAIL.REFUSED) {
                if (!firstRefusal) {
                    firstRefusal = { text: rec.text, model };
                }
                onEvent({ kind: 'refused', model, detail: rec.detail });
            }
            if (rec.reason === FAIL.ABORTED) {
                return { ok: false, text: '', model: null, attempts, deadKey: false, summary: 'aborted' };
            }
            if (rec.reason === FAIL.DEAD_KEY) {
                // Do not walk the rest of the chain; every model will fail the same way.
                return { ok: false, text: '', model: null, attempts, deadKey: true, summary: rec.detail };
            }
        }
    }

    const refusalNote = firstRefusal
        ? ` (first refusal kept on record from ${firstRefusal.model})`
        : '';
    return {
        ok: false,
        refused: Boolean(firstRefusal),
        text: firstRefusal?.text ?? '',
        model: firstRefusal?.model ?? null,
        attempts,
        deadKey: false,
        summary: `every attempt failed (${attempts.length} tried across ${chain.length} models)${refusalNote}`,
    };
}

/**
 * Total cost from provider-reported tokens and a user-editable pricing table
 * (GOAL.md §6). Prices are per TOKEN, as OpenRouter publishes them.
 *
 * @param {{tokensIn: number, tokensOut: number}} usage
 * @param {{prompt: number, completion: number}} price
 */
export function costUsd(usage, price) {
    if (!price || !Number.isFinite(price.prompt) || !Number.isFinite(price.completion)) {
        return 0;
    }
    return (usage?.tokensIn || 0) * price.prompt + (usage?.tokensOut || 0) * price.completion;
}