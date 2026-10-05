/**
 * The spend counter (GOAL.md §6): "from provider-reported token counts and a
 * user-editable pricing table. Totals for narrator, extractor, composer and
 * combined."
 *
 * Two rules:
 *  - Only PROVIDER-REPORTED usage is counted. A local tokenizer estimate is
 *    not spend. When a provider reports nothing (a streamed response without
 *    usage), the counter says so and counts nothing — it never invents.
 *  - The pricing table is the USER's; prices are per token, as OpenRouter
 *    publishes them. Totals must match the provider token counts exactly —
 *    the done-when checks that arithmetic.
 *
 * Pure module: plain JSON-serializable state, so it lives in chat_metadata.
 */

/** @typedef {{tokensIn: number, tokensOut: number, costUsd: number, calls: number}} RoleSpend */

const emptyRole = () => ({ tokensIn: 0, tokensOut: 0, costUsd: 0, calls: 0 });

export const SPEND_ROLES = Object.freeze(['extractor', 'composer', 'narrator']);

/** A fresh spend state. */
export function emptySpend() {
    return { extractor: emptyRole(), composer: emptyRole(), narrator: emptyRole() };
}

function isPositiveInt(v) {
    return Number.isInteger(v) && v > 0;
}

/**
 * Record one provider-reported usage sample against a role.
 *
 * @param {object} spend Mutable spend state (persisted in chat_metadata).
 * @param {'extractor'|'composer'|'narrator'} role
 * @param {{tokensIn?: number, tokensOut?: number}} usage Provider-reported.
 * @param {{prompt?: number, completion?: number}} [price] Per-token prices.
 * @returns {object} the same spend state.
 */
export function recordSpend(spend, role, usage, price = {}) {
    if (!spend || typeof spend !== 'object' || !SPEND_ROLES.includes(role)) {
        return spend ?? emptySpend();
    }
    if (!spend[role] || typeof spend[role] !== 'object') {
        spend[role] = emptyRole();
    }
    // A usage sample with no counts at all is not spend (e.g. a streamed
    // response that reported nothing) — recorded as zero, never invented.
    const tokensIn = isPositiveInt(usage?.tokensIn) ? usage.tokensIn : 0;
    const tokensOut = isPositiveInt(usage?.tokensOut) ? usage.tokensOut : 0;
    const prompt = Number(price?.prompt) || 0;
    const completion = Number(price?.completion) || 0;
    spend[role].tokensIn += tokensIn;
    spend[role].tokensOut += tokensOut;
    spend[role].costUsd += tokensIn * prompt + tokensOut * completion;
    spend[role].calls += 1;
    return spend;
}

/**
 * Per-role and combined totals. The combined figure is the sum of the roles —
 * "spend totals match provider token counts" is arithmetic here, not a claim.
 *
 * @param {object} spend
 */
export function spendSummary(spend) {
    const state = spend && typeof spend === 'object' ? spend : emptySpend();
    const roles = {};
    const combined = { tokensIn: 0, tokensOut: 0, costUsd: 0, calls: 0 };
    for (const role of SPEND_ROLES) {
        const r = state[role] && typeof state[role] === 'object' ? state[role] : emptyRole();
        roles[role] = {
            tokensIn: Number(r.tokensIn) || 0,
            tokensOut: Number(r.tokensOut) || 0,
            costUsd: Number(r.costUsd) || 0,
            calls: Number(r.calls) || 0,
        };
        combined.tokensIn += roles[role].tokensIn;
        combined.tokensOut += roles[role].tokensOut;
        combined.costUsd += roles[role].costUsd;
        combined.calls += roles[role].calls;
    }
    return { roles, combined };
}
