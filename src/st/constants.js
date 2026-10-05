/**
 * SillyTavern constants the copilot depends on, mirrored with their provenance.
 *
 * WHY THIS FILE EXISTS
 *
 * The copilot cannot `import` these from SillyTavern's own modules: `script.js`
 * and `constants.js` are page globals loaded long before third-party extensions,
 * and importing them from a test would pull in the whole DOM-dependent page.
 *
 * So they are mirrored here, and `tests/t1b/st-constants.test.mjs` reads
 * SillyTavern's ACTUAL SOURCE and fails if any value has drifted. That converts
 * "we hard-coded it and forgot" into a red test the moment ST is upgraded.
 *
 * Every entry carries the file and line it was read from, verified against
 * SillyTavern 1.18.0 (git 8172dcd0e).
 *
 * Nothing here has behaviour. It is data only, and it is safe to import in Node.
 */

/* --------------------------------------------------------------- injection */

/** public/script.js:483-488 */
export const PROMPT_TYPE = Object.freeze({
    NONE: -1,
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
});

/** public/script.js:493-497 */
export const PROMPT_ROLE = Object.freeze({
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
});

/** public/script.js:499 */
export const MAX_INJECTION_DEPTH = 10000;

/**
 * Our own injection key namespace.
 *
 * SillyTavern sorts extension prompts by key (`public/script.js:3251`), so the
 * prefix is not cosmetic: it decides where our note lands relative to every
 * other extension's injected text. Reserved keys are listed in
 * `public/scripts/constants.js:48-56` — we must not collide with any of them.
 */
export const INJECT_KEY = {
    NOTE: 'copilotNote',
    DEPTH_PROMPT: 'copilotDepthPrompt',
};

/**
 * Reserved SillyTavern injection keys we must never reuse.
 * public/scripts/constants.js:48-56
 */
export const RESERVED_INJECT_KEYS = Object.freeze([
    '__STORY_STRING__',
    'QUIET_PROMPT',
    'DEPTH_PROMPT',
    'customDepthWI',
    'customWIOutlet_',
]);

/* ------------------------------------------------------------------ events */

/**
 * Event string values from `public/scripts/events.js`.
 *
 * These are the exact strings to register against, not enum keys — GOAL.md warns
 * that at least one of them (`GENERATION_AFTER_COMMANDS`) is NOT lower-cased
 * like its neighbours, which is exactly the kind of thing that fails silently.
 */
export const EVENT = Object.freeze({
    // Generation lifecycle
    GENERATION_STARTED: 'generation_started',
    GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
    GENERATION_ENDED: 'generation_ended',
    GENERATION_STOPPED: 'generation_stopped',

    // The prompt-injection hooks (see docs/ST-API-REPORT.md 7.1)
    CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
    GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',

    // Messages
    MESSAGE_SENT: 'message_sent',
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
    MESSAGE_EDITED: 'message_edited',
    MESSAGE_DELETED: 'message_deleted',
    MESSAGE_UPDATED: 'message_updated',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',

    // Chat lifecycle
    CHAT_CHANGED: 'chat_id_changed',
    CHAT_LOADED: 'chatLoaded',

    // World info
    WORLD_INFO_ACTIVATED: 'world_info_activated',
    WORLDINFO_SCAN_DONE: 'worldinfo_scan_done',
    WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',

    // Settings / secrets
    EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
    APP_READY: 'app_ready',
    SECRET_WRITTEN: 'secret_written',
});

/* ------------------------------------------------------------- generation */

/**
 * Generation types SillyTavern can pass to `Generate`.
 * public/scripts/constants.js:36-43
 */
export const GENERATION_TYPE = Object.freeze({
    NORMAL: 'normal',
    CONTINUE: 'continue',
    IMPERSONATE: 'impersonate',
    SWIPE: 'swipe',
    REGENERATE: 'regenerate',
    QUIET: 'quiet',
});

/**
 * Generation types that are NOT a normal narrator turn.
 *
 * Trap 14 requires every path that declines to inject to log why. This is the
 * set of reasons, taken from GOAL.md's own scenarios:
 *   - 'impersonate' the user speaks; the narrator is not generating
 *   - 'continue'    the narrator continues its own text; no new turn
 *   - 'quiet'       a silent/system generation (public/script.js:4240 payload)
 */
export const NON_NARRATOR_TYPES = Object.freeze([
    GENERATION_TYPE.IMPERSONATE,
    GENERATION_TYPE.QUIET,
]);

/* ------------------------------------------------------------ storage keys */

/**
 * Where copilot data lives inside a SillyTavern message.
 *
 * `message.extra` is a MIRROR that ST replaces wholesale by deep clone on every
 * swipe navigation (public/script.js:6956) and pushes back down on every save
 * (:6880). The authoritative per-swipe slot is `swipe_info[i].extra`
 * (public/global.d.ts:83-88).
 */
export const MESSAGE_PATHS = Object.freeze({
    PER_SWIPE_EXTRA: 'swipe_info',
    CURRENT_SWIPE: 'swipe_id',
    SWIPES: 'swipes',
    MIRROR_EXTRA: 'extra',
});

/** Our key inside that extra bag. */
export const ROOT_KEY = 'copilot';

/** The tag wrapped around the injected note. */
export const NOTE_TAG = 'copilot';