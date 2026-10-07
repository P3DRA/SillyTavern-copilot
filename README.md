# Copilot — a roleplay copilot for SillyTavern

Copilot runs three small LLM calls alongside your narrator and stores everything
it learns **in the chat file**. It never writes a word of your story — it records
what happened, and hands the narrator a short guidance note.

- **extractor** — records ONE moment per turn: what the newest messages show.
  It never restates earlier moments; those are merged separately.
- **composer** — writes a `<copilot>…</copilot>` guidance note that is injected
  into the narrator model's prompt for that turn. Guidance only, never narration.
- **compressor** — folds old extractions together (union merge: every fact must
  survive) so the fact list stays short.

All three call an OpenRouter-compatible API **directly from your browser** with
your own key, entered in the panel. No server-side configuration is needed
(optionally `allowKeysExposure` — see Install).

## What a turn looks like

```
your message
   └─ GENERATION_STARTED (a real narrator turn only — quiet/impersonate skip)
        └─ prompt-ready hook (SillyTavern awaits it)
             ├─ extractor  → one moment recorded from the new messages
             ├─ composer   → a <copilot> guidance note (15–120 words)
             └─ the note is spliced into the outgoing prompt
                  (position / depth / role are yours to set)
   └─ narrator generates the reply
   └─ the record (extraction + note + injection info) binds to that message
```

A fetch watcher inspects the request that actually leaves SillyTavern and the
debug log prints `script-verified injected (found in the outgoing request): true`
— a claim about the real bytes, not about our own return value.

## Install

1. Copy this folder into `SillyTavern/public/scripts/extensions/third-party/copilot`.
2. Reload the SillyTavern page (a hard refresh if the browser cached the old build).
3. Open **Extensions → Copilot** — the panel is an inline drawer in the
   Extensions settings and ships open, with the debug log visible.
4. Get a key at <https://openrouter.ai/keys> and paste it into the panel's
   **API key** field, then press **Save settings**.

Requirements: SillyTavern **1.18+** and an OpenRouter-style API key. Nothing on
the server needs changing: the key lives in SillyTavern's extension settings
(stored in plaintext — the panel says so). A server-side OpenRouter secret is
used *only* if the panel field is blank **and** your `config.yaml` has
`allowKeysExposure: true`; otherwise extensions cannot read that secret and the
turn is skipped with a `no_api_key` log line.

## Quick start

1. Press **Enable copilot** (the pilot lamp in the drawer header turns green —
   green means *enabled and a key resolves*).
2. Paste your key into **API key** → **Save settings**.
3. Send a message and let the narrator reply.
4. Open **records** in the panel: one fold per message, one fold per swipe,
   each with the extractor's **input/output** and the composer's
   **input/output** — the note the narrator was actually given, editable.
5. Check the **debug log** at the bottom: `script-verified injected … true`
   confirms the note reached the real request.

## The three agents

| agent | receives | produces | when |
|---|---|---|---|
| **extractor** | the previous state + only the messages not yet folded into it (recent-message and character budgets apply) | one moment: a structured record (`# Major events` / `# Character notes` / `# Locations`) | every real narrator turn |
| **composer** | the recent transcript, every visible extraction, lorebook, character card, narrator's system prompt, goals/requests, previous note, language, word bounds | a `<copilot>…</copilot>` note (soft min / hard max words) | every real narrator turn |
| **compressor** | selected extractions, rendered into its own template | one merged extraction in `<compressed>…</compressed>` — union merge, output rejected unless it parses *and* is shorter than its inputs | on demand, or auto-compress when enabled |

Notes on behaviour:

- Both chains are **fallback chains**: models are tried in order, each with
  retries, and every attempt (including raw rejected output) is logged.
- Output is judged before use (tag present, word bounds, refusal). A failed
  composer ends the turn with **no note** — the previous note is reused only by
  your explicit choice, never silently.
- The extraction is stored **even when the composer fails**.
- On a swipe/reroll you choose *ask / always new / always reuse*; **reuse makes
  zero model calls** (extraction and note are copied). A diff popup can show
  old vs new extraction and note with *use new / use old / reroll / cancel*.
- Quiet generations, impersonation and dry runs never compose or inject.

## The panel, section by section

- **Header** — pilot lamp (click to toggle), build id, **Enable/Disable copilot**.
  Red = disabled or no usable key; the tooltip names which gate is closed.
- **goals & requests** — add a goal or a short-lived request with an optional
  turn budget. Counters are advanced by script once per narrator turn; the
  composer is *told* the numbers, the model never counts.
- **presets** — snapshot the current extractor/composer configuration under a
  name; apply or delete bundles.
- **spend** — provider-reported tokens per role (extractor / composer /
  narrator), calls, and cost from your own per-token price table (zero by
  default; the counter reports tokens and never invents a price). Streamed
  responses report no usage and are counted as zero, with a log line saying so.
- **lorebook** — permanently-triggered entry keys (comma or newline separated).
  Entries ST triggered this turn plus entries matching these keys are merged by
  world+uid, so an entry never appears twice.
- **compressor** — the visible extraction list (active swipe only), tick a
  **contiguous** range and **Compress selected**, **Undo last compression**,
  **View/Edit** a full extraction in a popup, **Pin** (never merged) and
  **Protect** (auto-merge skips it). Auto-compress is **default off**: set a
  threshold (“merge above N”, “merge the oldest M”), save, or run it now.
  Pre-operation snapshots (last 5) can be restored with a confirmation.
- **import / export** — export this chat's copilot state as JSON, import a
  bundle (idempotent, snapshot kept first), restore the pre-import snapshot.
- **settings** — API key (+ Clear saved key), `baseUrl`, extractor/composer/
  compressor model chains, temperatures, token caps, reasoning effort per role,
  recent-message and character budgets, note word bounds, **turn budget**
  (`maxWaitMs`, one deadline for the whole extractor+composer step), reroll
  behavior, diff popup, injection position/depth/role, prompt templates.
  Nothing is written until **Save settings**.
- **records** — per message → per swipe folds with badges (current swipe, last
  injected note, edited, stale) and editable outputs; **Copy records** dumps the
  whole chat's records as plain text; sizes are shown, never silently capped.
- **debug log** — per turn: timings, prompts in, outputs out, the fallback
  attempts with reasons, injection status, failures; plus an events stream.
  **Copy log** gives the unclipped plain text (the display truncates long
  lines). The log is per-chat and resets on a chat change.

## Prompt templates

Three editable templates (extractor / composer / compressor) with namespaced
placeholders. Only `{{copilot.*}}` is ever substituted — SillyTavern's own
macros pass through byte-for-byte. Any block may be reordered or omitted;
unknown `{{copilot.*}}` placeholders are dropped rather than left literal.

| placeholder | what it renders |
|---|---|
| `{{copilot.extractions}}` | every visible extraction, each labelled with when it was taken |
| `{{copilot.previousState}}` | the newest extraction (the state so far) |
| `{{copilot.lastMessages}}` | the recent transcript window |
| `{{copilot.lorebook}}` | triggered + permanently-triggered lorebook entries |
| `{{copilot.characterCard}}` | character name + description (capped) |
| `{{copilot.narratorPrompt}}` | the narrator's standing instructions (prompt manager `main`) |
| `{{copilot.userRequest}}` | active reader requests, joined |
| `{{copilot.goals}}` | active goals with script-counted turns |
| `{{copilot.previousNote}}` | the last note, so the composer doesn't repeat it |
| `{{copilot.language}}` | coarse language guess of the recent chat |
| `{{copilot.minWords}}` / `{{copilot.maxWords}}` | the note's word bounds |

The extractor and composer templates can use the whole set (user freedom); the
compressor template is rendered with `{{copilot.extractions}}` — other blocks
render empty there. Premade bundles ship in the panel (**default**, **terse**,
**detailed**, **threads**, **atmosphere**); loading one only fills the boxes,
and you can save your own and delete yours (shipped bundles stay).
**Restore default templates** resets the boxes to the shipped text.

## Storage & invariants

- **Per-message, per-swipe records live in the chat file**
  (`swipe_info[i].extra.copilot`, mirrored to `message.extra` for the current
  swipe) — export the chat and the records travel with it.
- **`chat_metadata.copilot`** holds goals, requests, spend, compression
  snapshots and pre-import snapshots — per-chat, so nothing leaks between chats.
- **Settings** (key, chains, templates, presets, pricing, lorebook keys) live in
  SillyTavern's extension settings — user configuration, not chat data.
- **Nothing automatic produced is thrown away:** edits keep the superseded value
  in `history`; a regenerate's record is stashed and folded into the new
  message's history instead of dying with the deleted message; compression
  creates a new record and marks the originals `compressedInto` (undo restores
  them exactly); a failed composer still stores its extraction.
- Record traces are persisted with explicit truncation markers, never silently
  sliced. Known trade-off: full audit traces make chat files heavy.

## Troubleshooting

- **HTTP 401/403** — the provider refused the key. Paste it into the panel's
  API key field (a stray space or quote breaks it; typed keys are trimmed) and
  press Save settings. If you rely on ST's OpenRouter secret instead, the server
  must have `allowKeysExposure: true` in `config.yaml` or extensions cannot read
  it at all. 401/402 is terminal for the whole run — the chain stops rather than
  retrying every model.
- **HTTP 429 (rate limited)** — your narrator shares the model's rate budget
  with the extractor/composer calls, which fire right before it. Put a
  *different* model in the extractor and composer chains (then the narrator gets
  the whole budget), or wait a minute and retry. The note and extraction are
  stored either way — only that turn's reply was lost.
- **“copilot is DISABLED”** — the boot log warns it and the pilot lamp is red.
  Click the lamp or press **Enable copilot**.
- **The note isn't appearing** — open the debug log and find
  `script-verified injected (found in the outgoing request)` for that turn.
  `true` = it shipped; `false`/`not verified` = check the `injection:` line and
  the `FAILURES` block above it (disabled, no key, no note, deadline, popup
  cancel), and remember `position: none` is log-only by design.
- **Anything else** — **Copy log** and read the `── turn N ──` block: prompts in,
  outputs out, every provider attempt, timings.

## FAQ

- **Does it write narration?** No. The composer produces guidance only, and its
  shipped template forbids narration, dialogue and scene text. The note is the
  only thing injected, and it is a `<copilot>` block, not story text.
- **Does it cost money?** Yes. A normal turn makes **2 small calls** (extractor,
  composer) before your narrator's own call; a swipe set to *compose new* adds
  the same again, and compression runs only when you ask or when auto-compress
  is enabled. Everything is metered from provider-reported usage in the spend
  section.
- **How do I make it cheaper?** Use cheaper/free models in the extractor chain
  (it does the bulk of the recording), shorten the recent-message budgets, keep
  rerolls on *reuse* (zero calls), and leave auto-compress off until the list is
  actually long.

## License / credits

License: TBD — see LICENSE. Build `copilot-phase8-r14` (shown in the panel);
tested against SillyTavern 1.18.0.
