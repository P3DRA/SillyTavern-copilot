/**
 * Schema migration.
 *
 * GOAL.md §5: the schema is fixed before any UI and is not changed without
 * asking. That means the ONLY sanctioned way to evolve it is to add a numbered
 * step here, bump `SCHEMA_VERSION`, and make every earlier version readable.
 *
 * Rules every step must obey:
 *  - I1: never delete. A step may add, rename by carrying data forward, or mark.
 *    It may not drop a field the user can see.
 *  - I3: bulk migration snapshots first (the caller passes `snapshot`).
 *  - I6: an unreadable record migrates to "no data", never to a guess.
 *  - A record written by a FUTURE version is left alone and reported, rather than
 *    being downgraded into something that looks valid but is not.
 *
 * Pure module: no I/O, no ST.
 */

import { SCHEMA_VERSION, MAX_SUPPORTED_VERSION, coerceSwipeRecord, makeSwipeRecord } from './records.js';
import { ROOT_KEY } from './store.js';

/**
 * @typedef {object} MigrationResult
 * @property {object|null} record    Migrated record, or null when it could not be read.
 * @property {boolean} migrated      Whether anything changed.
 * @property {number|null} from      Source version.
 * @property {number} to            Result version.
 * @property {string|null} problem   Why a record was dropped, if it was.
 * @property {string} status         'current' | 'migrated' | 'future' | 'unreadable'
 */

/**
 * One migration step. `from` is the version it upgrades FROM.
 * @typedef {object} MigrationStep
 * @property {number} from
 * @property {string} description
 * @property {(record: object, ctx: object) => object} up
 */

/**
 * Steps in ascending `from` order. Empty at v1; the shape is here so that adding
 * version 2 is a one-function change and not a redesign.
 * @type {MigrationStep[]}
 */
export const STEPS = [
    // {
    //     from: 1,
    //     description: 'example: v1 stored noteWords, v2 stores noteMinWords/noteMaxWords',
    //     up(record, ctx) {
    //         if (record.composer && record.composer.noteWords !== undefined) {
    //             record.composer.noteMaxWords = record.composer.noteWords;
    //             record.composer.noteMinWords = Math.floor(record.composer.noteWords * 0.6);
    //             delete record.composer.noteWords; // carries the value forward, never drops it silently
    //         }
    //         return record;
    //     },
    // },
];

/**
 * Migrate one stored record.
 * Never throws. Always reports what happened.
 *
 * @param {unknown} raw
 * @param {{chatId?: string, messageIndex?: number, swipeIndex?: number}} [ctx]
 * @returns {MigrationResult}
 */
export function migrateRecord(raw, ctx = {}) {
    if (raw === null || raw === undefined) {
        return { record: null, migrated: false, from: null, to: SCHEMA_VERSION, problem: 'absent', status: 'unreadable' };
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { record: null, migrated: false, from: null, to: SCHEMA_VERSION, problem: 'not an object', status: 'unreadable' };
    }

    const from = Number.isInteger(raw.version) ? raw.version : 0;

    if (from > MAX_SUPPORTED_VERSION) {
        // A newer build wrote this. Leave it exactly as it is and say so.
        return {
            record: raw,
            migrated: false,
            from,
            to: from,
            problem: `written by a newer copilot (schema v${from} > supported v${MAX_SUPPORTED_VERSION})`,
            status: 'future',
        };
    }

    let record;
    try {
        record = coerceSwipeRecord(raw);
    } catch (err) {
        return {
            record: null,
            migrated: false,
            from,
            to: SCHEMA_VERSION,
            problem: `could not normalise: ${err?.message ?? err}`,
            status: 'unreadable',
        };
    }

    let version = from;
    let migrated = false;
    for (const step of STEPS) {
        if (version === step.from) {
            const before = JSON.stringify(record);
            record = step.up(record, { ...ctx, from: version, to: step.from + 1 });
            if (JSON.stringify(record) !== before) {
                migrated = true;
            }
            version = step.from + 1;
        }
    }

    // Bumping the version IS a migration. Without this, a v0 record with no step
    // to run reports `migrated: false`, the caller leaves the old object in place,
    // and `needsMigration` stays true forever — a silent no-op upgrade.
    if (from !== SCHEMA_VERSION) {
        migrated = true;
    }
    record.version = SCHEMA_VERSION;
    // Carry anything the current schema does not know about through untouched.
    // I1: an unknown field may be data we cannot interpret yet; dropping it
    // would be silent destruction.
    for (const [k, v] of Object.entries(raw)) {
        if (!(k in record) && k !== 'version') {
            record[k] = v;
            migrated = true;
        }
    }

    return {
        record,
        migrated,
        from,
        to: SCHEMA_VERSION,
        problem: null,
        status: migrated ? 'migrated' : 'current',
    };
}

/**
 * Migrate every copilot record in a chat, in place.
 *
 * Walks `message.swipe_info[i].extra.copilot` — the authoritative per-swipe slot
 * (see store.js for why the mirror at `message.extra.copilot` is not walked).
 *
 * @param {object[]} chat
 * @param {{dryRun?: boolean}} [opts]
 */
export function migrateChat(chat, opts = {}) {
    const report = { changed: 0, inspected: 0, future: 0, unreadable: 0, problems: [] };
    if (!Array.isArray(chat)) {
        return report;
    }
    for (let mi = 0; mi < chat.length; mi += 1) {
        const infos = chat[mi]?.swipe_info;
        if (!Array.isArray(infos)) {
            continue;
        }
        for (let si = 0; si < infos.length; si += 1) {
            const root = infos[si]?.extra?.[ROOT_KEY];
            if (!root || typeof root !== 'object') {
                continue;
            }
            if (!Number.isInteger(root.version)) {
                root.version = 0;
            }
            if (root.version > MAX_SUPPORTED_VERSION) {
                report.future += 1;
                report.problems.push({ messageIndex: mi, swipeIndex: si, problem: `swipe root is schema v${root.version}` });
                continue;
            }
            if (root.version !== SCHEMA_VERSION && !opts.dryRun) {
                root.version = SCHEMA_VERSION;
            }

            if (!('record' in root) || root.record === null || root.record === undefined) {
                continue;
            }
            report.inspected += 1;
            const result = migrateRecord(root.record, { messageIndex: mi, swipeIndex: si });
            if (result.status === 'future') {
                report.future += 1;
                report.problems.push({ messageIndex: mi, swipeIndex: si, problem: result.problem });
                continue;
            }
            if (result.status === 'unreadable') {
                report.unreadable += 1;
                report.problems.push({ messageIndex: mi, swipeIndex: si, problem: result.problem });
                if (!opts.dryRun) {
                    // I6: degrade to no-data rather than keeping something unreadable.
                    root.record = null;
                }
                continue;
            }
            if (result.migrated && !opts.dryRun) {
                root.record = result.record;
                report.changed += 1;
            }
        }
    }
    return report;
}

/**
 * Does this chat need migrating at all? Cheap enough to call on every load.
 * @param {object[]} chat
 */
export function needsMigration(chat) {
    if (!Array.isArray(chat)) {
        return false;
    }
    for (const msg of chat) {
        const infos = Array.isArray(msg?.swipe_info) ? msg.swipe_info : [];
        for (const info of infos) {
            const root = info?.extra?.[ROOT_KEY];
            if (!root || typeof root !== 'object') {
                continue;
            }
            if (root.version !== SCHEMA_VERSION) {
                return true;
            }
            if (root.record && typeof root.record === 'object' && root.record.version !== SCHEMA_VERSION) {
                return true;
            }
        }
    }
    return false;
}

export { SCHEMA_VERSION, MAX_SUPPORTED_VERSION, makeSwipeRecord };