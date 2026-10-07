/**
 * Scan a directory for anything shaped like an API key.
 *
 * Used before/after snapshotting a release copy ("make sure there are no api
 * keys on it by running a script over it first"). Prints file:line with the
 * match MASKED — never the literal. Exit 1 when anything is found.
 *
 *   node tests/scan-for-keys.mjs <directory>
 */

import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
if (!root || !fs.existsSync(root)) {
    console.error('usage: node tests/scan-for-keys.mjs <directory>');
    process.exit(2);
}

// Specific, well-known key shapes — any hit is a failure.
const PATTERNS = [
    ['openai/openrouter style key', /sk-[A-Za-z0-9_-]{16,}/g],
    ['github token', /gh[pousr]_[A-Za-z0-9]{20,}/g],
    ['aws access key', /AKIA[0-9A-Z]{16}/g],
    ['google api key', /AIza[0-9A-Za-z_-]{30,}/g],
    ['slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/g],
    ['bearer token literal', /Bearer\s+[A-Za-z0-9._-]{20,}/g],
    ['anthropic style key', /sk-ant-[A-Za-z0-9_-]{16,}/g],
];

// Suspicious but not certain: long bare high-entropy literals (warn only).
const SUSPICIOUS = /["'`][A-Za-z0-9+/_-]{40,}["'`]/g;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.css', '.html', '.txt', '.yml', '.yaml']);

const mask = (s) => `${s.slice(0, 6)}…${s.slice(-2)} (len ${s.length})`;

let failures = 0;
let warnings = 0;

const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) {
            if (!SKIP_DIRS.has(name)) {
                walk(p);
            }
            continue;
        }
        const ext = path.extname(name).toLowerCase();
        if (!TEXT_EXT.has(ext)) {
            continue;
        }
        const text = fs.readFileSync(p, 'utf8');
        for (const [label, re] of PATTERNS) {
            for (const m of text.matchAll(re)) {
                failures += 1;
                console.log(`FAIL  ${p}: ${label} — ${mask(m[0])}`);
            }
        }
        for (const m of text.matchAll(SUSPICIOUS)) {
            // Known false-positive shapes: urls, css values, the build id.
            const v = m[0];
            if (/^["']https?:/.test(v) || /copilot-phase/.test(v) || /SillyTavern-Copilot-/.test(v)) {
                continue;
            }
            warnings += 1;
            console.log(`warn  ${p}: suspicious literal — ${mask(v)}`);
        }
    }
};

walk(root);
console.log(`\n${failures} key-shaped match(es), ${warnings} suspicious literal(s) in ${root}`);
if (failures > 0) {
    console.log('RESULT: FAIL — remove the keys before shipping');
    process.exit(1);
}
console.log('RESULT: CLEAN — no API keys found');
