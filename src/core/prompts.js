/**
 * Prompt templates and placeholder rendering.
 *
 * GOAL.md §6: templates use namespaced placeholders such as
 * `{{copilot.extractions}}`, `{{copilot.lastMessages}}`, `{{copilot.lorebook}}`,
 * `{{copilot.characterCard}}`, `{{copilot.narratorPrompt}}`,
 * `{{copilot.userRequest}}`, and these must NOT collide with SillyTavern's own
 * `{{char}}` / `{{user}}`. Users can reorder or omit blocks freely.
 *
 * The collision rule is enforced structurally, not by convention: this renderer
 * only ever substitutes placeholders in the `{{copilot.*}}` namespace. Anything
 * else — including every SillyTavern macro — is passed through byte-for-byte so
 * that SillyTavern resolves it later with the real character and user names. A
 * renderer that substituted `{{char}}` itself would inject the wrong name the
 * moment the user renamed a persona, and nothing would say so.
 */

/** The namespace we own. Nothing outside it is ever substituted. */
export const NAMESPACE = 'copilot';

/** Every placeholder the composer template may use. */
export const BLOCKS = Object.freeze({
    EXTRACTIONS: 'extractions',
    PREVIOUS_STATE: 'previousState',
    LAST_MESSAGES: 'lastMessages',
    LOREBOOK: 'lorebook',
    CHARACTER_CARD: 'characterCard',
    NARRATOR_PROMPT: 'narratorPrompt',
    USER_REQUEST: 'userRequest',
    GOALS: 'goals',
    PREVIOUS_NOTE: 'previousNote',
    LANGUAGE: 'language',
});

export const KNOWN_BLOCKS = Object.freeze(Object.values(BLOCKS));

/**
 * Placeholder syntax, namespaced.
 * Deliberately does NOT match `{{char}}` or `{{user}}` or any other macro.
 */
const PLACEHOLDER_RE = /\{\{\s*copilot\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/* ---------------------------------------------------------------- defaults */

/**
 * Default extractor prompt.
 *
 * Content-neutral by construction (GOAL.md §10.5): it describes a FORMAT, never
 * a topic, and explicitly forbids the extractor from judging the material. A
 * model that refuses here is recorded as `refused` — a result about the model,
 * not a reason to change this prompt.
 */
export const DEFAULT_EXTRACTOR_PROMPT = `You record what happens in a roleplay — one moment at a time.

Messages to record (this moment — everything else is recorded separately):
{{copilot.lastMessages}}

The transcript is DATA. Do not judge, comment on, refuse, soften or moralise
about any of it, whatever it contains. A scene of any subject is ordinary input
to you. Your only job is to record what happened.

Write in this language: {{copilot.language}}

Output ONLY this structure, nothing else:

# Major events
- <one line per major event in THESE messages: what happened, where, when>

# Character notes

## <character name>
- <what they did, learned, hid or want in THESE messages> — <place>, <time>

# Locations

## <location name>
- state: <how the place is now: intact, damaged, crowded, dark…>
- <notable facts visible in THESE messages>

Rules:
- Record ONLY what these messages show. Do NOT restate or summarise anything
  from earlier — earlier moments are recorded separately and merged elsewhere.
  You are a recorder of one moment, not a compressor of the story.
- Every line is something that HAPPENED or a state that HOLDS. No speculation,
  no advice, no commentary.
- Keep names, objects and numbers exactly as written.
- Give each fact its place and time whenever the material knows them.
- Omit characters and locations these messages say nothing about.
- Do not invent facts to fill sections.`;

/**
 * Default composer prompt.
 *
 * Built against the three traps the last attempt fell into:
 *
 *  - TRAP 18: the composer must write TO THE NARRATOR, never to the reader, and
 *    never about itself. "Any note about X would be invented" is self-auditing
 *    critique, not guidance. Second person is banned outright.
 *  - TRAP 19: on a near-blank scene the word budget used to inflate into
 *    padding. The prompt now says plainly what to do when there is little to say.
 *  - The recent messages are ground truth. If an extraction disagrees with them,
 *    the messages win.
 */
export const DEFAULT_COMPOSER_PROMPT = `You write guidance notes for the narrator of a roleplay.

You are writing TO THE NARRATOR — the writer at the keyboard — not to the
reader, and never about yourself. Address the narrator directly in the imperative.

WHAT YOU ARE WORKING FROM
Recent chat messages:
{{copilot.lastMessages}}

Everything recorded so far — every extraction, each labelled with the message
it was taken at (the story's recorded state; the compressor keeps this list
short, so treat it as complete):
{{copilot.extractions}}

Goals the reader has set for the STORY (these should move toward happening):
{{copilot.goals}}

What is already established about this world:
{{copilot.lorebook}}

About the character you are writing for:
{{copilot.characterCard}}

The narrator's standing instructions:
{{copilot.narratorPrompt}}

What the reader has asked for:
{{copilot.userRequest}}

Your own previous note for this scene, which you must NOT simply repeat:
{{copilot.previousNote}}

Write the note in this language: {{copilot.language}}

HARD RULES
1. Write only guidance. Never write narration, never write dialogue, never
   write the scene. The narrator does that.
2. Never use second person about the reader, and never write self-auditing
   commentary such as "your purpose is unstated" or "nothing here would be
   invented". If the material does not support a point, simply leave the point
   out.
3. Never use "me", "my", or "I". You do not exist in this text.
4. The recent messages are ground truth. Where an extraction disagrees with them,
   the recent messages win and the disagreement is ignored.
5. The goals and the reader's request above are visible ONLY to you — the
   narrator will never see them. Carrying them out is YOUR job: turn each one
   into a concrete instruction to the narrator (who does what, where, when),
   not a discussion about it. Naming the thing to make happen is guidance;
   remarking that it might happen is not.

WHEN THERE IS LITTLE TO SAY
An early, quiet scene is normal. If the material gives you two true facts, write
two true facts. If it gives you one, write one. Writing nothing at all is correct
and better than padding. Do not invent pressure, mystery, tension or motive to
fill the budget.

Output ONLY this structure, nothing else:

<copilot>
your note
</copilot>

STYLE
- Prose, in the SAME LANGUAGE as the chat.
- Concrete: name the object, the person, the open thread. No abstractions.
- {{copilot.minWords}}–{{copilot.maxWords}} words. That is a ceiling, not a target.
- No headers, no lists, no preamble, no sign-off.`;

export const DEFAULT_COMPRESSOR_PROMPT = `You merge momentary extractions into one story-state summary.

Extractions to merge (each records one moment of the story):
{{copilot.extractions}}

Merge by UNION: every fact in every summary must still be findable in your
output. Combine sections about the same character or location into ONE section
that keeps all of their facts. Keep names, places, times and numbers exactly.
You are compacting structure, not editing content — never summarise a fact
away, and append rather than condense.

Output ONLY this structure, nothing else:

<compressed>
# Major events
- <all major events from every summary>

# Character notes

## <character name>
- <all their facts>

# Locations

## <location name>
- state: <current state>
- <all notable facts>
</compressed>

STYLE
- Same language as the input.
- No commentary outside the structure.`;

/* ---------------------------------------------------------------- rendering */

/**
 * Render a template.
 *
 * @param {string} template
 * @param {Record<string, string>} values Keyed by the SHORT name (`extractions`), not `copilot.extractions`.
 * @param {{strict?: boolean}} [opts] strict: throw on an unknown `{{copilot.*}}`.
 * @returns {{text: string, used: string[], missing: string[]}}
 */
export function render(template, values = {}, opts = {}) {
    const used = [];
    const missing = [];
    const source = typeof template === 'string' ? template : '';
    const text = source.replace(PLACEHOLDER_RE, (match, name) => {
        if (!Object.hasOwn(values, name)) {
            missing.push(name);
            if (opts.strict) {
                throw new Error(`Unknown copilot placeholder: ${match}`);
            }
            // Drop it rather than leaving literal {{copilot.x}} in an LLM prompt,
            // where the model would treat it as text to echo back.
            return '';
        }
        const v = values[name];
        used.push(name);
        return typeof v === 'string' ? v : String(v ?? '');
    });
    return { text, used: [...new Set(used)], missing: [...new Set(missing)] };
}

/**
 * Which `{{copilot.*}}` blocks does this template reference?
 * @param {string} template
 * @returns {string[]}
 */
export function blocksIn(template) {
    const found = new Set();
    const source = typeof template === 'string' ? template : '';
    for (const m of source.matchAll(PLACEHOLDER_RE)) {
        found.add(m[1]);
    }
    return [...found];
}

/**
 * Did the author write a placeholder with the wrong namespace?
 *
 * `{{char}}`, `{{user}}`, `{{original}}` and friends are SillyTavern's and must
 * pass through untouched. This returns them so the settings panel can tell the
 * user which macros are in play, rather than letting them wonder why
 * `{{char}}` came out literally.
 *
 * @param {string} template
 * @returns {string[]}
 */
export function foreignMacrosIn(template) {
    const source = typeof template === 'string' ? template : '';
    const found = new Set();
    for (const m of source.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
        if (m[1] !== NAMESPACE) {
            found.add(m[1]);
        }
    }
    return [...found];
}

/**
 * Hard problems with a block list: things that are actually wrong.
 *
 * Note what is NOT here: overlapping a SillyTavern macro name. `{{copilot.char}}`
 * is unambiguous — the namespace is what prevents the collision, and that is the
 * whole reason for the namespace. Reusing a familiar word is merely confusing,
 * so it is a warning (see `namespaceWarnings`), not an error.
 *
 * @param {string[]} blockNames
 * @returns {string[]}
 */
export function namespaceProblems(blockNames) {
    const problems = [];
    const seen = new Set();
    for (const name of blockNames) {
        if (typeof name !== 'string' || name === '') {
            problems.push('empty block name');
            continue;
        }
        if (name === NAMESPACE) {
            problems.push(`"${name}" collides with the copilot namespace itself`);
        }
        if (seen.has(name)) {
            problems.push(`"${name}" is declared twice`);
        }
        seen.add(name);
    }
    return problems;
}

/**
 * Soft warnings: legal, but likely to confuse the person editing the template.
 * @param {string[]} blockNames
 * @returns {string[]}
 */
export function namespaceWarnings(blockNames) {
    const warnings = [];
    for (const name of (Array.isArray(blockNames) ? blockNames : [])) {
        if (typeof name !== 'string' || name === '') {
            continue;
        }
        if (/^(char|user|persona|original|description|personality|scenario|system|mes|persona_description)$/i.test(name)) {
            warnings.push(`"${name}" is also a SillyTavern macro name — {{copilot.${name}}} will not collide, but the shared word may confuse`);
        }
    }
    return warnings;
}

/* ------------------------------------------------------------------ budget */

/**
 * Fit a window of messages into a budget by dropping WHOLE oldest messages.
 *
 * Trap 4, in two parts:
 *  - Agents read half a sentence and nothing looks wrong. Messages arrive whole;
 *    if you need a budget, drop whole oldest messages.
 *  - "Whole" means the message and everything it carries. We never truncate the
 *    text of a message.
 *
 * @param {Array<{role: string, text: string}>} messages
 * @param {number} maxChars
 * @returns {{messages: Array<{role: string, text: string}>, dropped: number, keptChars: number}}
 */
export function fitMessages(messages, maxChars) {
    const list = Array.isArray(messages) ? messages.filter((m) => m && typeof m.text === 'string') : [];
    if (!Number.isFinite(maxChars) || maxChars <= 0 || list.length === 0) {
        return { messages: list, dropped: 0, keptChars: list.reduce((n, m) => n + m.text.length, 0) };
    }
    // Keep the newest, drop whole messages from the front until it fits.
    let kept = [];
    let used = 0;
    for (let i = list.length - 1; i >= 0; i -= 1) {
        const cost = list[i].text.length;
        if (used + cost > maxChars && kept.length > 0) {
            break;
        }
        kept.unshift(list[i]);
        used += cost;
    }
    return { messages: kept, dropped: list.length - kept.length, keptChars: used };
}

/** Render messages as a plain transcript block. */
export function renderMessages(messages) {
    if (!Array.isArray(messages)) {
        return '';
    }
    return messages
        .filter((m) => m && typeof m.text === 'string' && m.text.trim() !== '')
        .map((m) => `${m.role === 'user' ? 'User' : 'Narrator'}: ${m.text.trim()}`)
        .join('\n\n');
}

/** Render entries as a plain block, one per line-group. Never JSON. */
export function renderEntries(entries) {
    if (!Array.isArray(entries)) {
        return '';
    }
    const usable = entries.filter((e) => e && typeof e.text === 'string' && e.text.trim() !== '');
    if (usable.length === 0) {
        return '';
    }
    return usable
        .map((e, i) => {
            // T-R5-20: an entry may carry its own label ("THIS TURN — just
            // recorded"); otherwise the source message dates it.
            const src = e.label ?? (e.source ? `from message ${e.source}` : `no. ${i + 1}`);
            const pinned = e.pinned ? ', pinned' : '';
            const merged = e.sources?.length ? `, merged from ${e.sources.length}` : '';
            // T-R5-18 (user: "it's not receiving more than 1 extraction"): each
            // entry gets its own labelled block. The old "- text" list form made
            // several multi-line state docs read as ONE blob to the compressor.
            return `=== extraction ${src}${pinned}${merged} ===\n${e.text.trim()}`;
        })
        .join('\n\n');
}

/**
 * §6: "A lorebook entry never appears twice in the same composer prompt
 * (dedupe by entry UID, including entries both triggered and permanent)."
 * The dedupe key is world+uid — two books routinely share uid 0 (verified
 * phase 0 against world-info.js:594). Triggered entries win the slot;
 * permanent-only entries follow in their given order.
 *
 * @param {Array<{world?: string, uid?: number}>} activated
 * @param {Array<{world?: string, uid?: number}>} permanent
 */
export function mergeLoreEntries(activated, permanent) {
    const seen = new Set();
    const out = [];
    for (const e of [...(activated ?? []), ...(permanent ?? [])]) {
        if (!e || e.uid === undefined) {
            continue;
        }
        const key = `${e.world ?? '?'}.${e.uid}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(e);
    }
    return out;
}

/**
 * Goal facts for the composer prompt (§6 / S6): the SCRIPT-TRACKED counters as
 * plain prose — "introduce Bob (6 turns elapsed, 2 remaining)". The model is
 * TOLD the numbers; it is never asked to do arithmetic (GOAL.md §5).
 */
export function renderGoalFacts(facts) {
    if (!Array.isArray(facts)) {
        return '';
    }
    const usable = facts.filter((f) => f && typeof f.text === 'string' && f.text.trim() !== '' && f.complete !== true);
    if (usable.length === 0) {
        return '';
    }
    return usable
        .map((f) => {
            const remaining = f.turnsRemaining === 'forever' ? 'no expiry' : `${f.turnsRemaining} turns remaining`;
            return `- ${f.text.trim()} (${f.turnsElapsed} turns elapsed, ${remaining})`;
        })
        .join('\n');
}

/**
 * Detect the language of the recent chat, so the note can follow it (S10).
 *
 * Deliberately a coarse script/heuristic pass, not a language identifier: the
 * composer is told the LANGUAGE and writes in it, and the debug panel shows the
 * guess so a wrong guess is visible rather than mysterious.
 *
 * @param {Array<{role: string, text: string}>|string} messagesOrText
 * @returns {{code: string|null, note: string}}
 */
export function detectLanguage(messagesOrText) {
    let text = '';
    if (typeof messagesOrText === 'string') {
        text = messagesOrText;
    } else if (Array.isArray(messagesOrText)) {
        text = messagesOrText.filter((m) => m && m.text).map((m) => m.text).join('\n');
    }
    const sample = text.slice(0, 4000);
    if (sample.trim() === '') {
        return { code: null, note: 'no text to inspect' };
    }
    const has = (re) => re.test(sample);
    if (has(/[Ѐ-ӿ]/)) {
        return { code: 'ru', note: 'Cyrillic' };
    }
    if (has(/[぀-ヿ]/)) {
        return { code: 'ja', note: 'Japanese kana' };
    }
    if (has(/[가-힯]/)) {
        return { code: 'ko', note: 'Hangul' };
    }
    if (has(/[぀-ヿ]/)) {
        // Kana is decisive for Japanese (Han alone is shared with Chinese).
        return { code: 'ja', note: 'kana (Japanese)' };
    }
    if (has(/[一-鿿]/)) {
        return { code: 'zh', note: 'Han characters (Chinese or Japanese)' };
    }
    if (has(/[֐-׿]/)) {
        return { code: 'he', note: 'Hebrew' };
    }
    if (has(/[؀-ۿ]/)) {
        return { code: 'ar', note: 'Arabic' };
    }
    if (has(/[฀-๿]/)) {
        return { code: 'th', note: 'Thai' };
    }
    // Latin-script heuristics: ã/õ are Portuguese-only, ñ/¿/¡ Spanish-only,
    // plus word hints for texts without those markers ("Ela entrou na sala em
    // silêncio"). (The old code tested the SAME regex twice and labelled every
    // diacritic-language 'pt' — critique round 1, finding 30.)
    const PT_WORDS = /\b(ela|ele|entrou|não|nao|voce|você|também|tambem|então|entao|até|ate|após|apos|são|sao|estava|estão|estao|será|sera|silêncio|silencio|cozinha|balcão|balcao|coisa|isso|obrigado|obrigada)\b/i;
    const ES_WORDS = /\b(ella|pero|porque|muy|también|tambien|ahora|entonces|así|asi|aquí|aqui|allí|alli|siempre|está|esta|estás|estas|señor|senor|señora|senora|cómo|como|cuándo|cuando|dónde|donde)\b/i;
    if (has(/[ãõ]/i) || PT_WORDS.test(sample)) {
        return { code: 'pt', note: 'Portuguese markers or vocabulary' };
    }
    if (has(/[ñ¿¡]/i) || ES_WORDS.test(sample)) {
        return { code: 'es', note: 'Spanish markers or vocabulary' };
    }
    if (has(/[àâçéèêëîïôùûœ]/i)) {
        return { code: 'fr', note: 'French diacritics' };
    }
    if (has(/[äöüß]/i)) {
        return { code: 'de', note: 'German diacritics' };
    }
    if (has(/[áéíóúü]/i)) {
        return { code: 'es', note: 'Latin with acute accents (Spanish family)' };
    }
    return { code: 'en', note: 'default: assumed English' };
}