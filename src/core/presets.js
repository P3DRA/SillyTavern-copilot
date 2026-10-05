/**
 * Presets (GOAL.md §6): "hot-swappable bundles of extractor/composer model +
 * configuration (e.g. 'fast', 'heavy')."
 *
 * A preset is a snapshot of the two role configurations. Applying one returns
 * a PATCH — the caller merges it into settings — so applying a preset can
 * never wipe the key, the injection settings or anything else it does not
 * carry (I1's spirit applied to configuration).
 *
 * Pure module: no DOM, no host, no storage.
 */

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

let idCounter = 0;

function newPresetId() {
    idCounter = (idCounter + 1) % 0xffff;
    return `pre_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/** The configuration fields a preset swaps. */
export const PRESET_FIELDS = Object.freeze([
    'chain', 'retries', 'temperature', 'maxChars', 'maxTokens', 'minWords', 'maxWords', 'prompt',
]);

function pickRole(role) {
    const out = {};
    if (!role || typeof role !== 'object') {
        return out;
    }
    for (const field of PRESET_FIELDS) {
        if (role[field] !== undefined) {
            out[field] = Array.isArray(role[field]) ? [...role[field]] : role[field];
        }
    }
    return out;
}

/**
 * @param {{id?: string, name: string, extractor?: object, composer?: object}} init
 */
export function makePreset(init = {}) {
    return {
        id: init.id || newPresetId(),
        name: typeof init.name === 'string' ? init.name.trim() : '',
        extractor: pickRole(init.extractor),
        composer: pickRole(init.composer),
    };
}

/**
 * Snapshot the current configuration as a named preset.
 * @param {string} name
 * @param {{extractor?: object, composer?: object}} settings
 */
export function presetFromSettings(name, settings) {
    return makePreset({
        name,
        extractor: settings?.extractor,
        composer: settings?.composer,
    });
}

/**
 * The patch that applies this preset to settings. Only the preset's own
 * fields move; anything else is untouched.
 * @param {object} preset
 * @returns {{extractor: object, composer: object}}
 */
export function applyPreset(preset) {
    return {
        extractor: pickRole(preset?.extractor),
        composer: pickRole(preset?.composer),
    };
}

/**
 * Save `preset` into a preset list, replacing a same-id entry.
 * @param {object[]} list
 * @param {object} preset
 * @returns {object[]} a NEW list (I1: the input is not mutated).
 */
export function upsertPreset(list, preset) {
    const safe = Array.isArray(list) ? list.filter((p) => p && isNonEmptyString(p.name)) : [];
    const entry = makePreset(preset);
    if (!isNonEmptyString(entry.name)) {
        return safe;
    }
    return [...safe.filter((p) => p.id !== entry.id), entry];
}

/**
 * Remove one preset by id. @param {object[]} list @param {string} id
 */
export function removePreset(list, id) {
    return (Array.isArray(list) ? list : []).filter((p) => p && p.id !== id);
}
