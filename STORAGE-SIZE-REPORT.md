# Storage-size report — SillyTavern Copilot extension

**Scope:** read-only analysis of the copilot extension's chat-file footprint, with one
deliverable: this file. No other file was modified.
**Measured baseline:** the owner's 7-message chat ≈ **172 KB** with copilot data present.
**Date of measurements:** artifacts in `tests/runs/*` (dated 2026-10-06) plus the current
source in `SillyTavern/public/scripts/extensions/third-party/copilot/`.

---

## 0. How the numbers were produced (and corrections to the brief)

Everything below is verified against code, not against the summary in the task.

| Claim in the brief | Verdict after reading the code |
|---|---|
| Per-swipe record at `msg.swipe_info[i].extra.copilot.record` | **Confirmed.** `src/schema/store.js:62-72` (`peekSwipeRoot`), factories in `src/schema/records.js:57-232`. |
| A mirror on `msg.extra.copilot` | **Confirmed.** `store.js:124-147` — `mirrorToMessageExtra()` does `message.extra[ROOT_KEY] = structuredClone(root)` and only for the current swipe. Reason: `saveReply` rebuilds `swipe_info[0]` wholesale from `message.extra` during generation (comment cites `script.js:6744-6749`), and ST's own sync (`script.js:6880` `targetSwipeInfo.extra = structuredClone(targetMessage.extra)`, `script.js:6956` the reverse) treats `message.extra` as the mirror. |
| Snapshots are "up to 5, each a FULL CHAT CLONE" | **Half right.** `MAX_SNAPSHOTS = 5` (`records.js:451`), but a snapshot is **not** a full chat clone: `snapshotChat()` (`store.js:458-480`) copies only the copilot roots of each `swipe_info[i].extra.copilot` (plus `messageIndex`/`swipeIds`) — **no message text**. It is a full clone of the *record set*, which is exactly what makes it big: it includes the traces. |
| `trace.extractorIn` / `trace.composerIn` hold "full rendered prompts (~1–2.5 KB each)" | **Partly.** `buildTrace()` (`index.js:1355-1363`) stores the full rendered inputs **but bounded at `TRACE_CAP = 4000` chars per field** with an explicit `… [+N chars]` marker (`index.js:1348-1354`, redaction applied first per F12). Measured raw inputs for a 7-message chat: extractor 1.2–1.9 KB, composer 2.2–5.2 KB; for a long chat they reach 7.9 KB / **48 KB** — so `composerIn` is clipped at 4 KB from roughly turn 2 onward. |
| Trace holds "full copies of the … prompts" | **The true unclipped artifact is the DebugLog copy payload** (`src/core/debug-log.js`), which is RAM-only (`MAX_TURNS = 50`, `MAX_EVENTS = 500`, `debug-log.js:32-35`). Its `toText()` clips *per line* at 2000 chars with a marker (`debug-log.js:146,232-235`). So I7 today has two layers: exact-in-RAM (50 turns), 4000-char-marked on disk. |
| 7-message chat ≈ 172 KB | **Reproduced as a reconstruction** (§2). The three measured 7-message fixtures (`tests/runs/S6-…`, `S14-…`, `S8-…`) contain 7 messages / 4 `swipe_info` entries / **3 records + 3 mirrors** and weigh **17.9 / 25.5 / 28.9 KB compact** (S8/S14/S6) *without* persisted traces (those run artifacts predate trace persistence — no record in any run has a `trace` key). Attaching traces built from the runs' **real rendered inputs** (read from `debug-log.txt`) lifts the S6 fixture from 28.9 KB to 67.4 KB compact. The remaining gap to 172 KB is the snapshots ring (§2). |
| Chat file format | ST saves chats as **compact JSONL**, one `JSON.stringify(message)` per line (`SillyTavern/src/endpoints/chats.js:457-466`); `chat_metadata` rides in line 0. All byte figures below are **compact JSON** (the pretty-printed `tests/runs/*/chat.json` files are ~32 % larger than the same data on disk in a real chat). |

**Measurement sources used throughout**

* Prompt lengths (node, measured): `DEFAULT_EXTRACTOR_PROMPT` **1376** chars, `DEFAULT_COMPOSER_PROMPT` **2550** chars, `DEFAULT_COMPRESSOR_PROMPT` **836** chars (`src/core/prompts.js:53-203`).
* Real rendered inputs (parsed out of `tests/runs/S6-…/debug-log.txt`): extractor `1230 / 1449 / 1870` chars, composer `2187 / 3598 / 5234` chars across the three turns. From the 133-message continuity run: extractor up to `7966`, composer up to `48182` chars.
* Per-record byte breakdown (3 records, S6 fixture + real traces attached, compact JSON): **31.9 KB total** — see §1.
* Field-length ranges from live runs: `extraction.text` 554–3475 chars; `composer.text` 445–520 chars (bounded by `LIMITS.MIN_WORDS = 15` / `MAX_WORDS = 120`, `garbage.js:50-51`); `composer.attempts[].raw` capped at 2000 chars each with a marker (`pipeline.js:315-331`, `index.js:1537-1541`).

---

## 1. Breakdown table — one typical record, and its share of the 172 KB

Measured on the 3-record S6 record set (31.9 KB) with the trace built from that run's real inputs.
**Copy factor:** every byte stored in a current-swipe record is written to disk **up to 5 times**
in this example — 1× authoritative (`swipe_info[i].extra.copilot`) + 1× mirror (`message.extra.copilot`)
+ 3× snapshots (ring holds 3 of 5 slots) — plus separately the 7-message base chat.
So *share of 172 KB = field bytes × 5 ÷ 172*.

| Field | Typical bytes (per record set of 3) | × copies | Share of 172 KB | Why it exists |
|---|---:|---:|---:|---|
| `trace.composerIn` | 9.9 KB (3.3 KB avg; 4000-char cap) | ×5 | **28.8 %** | §6 debug panel "input: full prompt" + I7 audit; persisted because DebugLog is RAM-only (SCHEMA.md §3, R2-6) |
| `composer.attempts[]` | 5.6 KB (incl. ~1.5 KB raws) | ×5 | **16.3 %** | §6 "failures shown, not hidden" — raw output, reject reason, tokens per attempt (`records.js:141`) |
| `trace.extractorIn` | 4.6 KB (1.5 KB avg; < 4000 so unclipped here) | ×5 | **13.4 %** | same as above, extractor side; note `pipeline.js:129` appends the message window **twice** (template already inlined `{{copilot.lastMessages}}`) |
| `trace.extractorOut` | 3.2 KB | ×5 | **9.3 %** | I7 persisted output — but it is a **duplicate** of `extraction.text` below |
| `extraction.text` | 3.2 KB (554–3475 measured) | ×5 | **9.3 %** | §5 core data — one moment per turn, rolling state |
| `trace.composerOut` | 1.5 KB | ×5 | **4.4 %** | I7 persisted output — **duplicate** of `composer.text` |
| `composer.text` | 1.5 KB (15–120 words) | ×5 | **4.4 %** | §5 core data — the injected `<copilot>` note |
| `injection` (incl. `noteHash`, `finalPromptRef`, ids) | 0.7 KB | ×5 | **2.0 %** | GOAL §10.8 host-evidence: hash searched in the real outgoing prompt (`adapter.js:325-334`) |
| `extraction` meta (id, model, tokens, flags) | 0.5 KB | ×5 | **1.5 %** | §5 provenance fields |
| `composer` meta (model, tokens, timestamps) | 0.5 KB | ×5 | **1.5 %** | §5 provenance fields |
| record keys / `version` / nesting | ~0.15 KB | ×5 | **0.4 %** | JSON key overhead |
| *sub — record data* | *31.9 KB* | | ***91.5 %*** | |
| Base chat (7 messages, ST metadata, no copilot) | 12 KB (fixture measured 3.7 KB; typical RP lines are longer) | ×1 | **7.0 %** | SillyTavern's own data |
| `chat_metadata.copilot` misc (goals, requests, spend, `lastCompression`, `pendingSupersede`) | ≤ 1 KB | ×1 | **0.4 %** | §5/§6 per-chat state |
| **Total** | | | **172 KB** | |

Records not present in the fixture but real growth paths:

* `history[]` — **0 bytes** in all measured runs, but every same-slot rewrite appends a full copy of
  the old extraction+composer+injection (`store.js:254-273`, attempt raws stripped per T-R2-12) and every
  user edit appends `{at, field, previous}` with the **full old text** (`edit.js:23-28`). One append-turn
  rewrite ≈ 1.5–2 KB **per history entry**, again ×5 on disk. Never pruned (I1).
* `extractions[]` (merged compression outputs with `sources[]`) ≈ 153 B/record average measured
  across 83 records; originals marked `compressedInto` are the same bytes kept in place (I2, `records.js:99-106`).

**Sanity note for the owner:** run `chat_metadata.copilot.snapshots.length` on the real chat.
If it is 0, the reconstruction below is wrong and the records themselves must be ~2.6× heavier
(the debug panel's size badge at `index.js:3096-3097` reports record bytes directly).

---

## 2. Why it compounds — the 7-message example

**Measured message layout** (identical in `S6`, `S14`, `S8` fixtures):

```
msg0  greeting   swipe_info[0]   no record            (4 swipe_info entries total)
msg1  user       —
msg2  narrator   swipe_info[0]   record + mirror      ← 1 swipe
msg3  user       —
msg4  narrator   swipe_info[0]   record + mirror      ← 1 swipe
msg5  user       —
msg6  narrator   swipe_info[0]   record + mirror      ← 1 swipe
```

3 of 7 messages carry records; 1 swipe each in the fixture (a reroll adds a swipe **and a second
full record with its own trace** — see `S3-2026-10-06…`: 5 swipes, 4 records).

**The multiplication:**

```
on-disk bytes ≈ base
              + R_total                      (authoritative records, incl. trace)
              + R_current                    (mirror: current-swipe records only, structuredClone)
              + S × R_total                  (snapshot ring: S ≤ 5 clones of ALL record roots)
              + meta                         (goals/requests/spend — never mirrored, never snapshotted)

R_total = 31.9 KB,  R_current = 31.9 KB (all 3 records are current swipes),  S = 3
       = 12 + 31.9 + 31.9 + 3 × 31.9 + ~0.6
       = 171.8 KB  ≈  the owner's 172 KB
```

Key structural facts driving this:

1. **Traces are 61 % of a record** (19.5 of 31.9 KB) even though they are already clipped at 4000 chars.
2. **The mirror duplicates every current-swipe record byte-for-byte** (`store.js:143`) — it is not
   optional headroom; ST's own sync pushes `message.extra` down onto `swipe_info` unconditionally
   (`script.js:6880`), so the mirror must remain a *superset* of the authoritative slot at all times.
3. **Each snapshot is a clone of the entire record set, traces included** (`store.js:466-475`), so
   the ring multiplies whatever a record weighs: `S = 0 → 5` takes the record factor from ×2 to ×7.
4. `chat_metadata.copilot` (goals, requests, spend, snapshots, `lastCompression`, `pendingSupersede`)
   is stored **exactly once** — no mirror, no snapshot clone of its own contents (snapshots clone only
   swipe roots). This asymmetry is the lever the recommendation exploits.
5. **One metadata exception, worth checking on the real chat:** after an import,
   `chat_metadata.copilot.preImportSnapshot = { snapshot, metaSnapshot, createdSlots }`
   (`index.js:939`, `transfer.js:82-83`) holds a *record-set snapshot* **plus** a `structuredClone` of
   the whole metadata bag — including the snapshots ring and any previous `preImportSnapshot`.
   It is deleted only when the user restores (`index.js:960`); repeated imports without a restore
   therefore nest one clone inside the next (unbounded), and while pending it can double the file.

Sensitivity: with `S = 0` the same formula needs records ≈ 80 KB to reach 172 KB — possible only with
heavy history/rerolls; the owner should confirm `snapshots.length`.

---

## 3. Options (10)

Savings are against the 172 KB baseline, applied **standalone** (each option measured alone).
"Records" below = 31.9 KB; copy factor 5 unless noted.

### O1 — Audit-gated trace (slim default: 400-char preview + SHA-256 + length per field)

* **Change:** `buildTrace()` (`index.js:1355-1363`) stores, per field, a 400-char redacted preview,
  the full length, and a SHA-256 of the full text; the full 4000-char trace is written only when
  `settings.storage.traceMode === 'record-full'` (new toggle next to `diffPopup`,
  `index.js:119, 2889-2907, 3005-3007`).
* **Saving:** trace 19.5 → ~6.2 KB per record set → 172 → **≈105 KB, −67 KB (−39 %)**.
* **Feasibility:** easy–medium. Sites: `index.js:1348-1363` (buildTrace), `1649` (setPending),
  `adapter.js:135, 324` (persist), panel `index.js:3110-3130`, settings UI.
* **Invariant touched:** **I7** ("what the panel shows is exactly what was sent") — persisted evidence
  shrinks from 4000 to 400 chars per field.
* **How the guarantee survives:** the DebugLog copy payload (the I7 artifact) is untouched and remains
  the exact, per-turn record while in RAM; the persisted preview+SHA-256 lets anyone *verify* a
  re-rendered prompt byte-for-byte (`hash(full) === hash`) instead of merely re-reading it; truncation
  stays marked, never silent; §10.8's injection proof (`injection.noteHash` + `noteChars` +
  `finalPromptRef` + `verifyInOutgoing`, `debug-log.js:270-309`) never lived in the trace.

### O2 — Relocate the trace to `chat_metadata.copilot.turns` (one copy instead of up to 7)

* **Change:** stop writing `trace` onto the swipe record (`adapter.js:324`, `index.js:1649`); write it
  once into `chat_metadata.copilot.turns[record.traceId]` via `withMeta()` (`index.js:577-592`).
  Record keeps a small `traceId` (or reuse `extraction.id`). Drop `extractorOut`/`composerOut` from the
  relocated trace (they are byte-duplicates of `extraction.text`/`composer.text`; store `outRef: "record"`).
  Read path: `rec.trace ?? meta.turns[rec.traceId]` at `index.js:3110`.
* **Saving:** records 31.9 → 12.4, mirror 12.4, snapshots 3 × 12.4 = 37.2, metadata +14.5 (full inputs,
  outputs deduped) → **≈89 KB, −83 KB (−48 %)**. Keeps the full (4000-capped, redacted) prompt text.
* **Feasibility:** medium. Sites: `index.js:1355/1649/3110`, `adapter.js:135/324`, a `migrate.js` step,
  `skip-records` test.
* **Invariants touched:** **I7** (location of the audit copy), **I6** (fork/export carriage),
  **I1** (migration must move, not drop, existing traces).
* **How the guarantee survives:** the bytes are unchanged and still live in the *same chat file*
  (metadata is line 0 of the same JSONL — it saves with every `saveChat`). Keying by a stable id
  (`extraction.id`) rather than message index keeps traces valid across fork/branch; a missing key
  degrades to "(trace not in this chat)" exactly as I6 prescribes. `migrateChat()` carries every
  existing `record.trace` forward (I1: "a step carries data forward; never drops it",
  `migrate.js:9-16`). §10.8 evidence (`injection.*`) stays on the record, untouched. Snapshots stop
  cloning traces because snapshots only clone swipe roots.

### O3 — Drop duplicated outputs from the trace

* **Change:** in `buildTrace()` omit `extractorOut`/`composerOut` when they equal the stored
  `extraction.text`/`composer.text` (they always do on success); keep them for turns where the stored
  text was later edited or superseded (diff-popup 'use old', `index.js:1585-1591`).
* **Saving:** 4.7 KB × 5 = **≈23.5 KB (−14 %)** standalone; near-zero incremental if O2 is applied
  (O2 includes it).
* **Feasibility:** easy. Site: `index.js:1355-1363`.
* **Invariant touched:** I7.
* **How the guarantee survives:** the outputs are *not* gone — they are the record's own
  `extraction.text`/`composer.text`; failed outputs stay in `composer.attempts[].raw`
  (`pipeline.js:320-324`). The trace records `outRef: "record"` so the panel reads them from the
  record: same panel, same bytes, one copy.

### O4 — Deduplicate `composer.attempts[].raw`

* **Change:** omit `raw` for successful attempts when `raw === composer.text` (an exact duplicate —
  measured: successful raws are the note, 445–520 chars); keep every failed attempt's raw at full
  2000-char cap. Site: `pipeline.js:315-331`.
* **Saving:** ~1.5 KB × 5 = **≈7.5 KB (−4 %)** standalone.
* **Feasibility:** easy.
* **Invariants touched:** I1 (nothing destroyed), §6 (failures shown).
* **How the guarantee survives:** the dropped value is byte-identical to `composer.text`, which is
  stored — it is a copy, not the original, so nothing is destroyed (I1); failures (the entire point of
  §6) keep their raw output untouched.

### O5 — Snapshot ring: entry 0 full, later entries as deltas (still 5 entries)

* **Change:** `pushSnapshot()` (`records.js:466-470`) stores snapshots 2..5 as a patch against their
  predecessor (structural diff over extraction/composer/injection texts + marks); `restoreChat()`
  (`store.js:491-539`) replays the chain. `snapshotChat()` keeps returning a full snapshot, so callers
  (`compressor.js:185`, `transfer.js:82`, `index.js:819`) and the tests that compare snapshots stay
  valid. Successive compression snapshots differ by roughly one merged entry — deltas ≈ 1–2 KB.
* **Saving:** ring 95.7 → ~35 KB (standalone, records still hold traces) = **≈60 KB (−35 %)**;
  combined with O2 the ring falls to ~15 KB.
* **Feasibility:** medium. Sites: `records.js` (pushSnapshot), `store.js` (restoreChat),
  UI listing (`index.js:2512-2560`).
* **Invariant touched:** **I3** ("pre-operation snapshots for exact rollback").
* **How the guarantee survives:** still the last 5 snapshots; restore *replays* to the exact byte
  state — the I3 tests (`schema-store` "I3 snapshot and exact restore",
  `compressor.test.mjs` torture 6) assert `JSON.stringify(chat) === snapshotBefore` after restore,
  which a replay satisfies by construction. A failed/partial delta must fall back to "restore
  unavailable for this entry" rather than a partial apply (never a silent partial restore).

### O6 — Mirror elimination with a read-path fallback

* **Change:** stop writing `message.extra.copilot` for messages where no ST push-down can clobber
  them; read path already prefers `swipe_info[i].extra.copilot` (`readSwipeRecordOrNull`,
  `store.js:158-181`) and falls back to the mirror (`audit()` proves the mirror-only state exists,
  `store.js:560-597`); rehydrate mirrors from `swipe_info` on chat load.
* **Saving:** **≈31.9 KB (−19 %)** standalone (all 3 records current); ~12 % if only the newest
  message's mirror is kept.
* **Feasibility:** **hard — not safe as a default.** Sites: `store.js:124-147, 278`; read/audit paths.
* **Invariants touched:** **I6** (chat integrity / placement), and the explicit SCHEMA.md §1 rule
  ("mirror must exist whenever ST can push down").
* **How the guarantee survives — and why it is still risky:** ST calls `syncMesToSwipe()` from message
  edit/save paths *inline* (`script.js:3721, 9075, 9128, 10280`, plus `slash-commands.js:4666`,
  `reasoning.js:1565`, `swipe-picker.js:25`) and it overwrites `swipe_info[swipe_id].extra` with
  `structuredClone(message.extra)` **before any extension event fires**. A message whose mirror was
  removed would therefore have its authoritative slot replaced by `{}` on the next edit — silent data
  loss, precisely the hazard the schema-store CONTROL test exists for
  (`schema-store.test.mjs:132-172`). Survival requires (a) load-time rehydration, (b) keeping the
  mirror on any message the user can still edit (i.e., all of them), or (c) an ST-side hook the
  extension does not have. **Recommendation: do not enable by default.** The honest alternative is to
  shrink the *record* (O1–O4), which shrinks the mirror automatically.

### O7 — Schema-key shortening (additive fields only)

* **Change:** rename additive keys in a v2 migration: `extraction→e` is forbidden (§5), but
  `trace→t`, `attempts→a`, `rejectReason→rr`, `tokensIn→ti`, `finalPromptRef→fpr`, `userRequestsActive→ura`
  etc. are all `// ADDED` fields we own. New step in `migrate.js` `STEPS` (`migrate.js:45-58`),
  bump `SCHEMA_VERSION`/`MAX_SUPPORTED_VERSION`.
* **Saving:** key/nesting overhead ≈ 1.5–2 KB per record set × 5 ≈ **≈20 KB (−12 %)**.
* **Feasibility:** hard — migration + every test that names these keys + the human-readable chat
  file (the owner reads these files; shortening works against auditability for no content gain).
* **Invariants touched:** I1 (migration must carry values forward), GOAL §5's "schema is fixed —
  ask before changing" (`records.js:4-6`, SCHEMA.md §4).
* **How the guarantee survives:** a migration *copies* then retains the old key for one release
  (SCHEMA.md §4 rules), older builds read-through both; unknown keys already ride through untouched
  (`store.js:164-169`, F8). Cost/benefit is poor compared with O1/O2.

### O8 — Snapshot ring depth 5 → 2 (policy change)

* **Change:** `MAX_SNAPSHOTS = 5` → 2 (`records.js:451`).
* **Saving:** with 3 entries present: **≈31.9 KB (−19 %)**; with all 5 filled: ≈96 KB (−56 %).
* **Feasibility:** easy (one constant), **but** it edits a written invariant.
* **Invariant touched:** **I3 literally says "Keep the last 5 snapshots"** (GOAL.md §52).
* **How the guarantee survives:** the mechanism (snapshot-before-bulk-op + exact restore) is unchanged;
  only rollback *depth* changes, and that must be an explicit owner decision, surfaced in the UI
  ("rollback depth: 2") — an honest shrink, unlike a silent cap. I8-equivalent framing: the cap is on
  *rollback history*, not on data the user produced.

### O9 — Sidecar audit file under the ST data root (traces leave the chat file entirely)

* **Change:** write full, **unclipped** (no 4000-cap) rendered inputs per turn to
  `<ST data root>/<chat>.copilot-audit.jsonl`; the record keeps `{traceId, sha256, len}` only.
* **Saving:** chat file **172 → ≈74 KB, −97.5 KB (−57 %)** — the single largest cut, because traces
  leave the file *and* stop being mirrored/snapshotted. Fidelity actually improves (inputs no longer
  clipped at 4000 — today's `composerIn` is truncated from turn 2 on).
* **Feasibility:** **hard.** The extension is browser-side (`public/scripts/...`) with no file I/O;
  it needs a server endpoint (a new route in `SillyTavern/src/endpoints/`, i.e., patching ST itself),
  plus a read route for the debug panel.
* **Invariants touched:** **I6** ("copilot data lives where the swipe lives" — a sidecar does not
  fork/export with the chat), **I7** locality (the panel can no longer show evidence straight from the
  chat file), and the I8 spirit ("the store is bounded by the chat file").
* **How the guarantee survives:** record keeps `sha256 + len` so a missing sidecar is *detectable*
  ("audit file not found — hash recorded here") instead of silently absent; bundle export
  (`src/schema/transfer.js`) should inline the sidecar to keep I6. Until ST ships a generic
  extension file endpoint this is not implementable cleanly — list it as the long-term target,
  not the next change.

### O10 — Pending-import snapshot hygiene (cheap fix, only if the chat imported)

* **Change:** before writing `preImportSnapshot` (`index.js:939`), delete the previous pending one
  (it is overwritten unconditionally at that line anyway, so nothing is lost), and never let
  `metaSnapshot = structuredClone(meta)` (`transfer.js:83`) capture a previous `preImportSnapshot`.
  Bonus: offer a "clear pending import snapshot" button once the import is committed.
* **Saving:** 0 KB on the fixture; **up to one whole metadata clone (≈100–130 KB) per pending/nested
  import** on chats that imported without restoring — potentially the largest single block on such
  chats.
* **Feasibility:** easy. Sites: `index.js:934-960`, `transfer.js:83`.
* **Invariants touched:** I3 (pre-import rollback) and I1.
* **How the guarantee survives:** the *current* import's snapshot is still taken and still restored
  byte-exactly; only the stale, about-to-be-overwritten copy and its nesting are removed — data that
  line 939 destroys today regardless. The restore test (`transfer.test.mjs:50-83`) passes unchanged.

**Stacking note:** options compose; O2 already includes O3's dedupe, and O10 is independent hygiene.
O1 and O2 are alternative homes for the trace (preview-in-record vs full-in-metadata); do not stack
them unless you want previews *in* metadata (that combination saves ~10 KB more).

---

## 4. Recommendation

**Default configuration ("slim storage" profile):**

| # | Setting / change | Effect |
|---|---|---|
| 1 | **O2** — trace relocated to `chat_metadata.copilot.turns`, keyed by `traceId`; full redacted 4000-capped text preserved | audit text kept exactly as today, stored once |
| 2 | **O3** (folded into O2) — trace drops `extractorOut`/`composerOut`, keeps `outRef: "record"` | removes two byte-duplicates |
| 3 | **O4** — `attempts[].raw` omitted only when `raw === composer.text` (failures untouched) | removes one byte-duplicate |
| 4 | **O5** — snapshot ring entry 0 full + deltas, still 5 entries, replay-on-restore | rollback depth and exactness unchanged |
| 5 | Opt-in `storage.traceMode = 'record-full'` — today's layout restored verbatim ("audit mode") | users who want the trace inside the record keep it |

**Projected size of the same 7-message chat:**

| Configuration | Projected | vs 172 KB |
|---|---:|---:|
| Today (baseline reconstruction) | **172 KB** | — |
| **Recommended default (O2+O3+O4+O5)** | **≈64 KB** | **−108 KB, −63 %** |
| Conservative (O2+O3+O4, no snapshot delta) | ≈82 KB | −90 KB, −52 % |
| Audit mode on (`traceMode = 'record-full'`, O4+O5 still active) | ≈108 KB | −64 KB, −37 % |

Reconciliation of the 64 KB: base 12 + records 10.9 + mirror 10.9 + snapshots ≈15 (10.9 + two ~2 KB
deltas) + metadata 15.1 (14.5 relocated trace + ~0.6 goals/requests/spend) ≈ 64 KB.

Why this default rather than the bigger cut: it is the only combination that keeps **every byte of
audit evidence** (I7) while removing the *structural* multiplier — records paid ×5, metadata paid ×1.
O9 saves more but needs a server-side endpoint and breaks chat portability; O1 saves well but trades
persisted evidence for hashes; O6 is unsafe against ST's inline `syncMesToSwipe` calls.

---

## 5. Risks — which tests pin the fields proposed for change

Grep of `C:\SL 6\tests\` for each touched field:

| Field / mechanism | Tests that pin it | Needed update if the option ships |
|---|---|---|
| `trace`, `trace.composerIn`, `trace.extractorIn` | `tests/t1/skip-records.test.mjs:84, 98-99` ("the audit trace is persisted on the record", "with its contents intact") — **the only test pinning the trace's location** | O2: re-point to `chat_metadata.copilot.turns[traceId]`; add a fallback-read test (`rec.trace ?? meta.turns[...]`) and a migrate-old-location test |
| Preview/hash mode (O1) | none today | new tests: 400-char preview + SHA-256 round-trip, marker honesty, `record-full` mode byte-equality with today |
| `composer.attempts` (incl. `raw`) | `tests/t2/pipeline.test.mjs:51, 191-216, 293`; `tests/t2/provider.test.mjs:208-337`; `tests/t1/schema-records.test.mjs:147-148`; `tests/t1/debug-log.test.mjs:184-191`; `tests/t3-e2e.mjs:527`; `tests/t4-live-smoke.mjs:132-133` | O4: assertions on `attempts.length`, `ok`, `rejectReason` all still pass (only `raw` of *successful* attempts changes); add "successful raw absent, failed raw present" |
| `snapshots`, `MAX_SNAPSHOTS`, restore exactness | `tests/t1/schema-records.test.mjs:206-219` ("I3 snapshots keep the last five"); `tests/t1/schema-store.test.mjs:332-377` (exact restore, byte-identical re-snapshot); `tests/t2/compressor.test.mjs:106-116, 141-164, 185-190, 225-241` (pre/post `JSON.stringify` equality, committed == fresh snapshot); `tests/t1/transfer.test.mjs:50-83` (pre-import snapshot restores exactly); `tests/t3-e2e.mjs:1311` (import restore) | O5: keep `snapshotChat()` returning FULL snapshots (then compressor/transfer assertions pass unchanged); only `pushSnapshot`/`restoreChat` internals change; add a delta-replay byte-equality test and a corrupted-delta "refuse, don't half-restore" test. O8 would rewrite `schema-records:206-219` and requires owner sign-off on GOAL I3 |
| Mirror (`message.extra.copilot`, `ROOT_KEY`, saveReply rebuild) | `tests/t1/schema-store.test.mjs:89-198` (mirror follows `swipe_id`, write-during-generation mirror, THE HAZARD control, round-trip no-op, no cached refs), `:395-408` (`mirror-without-source` audit), `:411-424`; `tests/t1b/st-constants.test.mjs:150-152, 206-210` (mirror protocol constants/comment); `tests/t5-continuity.mjs:218` | O6: the CONTROL test at `schema-store:132-172` is *designed to prove data loss* without the mirror — it would have to be re-scoped, and SCHEMA.md §1 rewritten. This is the strongest signal that O6 is not a default |
| `history[]` (I1) | `tests/t1/schema-edit.test.mjs` (whole file: `:22-59`), `tests/t1/schema-store.test.mjs:481-522` (fold + second-write history + empty-patch adds none), `tests/t3-e2e.mjs:814-819` (edited note has ≥1 history), `tests/r3-controls.mjs:135-149` | Not proposed for change — listed because it is the field most likely to be "trimmed" in a future pass; I1 forbids pruning |
| `sources` / `compressedInto` / `extractions[]` (I2) | `tests/t1/schema-records.test.mjs:24-54, 78`; `tests/t1/schema-store.test.mjs:245-256, 316-330`; `tests/t2/compressor.test.mjs:73-116, 219, 274`; `tests/t3-e2e.mjs:1265-1282`; `tests/t5-continuity.mjs:283-356` | Not proposed for change |
| `injection.noteHash` / `noteChars` / `finalPromptRef` (§10.8) | `tests/t1/schema-records.test.mjs:110-135`; `tests/t2/pipeline.test.mjs:52, 335-338`; `tests/t3-e2e.mjs:541-1084` (hash survives reload/swipe/regenerate); `tests/t6-scenarios.mjs:193, 279-281` | **Must keep passing untouched** — these are the host-evidence chain; none of O1–O5 modifies it |
| Key renaming (O7) | every test naming `rejectReason`, `tokensIn`, `finalPromptRef`, `userRequestsActive`, … (see `schema-records.test.mjs:110`, `pipeline.test.mjs`, `provider.test.mjs`, `t3-e2e.mjs:541+`) | rename sweep + migrate step + SCHEMA.md §3 table rewrite — large blast radius for ~12 % |

Docs that must be updated alongside any change: `docs/SCHEMA.md` §1 (mirror rules), §3 (the
`SwipeRecord.trace` row — currently documents the 4000-char in-record trace), §4 (migration steps);
`index.js:3096-3097`'s "sizes are shown, never silently capped" badge keeps reporting the new numbers
(that UI guarantee itself needs no change).

**Open question for the owner:** confirm `chat_metadata.copilot.snapshots.length` and whether the
records carry `trace` in the real 172 KB chat (none of the `tests/runs` artifacts do). The
reconstruction in §2 assumes 3 snapshots and traces present; if either differs, the shares in §1 shift
but the options' relative order does not (traces, mirror and snapshots are all functions of the same
record bytes).
