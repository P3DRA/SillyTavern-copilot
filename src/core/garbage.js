/**
 * Output validation: is this answer usable, and if not, why?
 *
 * GOAL.md §6 defines "garbage" as empty output, missing required tag/format,
 * length out of bounds, or a refusal. It also demands the rules be "defined in
 * code and visible in settings" — everything here is a named, tunable constant
 * so the debug panel can show exactly which rule rejected an attempt.
 *
 * TRAP 3, and the reason this file is so careful:
 *
 *   A refusal detector that matches ordinary roleplay deletes content.
 *   "I can't believe you'd do that" is DIALOGUE. A real refusal is short and
 *   meta: it talks about the request instead of answering it.
 *
 * So the refusal test inspects only the OPENING of the output, and gives up on
 * anything long enough to be an answer. "I can't believe you'd do that" is nine
 * words of in-scene reaction; "I can't help with that" is a meta refusal. The
 * length cutoff is what separates them, and it is a single named constant so it
 * is visible and adjustable rather than buried in a regex.
 *
 * Content-neutrality (GOAL.md §10.5): nothing in this file filters, moralises,
 * judges or sanitises. It classifies model failures so the fallback chain can
 * move on. A model that complains about adult content is recorded as `refused`,
 * which is a TEST RESULT about the model, never a reason to change the request.
 */

/** Reasons an attempt is rejected. Surfaced verbatim in the debug panel. */
export const REJECT = Object.freeze({
    EMPTY: 'empty',
    THINKING_ONLY: 'thinking_only',
    MISSING_TAG: 'missing_tag',
    UNCLOSED_TAG: 'unclosed_tag',
    TOO_SHORT: 'too_short',
    TOO_LONG: 'too_long',
    REFUSED: 'refused',
    MALFORMED: 'malformed',
    NOT_PROSE: 'not_prose',
});

/* ------------------------------------------------------------------ tuning */

export const LIMITS = Object.freeze({
    /**
     * Words. A note below this is not guidance, it is a shrug; above it, it is
     * not a note, it is narration. GOAL.md §6 makes length configurable, and
     * PROBLEMS.md §4.2 records that the old 120-300 budget inflated on empty
     * scenes — so the default is deliberately lower and the prompt tells the
     * composer to write less when there is little to say.
     */
    MIN_WORDS: 15,
    MAX_WORDS: 120,

    /**
     * TRAP 3, the critical one. Refusal detection only ever looks at this many
     * LEADING words. "I can't believe you'd do that" is dialogue and lives
     * comfortably inside a short scene's opening; "I can't help with that
     * request" is meta. Everything longer than this is treated as an answer and
     * is never rejected for refusal.
     */
    REFUSAL_HEAD_WORDS: 25,

    /**
     * A refusal is also short overall. Lengthy output is a failed attempt to
     * answer, not a refusal, and must not be deleted (trap 3, again).
     */
    REFUSAL_MAX_WORDS: 60,
});

/* ------------------------------------------------------------- the patterns */

/**
 * The verbs that make a modal clause META rather than in-scene.
 *
 * This is the distinction that separates "I can't help with that request" (a
 * model talking about its job) from "I won't take that from anyone" (a person
 * talking about a thing). Without requiring one of these, the pattern
 * `I'm sorry, but I <modal>` swallows ordinary dialogue — which is precisely how
 * a refusal detector ends up deleting content (trap 3).
 */
const TASK_VERB = String.raw`(?:help|assist|comply|do|provide|create|generate|write|fulfil|fulfill|support|engage|produce|share|continue|answer|respond|write\s+that)`;

/**
 * Meta-refusal openings. Deliberately narrow.
 *
 * Each is anchored to the START of the output (after optional markdown
 * decoration), because a refusal announces itself in its first breath. Matching
 * anywhere in the text is what deleted "I can't believe you'd do that" from an
 * ordinary scene in the previous build.
 *
 * Note what is NOT here: no keywords about violence, sex, minors, or any other
 * topic. A topic is not a failure mode. Only the SHAPE of a refusal counts.
 */
const REFUSAL_OPENINGS = [
    new RegExp(String.raw`^i\s+(?:can(?:no|'|')?t|won'?t|am\s+not\s+able\s+to|am\s+unable\s+to)\s+${TASK_VERB}\b`, 'i'),
    new RegExp(String.raw`^i\s+(?:can(?:no|'|')?t|won'?t|am\s+not\s+able\s+to|am\s+unable\s+to)\s+with\s+(?:that|this)\b`, 'i'),
    // Requires a task verb: "I'm sorry, but I can't do that" refuses;
    // "I'm sorry, but I won't take that from anyone" is a character speaking.
    new RegExp(String.raw`^i'?m\s+(?:sorry|afraid)\s*,?\s*but\s+i\s+(?:can(?:no|'|')?t|cannot|won'?t|will\s+not|am\s+not\s+able\s+to|am\s+unable\s+to)\s+${TASK_VERB}\b`, 'i'),
    // "I am unable TO help" needs the optional "to" before the task verb.
    new RegExp(String.raw`^(?:sorry|unfortunately)\s*,?\s*(?:but\s+)?i\s+(?:can(?:no|'|')?t|am\s+unable(?:\s+to)?|cannot|won'?t)\s+${TASK_VERB}\b`, 'i'),
    /^as\s+an\s+ai(?:\s+(?:language\s+)?model)?\b/i,
    /^i\s+can(?:no|'|')?t\s+(?:and\s+won'?t|or)\s+/i,
    /^(?:i\s+)?(?:must|have\s+to)\s+(?:decline|refuse)\b/i,
    /^that\s+(?:request|scenario|prompt)\s+(?:is|goes)\s+(?:not\s+something\s+i|against)\b/i,
];

/**
 * Non-answers that are not refusals but are equally useless.
 * Checked only when the required structure is absent, so a real prose answer is
 * never caught by these.
 */
const NON_PROSE = [
    /^\s*[[{][\s\S]*[\]}]\s*$/,       // a bare JSON object/array
    /^\s*```[\s\S]*```\s*$/,           // a bare code fence
    /^\s*```/,                         // an UNTERMINATED fence: the model started a code block
                                         // and never closed it. This is what truncated or
                                         // derailed output looks like, and it is not prose.
    /^\s*[\w.]+@[\w.]+\s*$/,           // an email
];

/* ------------------------------------------------------------------ helpers */

export function countWords(text) {
    if (typeof text !== 'string') {
        return 0;
    }
    const trimmed = text.trim();
    return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Strip the decoration a model adds around an answer: markdown bold/italic,
 * surrounding quotes, a leading tag on its own, trailing whitespace.
 *
 * Does NOT strip sentence content. Trimming quotes is safe because a refusal
 * never hides inside a quote mark.
 */
function normaliseForMatching(text) {
    let s = String(text ?? '').trim();
    // A model that wrapped its whole answer in ** or * or " or >.
    s = s.replace(/^(?:\*\*|\*|>|"|')+/, '').replace(/(?:\*\*|\*|"|')+$/, '').trim();
    return s;
}

/**
 * Extract the body of the required tag, if the output has it.
 * @param {string} text
 * @param {string} tag
 * @returns {{ok: true, body: string}|{ok: false, reason: string}}
 */
export function extractTag(text, tag) {
    const s = String(text ?? '');
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    const openAt = s.indexOf(open);
    if (openAt === -1) {
        return { ok: false, reason: REJECT.MISSING_TAG };
    }
    const bodyStart = openAt + open.length;
    const closeAt = s.indexOf(close, bodyStart);
    if (closeAt === -1) {
        // Trap 4: a truncated answer. Distinguishable from garbage, and the
        // reason string says so, because the fix is a bigger token budget.
        return { ok: false, reason: REJECT.UNCLOSED_TAG };
    }
    return { ok: true, body: s.slice(bodyStart, closeAt).trim() };
}

/**
 * Is the opening of this text a meta-refusal?
 *
 * Two guards, both required, and trap 3 is the reason for both:
 *  - only the first REFUSAL_HEAD_WORDS words are inspected
 *  - text longer than REFUSAL_MAX_WORDS is never a refusal, however it starts
 *
 * @param {string} text
 * @param {{headWords?: number, maxWords?: number}} [opts]
 * @returns {{refused: boolean, matched: string|null}}
 */
export function detectRefusal(text, opts = {}) {
    const headWords = opts.headWords ?? LIMITS.REFUSAL_HEAD_WORDS;
    const maxWords = opts.maxWords ?? LIMITS.REFUSAL_MAX_WORDS;

    const normalised = normaliseForMatching(text);
    if (normalised === '') {
        return { refused: false, matched: null };
    }
    const total = countWords(normalised);

    // Guard 2 first: a long output is a failed attempt to answer, not a refusal.
    if (total > maxWords) {
        return { refused: false, matched: null };
    }

    const words = normalised.split(/\s+/);
    const head = words.slice(0, headWords).join(' ');
    for (const pattern of REFUSAL_OPENINGS) {
        if (pattern.test(head)) {
            return { refused: true, matched: pattern.source };
        }
    }
    return { refused: false, matched: null };
}

/* ---------------------------------------------------------------- the judge */

/**
 * Judge one composer/extractor output.
 *
 * Pure, total, never throws. Returns a verdict object the caller logs verbatim.
 *
 * @param {unknown} raw
 * @param {object} [opts]
 * @param {string} [opts.tag]             Required tag, e.g. 'copilot'. Omit to skip tag checks.
 * @param {boolean} [opts.allowEmpty]     The content-neutral path: never judge, never reject.
 * @param {number} [opts.minWords]
 * @param {number} [opts.maxWords]
 * @param {string} [opts.reasoning]       Reasoning text, if the provider returned any (trap 17).
 * @returns {{ok: boolean, text: string, reason: string|null, words: number, detail: string}}
 */
export function judge(raw, opts = {}) {
    const {
        tag = null, allowEmpty = false, reasoning = '',
        minWords = LIMITS.MIN_WORDS, maxWords = LIMITS.MAX_WORDS,
    } = opts;

    const text = typeof raw === 'string' ? raw : '';
    const trimmed = text.trim();

    if (allowEmpty) {
        return { ok: true, text: trimmed, reason: null, words: countWords(trimmed), detail: 'judge disabled (content-neutral path)' };
    }

    if (trimmed === '') {
        // Trap 17: an empty answer that carries reasoning means the token budget
        // was too small, NOT that the model refused. Saying so precisely is what
        // lets the caller retry with a bigger budget instead of switching models.
        const hasReasoning = typeof reasoning === 'string' && reasoning.trim() !== '';
        return {
            ok: false,
            text: '',
            reason: hasReasoning ? REJECT.THINKING_ONLY : REJECT.EMPTY,
            words: 0,
            detail: hasReasoning
                ? 'empty content with reasoning tokens — token budget too small'
                : 'empty output',
        };
    }

    let body = trimmed;
    if (tag) {
        const extracted = extractTag(trimmed, tag);
        if (!extracted.ok) {
            return { ok: false, text: trimmed, reason: extracted.reason, words: countWords(trimmed), detail: describeTagFailure(tag, extracted.reason) };
        }
        body = extracted.body;
    }

    // Refusal is judged on the BODY, so a model that wrapped a refusal in the
    // required tag is still caught — and ordinary roleplay inside the tag is
    // judged on the same narrow rules as always.
    const refusal = detectRefusal(body);
    if (refusal.refused) {
        return {
            ok: false,
            text: body,
            reason: REJECT.REFUSED,
            words: countWords(body),
            detail: `meta-refusal opening: ${refusal.matched}`,
        };
    }

    const words = countWords(body);
    if (NON_PROSE.some((p) => p.test(body))) {
        return { ok: false, text: body, reason: REJECT.NOT_PROSE, words, detail: 'output is not prose' };
    }
    if (words < minWords) {
        return { ok: false, text: body, reason: REJECT.TOO_SHORT, words, detail: `${words} words < ${minWords}` };
    }
    if (words > maxWords) {
        return { ok: false, text: body, reason: REJECT.TOO_LONG, words, detail: `${words} words > ${maxWords}` };
    }

    return { ok: true, text: body, reason: null, words, detail: `${words} words` };
}

function describeTagFailure(tag, reason) {
    if (reason === REJECT.MISSING_TAG) {
        return `no <${tag}> tag in the output`;
    }
    return `<${tag}> was opened but never closed — output was probably truncated`;
}

/**
 * A one-line human summary for the debug panel.
 * @param {{ok: boolean, reason: string|null, detail: string}} verdict
 */
export function describeVerdict(verdict) {
    return verdict?.ok ? `accepted (${verdict.detail})` : `rejected: ${verdict.reason} — ${verdict.detail}`;
}