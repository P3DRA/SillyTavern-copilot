# copilot — PRODUCTION READY snapshot

- **Build**: `copilot-phase8-r14` (see `src/core/debug-log.js` for the id)
- **Taken**: 2026-10-07
- **Source**: `SillyTavern/public/scripts/extensions/third-party/copilot`
- **Key scan**: `tools/scan-for-keys.mjs` (shipped with this repo) run over this
  folder — **0 key-shaped matches** (2 warnings on the install-path string in
  this file — false positives). Re-run any time:
  `node tools/scan-for-keys.mjs .`

This is a frozen, key-free snapshot of the extension as of the build above,
labelled production ready by the project owner after hands-on testing (user
rounds T-R4-1 … T-R5-25; suite 229 suites / 1155 checks green).

## What it is

A SillyTavern extension with three agents:

| agent | role |
|---|---|
| **extractor** | records ONE moment per turn (messages not yet recorded) |
| **composer** | writes the `<copilot>` guidance note for the narrator |
| **compressor** | folds old extractions together (union merge, never drops facts) |

## Install

Copy this folder into `SillyTavern/public/scripts/extensions/third-party/copilot`
and reload the page. A key is entered in the panel (stored in ST's extension
settings) — never in these files.

## Known open item

- **Storage weight**: a 7-message chat file reached ~172KB with records. The
  record design keeps full traces for auditability (GOAL.md I1/I7); the
  size/audit trade-off study ships with this repo as `STORAGE-SIZE-REPORT.md`
  (recommended slim default projects 172KB → ~64KB).

## Bugs found during release audit

**6 bugs.** Full evidence in `RELEASE-READINESS.md`.

**1. No LICENSE file, while the README points readers at one.**
- Symptom: a stranger cloning the repo has no permission grant, and `README.md` says "License: TBD — see LICENSE" — a dead reference to a file that does not exist.
- Where: missing `LICENSE` at the repo root; `README.md` line 208 ("License / credits").
- Fix: the project owner picks a license, add it as `LICENSE` at the root, and replace "TBD" in README with the actual license name — required before publishing.

**2. `manifest.json` version contradicts the shipped build id.**
- Symptom: SillyTavern's extension manager shows `0.1.0-phase1` for a build the panel itself labels `copilot-phase8-r14`; ST would also treat it as older than any `0.2.x`.
- Where: `manifest.json` line 6 (`"version": "0.1.0-phase1"`) vs `src/core/debug-log.js` line 30 (`BUILD_ID = 'copilot-phase8-r14'`).
- Fix: set `version` to a real semver matching this release (e.g. `0.8.14` or `1.0.0`) and keep it in step with `BUILD_ID` from then on.

**3. `manifest.json` `homePage` is empty.**
- Symptom: no project link in the extension manager; every one of ST's 13 bundled manifests carries a URL, so this reads as an unfinished manifest.
- Where: `manifest.json` line 8 (`"homePage": ""`).
- Fix: set it to the public GitHub repository URL before publishing.

**4. The release doc tells readers to run a scanner that is not in the folder.**
- Symptom: `node tests/scan-for-keys.mjs <this folder>` fails for anyone who cloned the repo (`tests/` lives in the dev workspace, not here); and its "0 suspicious literals" claim no longer reproduces — a rerun prints 2 warnings (the install-path string).
- Where: `PRODUCTION-READY.md` lines 6–8.
- Fix: ship `tests/scan-for-keys.mjs` inside the repo (or rewrite the instruction with the full workspace path) and correct the claim to "0 key-shaped matches (2 path-string warnings)".

**5. The release doc references a file that is not in the release.**
- Symptom: "`STORAGE-SIZE-REPORT.md` in the workspace docs" cannot be found by anyone outside the dev workspace.
- Where: `PRODUCTION-READY.md` lines 34–35.
- Fix: ship `STORAGE-SIZE-REPORT.md` with the repo, or drop the pointer and summarize the finding in place.

**6. `README.md` and `PRODUCTION-READY.md` are untracked in git.**
- Symptom: `git push` today publishes a GitHub repo with **no README** (HEAD tracks only 21 files: `.gitignore`, `index.js`, `manifest.json`, `style.css`, `src/**`) — the install instructions never reach the repo page.
- Where: `git status --untracked-files=all` → `?? README.md`, `?? PRODUCTION-READY.md`.
- Fix: `git add README.md PRODUCTION-READY.md` (plus `RELEASE-READINESS.md` if it should be public) and commit before pushing.

**Fixed in this snapshot (mechanical items):** #2 (`manifest.json` version →
`1.0.0`, release 1.0.0 = build `copilot-phase8-r14`), #4 (scanner shipped as
`tools/scan-for-keys.mjs`), #5 (study shipped as `STORAGE-SIZE-REPORT.md`),
#6 (docs committed in this repo). **Still open — owner decisions:** #1 LICENSE
(pick one before publishing), #3 `homePage` (set the public repo URL before
publishing).
