# Spectre MCP Broker — Tool Audit

> Wiring + function audit of every tool the agent can call (`core/spectre-mcp-broker/tools-catalog.json`,
> 37 tools). "Working" = a real end-to-end path from the tool name through the broker dispatch
> to a backend route/lib that exists and does the work. Audited 2026-07-07. Verified against the
> live Docker stack, not just static reads.

## Headline

**28 of 37 tools are wired and working. 9 are broken.**

**Broken (9):** the entire `tempus.*` family (8) + `questionnaire.ask` (1).

- `tempus.timer.status`, `tempus.timer.start`, `tempus.timer.stop`
- `tempus.entries.today`, `tempus.entries.search`, `tempus.projects.list`
- `tempus.reports.daily`, `tempus.reports.weekly`
- `questionnaire.ask`

**Working but with a real defect (2):** `analytics.usage` (silent wrong window), `memory.delete` (missing autonomy gate).

> **On the tempus verdict — resolved by live probe.** All 8 tempus tools share one helper,
> `tempusFetch`, which hardcoded `http://127.0.0.1:3000/api/tempus` (`index.mjs:1064`) and sent
> no auth token. The broker runs *inside the core container* (`SPECTRE_APP_URL=http://127.0.0.1:8787`),
> where nothing listens on `:3000` and `/api/*` is CORE_TOKEN-gated. Probing from `spectre-core-1`:
> `:3000/api/tempus/timer → ECONNREFUSED`, `:8787/api/tempus/timer → 401`. So **timers are broken
> too**, not just the data/report tools — an earlier assumption that `:3000` was a reachable shell
> proxy was wrong (the shell's `:3000` is a *different* container).

## Full tool table

_Broken/defective first; backends cited as `file:symbol`._

| Tool | Intended use | Backend | Status |
|---|---|---|---|
| `tempus.timer.status` | Show running timer | `routes/tempus.ts:541 get('/timer')` | **broken** — tempusFetch transport |
| `tempus.timer.start` | Start a timer | `routes/tempus.ts:555 post('/timer/start')` | **broken** — tempusFetch transport |
| `tempus.timer.stop` | Stop timer, persist entry | `routes/tempus.ts:589 post('/timer/stop')` | **broken** — tempusFetch transport |
| `tempus.entries.today` | Today's entries | `routes/tempus.ts:343 get('/time-entries')` | **broken** — tempusFetch transport |
| `tempus.entries.search` | Search entries | `routes/tempus.ts:343 get('/time-entries')` | **broken** — tempusFetch transport |
| `tempus.projects.list` | List projects + totals | `routes/tempus.ts:195 get('/projects')` | **broken** — tempusFetch transport |
| `tempus.reports.daily` | One-day summary | `routes/tempus.ts:416 get('/time-entries/summary')` | **broken** — transport **+** `date` arg ignored (`index.mjs:1372`) |
| `tempus.reports.weekly` | One-week summary | `routes/tempus.ts:416 get('/time-entries/summary')` | **broken** — transport **+** `week` arg ignored (`index.mjs:1391`) |
| `questionnaire.ask` | Ask a form, block for typed answers | `permission/broker.ts:enqueue` (no backend) | **broken** — no answer UI; always returns `{}` |
| `analytics.usage` | Token usage/cost over window | `routes/usage.ts get('/')` | works — **defect**: broker `?windowHours=` vs route `?hours=` → non-24h silently returns 24h |
| `memory.delete` | Delete memory by id | `routes/memory.ts:129 delete('/:id')` | works — **defect**: no `autonomyGate` (siblings have it) |
| `bash` | Shell command after approval | `index.mjs:runBash` (local spawn) | working (destructive-gated) |
| `write` | Overwrite file after approval | `index.mjs:281` (fs writeFile) | working (destructive-gated) |
| `edit` | Replace text after approval | `index.mjs:319` (fs read/write) | working (destructive-gated) |
| `schedule.delete` | Delete a schedule | `routes/schedules.ts:228 delete('/:id')` | working (destructive-gated) |
| `notify` | Web-push notification | `routes/push.ts:52` → `lib/notify.ts:23` | working (config-gated; see edges) |
| `screenshot` | Playwright screenshot | `shotter.mjs:27` + `routes/generated.ts:111` | working (config-gated; see edges) |
| `calendar.today` | Today's MS 365 events | `routes/calendar.ts get('/events')` → `ms-graph/client.ts` | working (config-gated) |
| `calendar.upcoming` | Next N days MS 365 events | `routes/calendar.ts get('/events')` | working (config-gated) |
| `gemini.execute` | Task → local `gemini` CLI | `gemini-execute.mjs:321 runGemini` | working (costly/flag-gated; see edges) |
| `openai.image` | Image via Codex CLI | `openai-tools.mjs:206 spawnCodex` | working (costly/flag-gated; see edges) |
| `openai.chat` | GPT via Codex CLI | `openai-tools.mjs:313 spawnCodex` | working (costly/flag-gated; see edges) |
| `dispatch_to_model` | Delegate subtask to a model | `routes/spectre-mode.ts:8 post('/dispatch')` → `providers.ts:130` | working (flag-gated) |
| `memory.add` | Save durable fact | `routes/memory.ts:70 post('/')` | working |
| `memory.search` | Semantic recall | `routes/memory.ts:16 get('/')` | working |
| `note.add` | Save note | `routes/notes.ts:48 post('/')` | working |
| `note.list` | List notes/todos | `routes/notes.ts:19 get('/')` | working |
| `note.delete` | Hard-delete note/todo | `routes/notes.ts:119 delete('/:id')` | working (destructive) |
| `todo.add` | Save todo | `routes/notes.ts:48 post('/')` | working |
| `todo.complete` | Mark todo done | `routes/notes.ts:85 patch('/:id')` | working |
| `media.search` | Recall over generated images | `routes/generated.ts:178 get('/library')` | working |
| `schedule.create` | Create durable job | `routes/schedules.ts:24 post('/')` | working (approval) |
| `schedule.list` | List jobs | `routes/schedules.ts:13 get('/')` | working |
| `schedule.get` | Job + run history | `routes/schedules.ts:166 get('/:id')` | working |
| `schedule.update` | Patch a job | `routes/schedules.ts:180 patch('/:id')` | working (approval) |
| `schedule.run_now` | Make job due now | `routes/schedules.ts:236 post('/:id/run-now')` | working (approval) |
| `skill.read` | Load a SKILL.md body | `routes/skills.ts:22` → `lib/ext/dirs.ts:loadSkillDocs` | working |

## Fixes

### Applied 2026-07-07
- **All 8 `tempus.*` tools (transport)** — `index.mjs:1064` now uses `${APP_URL}/api/tempus` and
  `tempusFetch` sends `authHeaders(opts)` (mirrors `memoryFetch`). Repairs ECONNREFUSED + 401 for the
  whole family. **Requires a core-image rebuild + redeploy to take effect** (the broker ships inside
  the core image).

### Still open
- **`tempus.reports.daily` / `weekly` logic** — the `date`/`week` args only feed the display label;
  the query is hardcoded `period=today`/`week` (`index.mjs:1372,1391`), so historical dates return the
  *current* period's data. Pass real `from`/`to` bounds (+ `tz`) into the summary query, or extend
  `routes/tempus.ts:416` to accept an explicit date. (Transport fix makes them return *this* period
  correctly; historical still wrong until this lands.)
- **`questionnaire.ask`** — no answer-collection UI exists; it reuses the approve/deny gate and always
  returns `{}` (`chat/page.tsx:657`; `index.mjs:922`). Add a `tool === 'questionnaire'` branch that
  renders `input.questions` as a form and POSTs `{ decision:'allow', answer }` (`chat/page.tsx:406-413`);
  the broker plumbing (`broker.ts:473`) already accepts `answer`.
- **`analytics.usage`** — rename broker param `windowHours`→`hours` (`index.mjs:849`) to match `usage.ts:23`.
- **`memory.delete`** — add `autonomyGate('mcp__spectre__memory_delete')` (`index.mjs:581`).

## Sharp edges (working tools with caveats)

- **Secret leakage to child CLIs (highest-risk).** `gemini.execute` and `openai.image/chat` spawn with
  `{ ...process.env }` (`gemini-execute.mjs:346`, `openai-tools.mjs:84`), handing the child `CORE_TOKEN`
  + `SPECTRE_SERVICE_TOKEN` — unlike `bash`, which scrubs via an allowlist (`index.mjs:224-238`). A
  prompt-injected sub-agent could exfiltrate them. Scrub those from the child env for all three adapters.
- **Auto-approve modes.** `SPECTRE_WORKSHOP=1` auto-approves gated tools without a human round-trip
  (`index.mjs:80`); `bash` `flag` verdicts still force interactive, `block` verdicts refuse.
- **`tempus.timer.start` hidden side effect** — auto-stops any already-running timer first
  (`tempus.ts:568-571`).
- **Config-dependent (wiring fine, runtime needs env):** `calendar.*` need `ms_graph_tokens` + MS Graph
  client env (else 503); `notify` is a silent no-op without VAPID keys + ≥1 `push_subscriptions` row and
  returns `{ok:true}` regardless ("sent" ≠ delivered); `screenshot` needs the shotter sidecar
  (`--profile screenshot`) and a shared generated-dir (broker's `SPECTRE_GENERATED_DIR` vs core's
  `GENERATED_DIR` must match or the returned URL 404s); the CLI adapters are flag-gated
  (`SPECTRE_ALLOW_GEMINI_CLI` / `SPECTRE_ALLOW_CODEX_CLI` / `SPECTRE_ENABLE_DISPATCH_TOOL`).
- **`schedule.create` field coverage** — the broker's `scheduleSchema` (`index.mjs:934-946`) omits
  `report`, `notify_on_done`, `list_kind`, `list_items`, `enabled` that the route accepts, so those
  features are unreachable via MCP (zod strips them). Not broken; feature-incomplete.
