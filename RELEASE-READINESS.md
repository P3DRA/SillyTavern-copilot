# Release Readiness Audit — `copilot-production-ready`

- **Audited**: folder state of 2026-10-07 ~19:46 local (449 files, 2,645,094 bytes).
- **Scope**: public-release readiness of the snapshot as a SillyTavern third-party
  extension on GitHub. Every check below was run against the actual files in this
  folder (plus the local SillyTavern checkout at `C:\SL 6\SillyTavern` where ST
  behaviour had to be verified from source).
- **Snapshot note**: `README.md` (12,509 B) was **added to this folder during the
  audit** (mtime 19:44, after the initial inventory). All results below were
  re-run against the final 449-file state.

## Overall verdict: **NOT-READY**

One hard blocker (no LICENSE while the README points at one), plus four accuracy
bugs in the two markdown docs and in `manifest.json`. Nothing is wrong with the
code itself: it parses, every import resolves, and the secret scans are clean.
The fix list is short and mechanical — see "Top items to fix".

| # | Check | Result |
|---|---|---|
| 1 | manifest.json exists / valid / accurate | **FAIL** (loads, but version wrong, `homePage` empty; `loading_type` = NA) |
| 2 | LICENSE | **FAIL — REQUIRED before publishing** |
| 3 | Version coherence (BUILD_ID vs manifest vs README) | **FAIL** (manifest disagrees) |
| 4 | Dev cruft | **FAIL** (`.git/` = 85% of folder; 2 doc references point outside the folder) |
| 5 | Secrets (existing scanner + replication) | **PASS** (0 key-shaped matches, incl. all 53 git revisions) |
| 6 | Entry points / ES module integrity | **PASS** (18/18 modules parse; 45/45 relative imports resolve; no escapes) |
| 7 | i18n / UX panel text | **PASS** (English-only caveat) |
| 8 | Size | **PASS** (lean repo; heavy only because of `.git/`) |
| 9 | Browser compatibility | **PASS** (2 items need a README note) |
| 10 | Publish package contents | **FAIL** (missing LICENSE/CHANGELOG/.gitattributes; 2 files untracked) |

---

## 1. manifest.json — **FAIL** (loadable, but two fields wrong/empty)

`manifest.json` exists at the folder root, parses as valid JSON (verified with
`JSON.parse`), and ST can load it: `js`/`css` point at files that exist
(`index.js`, `style.css`), matching how `SillyTavern/public/scripts/extensions.js`
consumes them (`manifest.js` → line 429/814, `manifest.css` → line 782,
`manifest.version` → line 918, `manifest.requires` → lines 592–602).

Field-by-field:

| field | value | assessment |
|---|---|---|
| `display_name` | `"Copilot"` | **OK** — present; ST falls back to folder name only if missing (extensions.js:581) |
| `loading_order` | `100` | **OK** — used by `sortManifestsByOrder` |
| `js` / `css` | `index.js` / `style.css` | **OK** — both files exist; ST builds `/scripts/extensions/third-party/copilot/<file>` |
| `requires` / `optional` | `[]` / `[]` | **OK** — both arrays (non-arrays only warn, extensions.js:600); the extension needs no Extras modules |
| `version` | `"0.1.0-phase1"` | **WRONG** — contradicts the shipped build `copilot-phase8-r14` (see check 3). Displayed verbatim in the ST extension manager (extensions.js:918, 968) |
| `author` | `"Copilot Build"` | **OK-ish** — placeholder author; ST shows it as `extension_author` |
| `homePage` | `""` | **EMPTY** — all 13 ST-bundled manifests carry a URL (e.g. `vectors/manifest.json`). This ST build never dereferences `homePage` (0 non-manifest matches in `public/`), so it is a convention/metadata gap, not a loader failure — but it should hold the GitHub repo URL at publish |
| `auto_update` | `false` | **OK** — `false` means ST's updater skips it (extensions.js:1949), appropriate for now |
| `loading_type` | **absent** | **NA** — the string `loading_type` does not occur anywhere in the SillyTavern source tree (0 matches under `C:\SL 6\SillyTavern`), so this ST version neither requires nor reads it. Not a defect |
| `i18n` | **absent** | **NA / safe** — `addExtensionLocale` returns `Promise.resolve()` when the manifest has no `i18n` (extensions.js:848–852); a missing locale bundle cannot fail the load |

**What is missing or wrong (exact):** `version` is `"0.1.0-phase1"` instead of a
semver matching build `copilot-phase8-r14`; `homePage` is the empty string.
Everything else ST's loader reads is present and correctly typed.

## 2. License — **FAIL — REQUIRED before publishing**

- No `LICENSE` (any case, any extension) exists in the folder; it has never been
  tracked in git either (all 21 historical file names listed below in check 4
  contain no license file).
- Worse, `README.md` line 208 says: *"License: TBD — see LICENSE."* — it points
  readers at a file that does not exist.
- **A LICENSE file is REQUIRED before this goes public.** It must be chosen by
  the project owner (MIT/GPL/ARRL/proprietary etc. — **not invented by an
  auditor**); until then the repo ships no grant of rights to users.

## 3. Version coherence — **FAIL** (manifest disagrees with the build id)

Evidence:

- `src/core/debug-log.js:30` → `export const BUILD_ID = 'copilot-phase8-r14';`
- `PRODUCTION-READY.md:3` → **Build**: `copilot-phase8-r14` — **agrees** ✓
- `README.md:208` → `Build copilot-phase8-r14` — **agrees** ✓
- `manifest.json:6` → `"version": "0.1.0-phase1"` — **MISMATCH** ✗ (phase **1**
  label on a phase **8**, revision **14** build; also not aligned semver — it
  parses as `0.1.0` + prerelease `phase1`, so ST would treat it as an *older*
  release than any `0.2.x`)

The panel shows `build copilot-phase8-r14` (`index.js:2168`), so a user
comparing the panel to the extension manager sees two different identities.

## 4. Dev cruft — **FAIL**

What is in the folder (final inventory): root files `.gitignore`, `index.js`,
`manifest.json`, `PRODUCTION-READY.md`, `README.md`, `style.css`; dirs `src/`
(17 files) and `.git/` (426 files).

- **`.git/` ships inside the snapshot — 426 files, 2,239,115 bytes = 84.6% of
  the whole folder.** Per the task's ship-list this is dev cruft. Nuance: its
  history was verified clean for this audit (see check 5: 53 revisions, 0 key
  hits; author anonymised `Copilot Build <copilot-build@localhost>`, no personal
  identity), and `.gitignore` documents it as a deliberately separate repo. So:
  fine to *push as the repo's history*, but **strip it before attaching a ZIP of
  this folder as a release asset**, and do not treat the snapshot folder itself
  as the distributable.
- **Clean on the rest**: no `tests/`, no `node_modules/`, no `*.log`, no `.env`,
  no settings dumps, no screenshots/images, no personal config (cruft-name scan
  over all 449 files returned nothing).
- **No leaked absolute paths**: greps for `C:\`, `/home/`, `Users\`, `at\`
  across the folder → **0 matches**. No dev-machine path literals anywhere in
  shipped source.
- **Git-tracking gap (publish-relevant)**: `git status --untracked-files=all`
  → `?? README.md`, `?? PRODUCTION-READY.md`. HEAD tracks only 21 files
  (`.gitignore`, `index.js`, `manifest.json`, `style.css`, `src/**` ×17).
  A `git push` today would publish a GitHub repo **with no README**.
- **Dev-doc references that only make sense on the dev machine** (all in
  comments or the release doc, none executed by code):
  - `PRODUCTION-READY.md:6–8` — instructs `node tests/scan-for-keys.mjs <folder>`;
    `tests/` is **not in this folder** (it lives at `C:\SL 6\tests\`), so the
    instruction fails for a stranger.
  - `PRODUCTION-READY.md:34–35` — cites `STORAGE-SIZE-REPORT.md in the workspace
    docs`; that file is **absent** from the release.
  - Source comments (harmless): `GOAL.md`, `REPORT.md`, `tests/t1b/…`,
    `docs/ST-API-REPORT.md` — none ship; they read as internal design history.
- **Files >200 KB worth a look**: none. Largest is `index.js` at 178,896 B
  (174.7 KiB, 3,334 lines) — reviewed (check 6/7); a single big entry file,
  unusual but acceptable for a ST extension. Largest `.git` objects are ≤59.5 KiB
  compressed historical blobs of `index.js`.

## 5. Secrets — **PASS**

- **Existing scanner run**: `node C:\SL 6\tests\scan-for-keys.mjs "C:\SL 6\releases\copilot-production-ready"`
  → `0 key-shaped match(es), 2 suspicious literal(s)` → `RESULT: CLEAN — no API
  keys found` (exit 0). The 2 warnings are both the 59-character quoted install
  path `SillyTavern/public/scripts/extensions/third-party/copilot` in
  `PRODUCTION-READY.md` (lines 5 and 26) — a known false-positive shape, not a
  key. *(Doc drift: the doc claims "0 suspicious literals"; a rerun now prints 2.)*
- **Scanner coverage gap closed manually**: the scanner skips `.git/`
  (`SKIP_DIRS`, scan-for-keys.mjs:34), so the 426-object history was **not**
  covered by it. I additionally ran the scanner's exact patterns (`sk-…`,
  `gh[pousr]_…`, `AKIA…`, `AIza…`, `xox…`, `Bearer <20+ chars>`) across **all 53
  git revisions** (`git grep` per revision) → **0 hits**.
- **Literal audit of source**: every `sk-…` match in the tree is inside
  `src/core/redact.js` — the redaction regexes themselves (e.g. line 15
  `/sk-or-v1-[A-Za-z0-9_-]{8,}/g`) — or in comments about key shapes. `secret` /
  `apiKey` matches are field names, log messages and error guidance; no key
  value is present. The extension stores the key only in ST's extension settings
  at runtime (`index.js:160–169`) and redacts it from logs (`index.js:3316`).
- Git identity is anonymised (`Copilot Build <copilot-build@localhost>` in all
  revisions) — no personal name or address leaks.

## 6. Entry points — **PASS**

- `manifest.json` → `js: index.js`, `css: style.css`; both exist at the folder
  root.
- **ES module parse**: all 18 `.js` files (root + `src/`) parsed as ECMAScript
  modules (`vm.SourceTextModule`) → **18 parsed, 0 failures**.
- **Import resolution**: 45 relative specifiers across all files → **0
  unresolved** (every `./` / `../` target exists on disk).
- **No escapes outside the folder**: the deepest relative hops are
  `src/core/pipeline.js → ../schema/records.js` and `src/st/adapter.js →
  ../st/constants.js` (odd-looking but correctly resolves inside `src/`). No
  `../../` out-of-folder paths, no absolute `file://`, no bare specifiers
  (nothing imports a package name).
- **SillyTavern runtime imports (allowed)**: only dynamic `import()` of ST
  built-ins — `/script.js` (index.js:243), `/scripts/secrets.js` (:181),
  `/scripts/world-info.js` (:469), `/scripts/popup.js` (:1797) — plus the
  in-folder lazy `./src/schema/migrate.js` (:1992). No static import of ST
  runtime (correct — ST loads the extension as a module with its own scope).

## 7. i18n / UX completeness — **PASS** (English-only caveat)

Spot-checked panel markup (`index.js:2163–2194` header/log, settings block
`:2740–2860`, status/pilot logic `:2233–2257`, goal/preset inputs `:2282–2353`):

- All user-visible strings are complete, plain English with actionable tooltips
  (e.g. the 401/403 guidance at `:1509`, pilot-light explanation `:2247–2252`).
- **No debug jargon leaks**: the visible `debug log` heading and the
  `build copilot-phase8-r14` chip (`:2168`) are deliberate, documented features (README §panel). No `TODO`,
  `FIXME`, `lorem`, or unrendered `{{…}}` in UI text — the `{{copilot.goals}}`
  seen in a `title=` attribute (`:2282`) is intentional template documentation.
  `placeholder=` attributes are genuine UX hints, not leftovers.
- Caveat (not a bug): UI is English-only; no `i18n` bundle. Verified safe — ST
  skips manifests without `i18n` (extensions.js:848–852).

## 8. Size — **PASS**

- **Total folder**: 449 files, **2,645,094 bytes (≈2.52 MiB / 2.65 MB)**.
  - `.git/`: 426 files, 2,239,115 B (**84.6%**)
  - Shipped code/docs: 23 files, 405,979 B (**≈396 KiB**)
- **3 largest files**: `index.js` 178,896 B (174.7 KiB); `src/schema/store.js`
  23,663 B (23.1 KiB); `src/core/provider.js` 20,080 B (19.6 KiB).
- Nothing exceeds ~200 KB; no unusually heavy artifacts (no images, bundles,
  minified vendor files). `index.js` at 3,334 lines is the one "heavy" file
  worth a future split, but it is not a release blocker.

## 9. Browser compatibility — **PASS** (two items to note in README)

- `navigator.clipboard.writeText` — used twice, both inside button handlers
  (`index.js:3161` "Copy records", `:3193` "Copy log"). Requires a **secure
  context (https or localhost)** and a user gesture. SillyTavern normally runs
  on `http://localhost` (a secure context) — works; on a plain-HTTP LAN IP
  (`http://192.168.x.x`) the clipboard API is unavailable and those two Copy
  buttons will throw. Worth one README line.
- `AbortSignal.any` — `src/core/provider.js:220` is **feature-detected**
  (`typeof AbortSignal.any === 'function'`) with an `AbortController` fallback,
  so pre-Safari-17.4 / pre-Chrome-116 browsers are safe. No action needed.
- Dynamic `import()` of ST runtime modules — fine in every browser ST supports.
- Baseline APIs without guards: `Object.hasOwn` (`prompts.js:220`,
  `provider.js:83`), `structuredClone` (`migrate.js:95`, `transfer.js:83`,
  `store.js:143`), `Array#at` (`index.js:380` etc.). All are baseline in
  Chrome 98+/Firefox 94+/Safari 15.4+ — same floor as SillyTavern 1.18 itself;
  no note strictly required.

## 10. The publish package

**What the GitHub repo should contain:**

```
README.md            ✅ present (untracked in git — must `git add`)
LICENSE              ❌ MISSING — REQUIRED before publishing (owner chooses it)
CHANGELOG.md         ❌ add (stub: 0.8.14 / phase8-r14 = first public cut)
manifest.json        ✅ present — fix version + homePage first
index.js             ✅
style.css            ✅
src/                 ✅ 17 files (core/ schema/ st/)
.gitignore           ✅ fine to keep
.gitattributes       ❌ add (suggested: `* text=auto eol=lf`, plus linguist
                      hints if you don't want index.js dominating language stats)
.github/             ❌ optional but recommended: issue templates, a CI workflow
                      that runs `node tests/scan-for-keys.mjs .` + `node --check`
PRODUCTION-READY.md  ⚠️ decide: fix its two out-of-folder references (bugs 4–5)
                      and ship it as release-process notes, or keep it internal
RELEASE-READINESS.md ⚠️ internal by default; publish only if you want the audit
                      trail visible
```

**Must be excluded / decided:**

- `.git/` — if the release artifact is a **ZIP of this folder**, strip it
  (426 files / 2.14 MiB of dev cruft in a download). If the artifact is **the
  GitHub repo itself**, keep it — its history is verified key-clean (53
  revisions, 0 hits, anonymised author) and pushing it is how the repo gets
  published. Either way do not ship it twice (repo + zip).
- Do **not** copy in anything from the dev workspace (`tests/`, `GOAL.md`,
  `REPORT.md`, `docs/`, `secret.md`) without a separate audit pass.

---

## Summary

- **Verdict: NOT-READY** (blocked on LICENSE; 6 bugs total — see
  `PRODUCTION-READY.md` § "Bugs found during release audit").
- **Bug count: 6.**
- **Top 3 items to fix:**
  1. **Add a LICENSE** chosen by the owner and replace `README.md:208`'s
     *"License: TBD — see LICENSE"* — publishing without this is the hard blocker.
  2. **Fix `manifest.json`**: set `version` to a real semver matching build
     `copilot-phase8-r14` (drop `0.1.0-phase1`), and fill `homePage` with the
     GitHub repo URL.
  3. **Fix the two doc defects a stranger hits first**: the unusable
     `tests/scan-for-keys.mjs` instruction (plus its stale "0 suspicious
     literals" claim) and the absent `STORAGE-SIZE-REPORT.md` pointer in
     `PRODUCTION-READY.md` — then `git add README.md PRODUCTION-READY.md` so a
     push actually publishes them.
