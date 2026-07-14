<div align="center">

<img src="docs/media/banner.png" alt="Spectre Agent — it's your assistant. Haunt your own machine." width="760">

<img src="docs/media/home.png" alt="Spectre Agent home screen" width="760">

**A self-hosted AI agent you build into exactly what you need.**

**Spectre Agent** is a self-hosted AI agent with a 3D interface. Every capability is a *module you can write yourself*. I built it to fight my own ADHD: it remembers what matters, runs recurring tasks on its own, and helps me start things instead of stalling on them. I made it extensible so it can become whatever *you* need. Your hardware, your models, your keys.

[![CI](https://github.com/EliasT5/spectre-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/EliasT5/spectre-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-5965e0.svg)](LICENSE)
[![Self-hosted](https://img.shields.io/badge/self--hosted-docker%20compose-1a1a2e.svg)](#quick-install)
[![Bring your own model](https://img.shields.io/badge/brain-bring%20your%20own%20model-7a5cff.svg)](#what-it-can-do)
[![Status: early development](https://img.shields.io/badge/status-early%20development-f59e0b.svg)](#)

**[Quick install](#quick-install)** · **[Build a module](docs/MODULES.md)** · **[Roadmap](ROADMAP.md)**

</div>

---

> ## ⚠️ Read the code before you run it
>
> Every push and PR now runs through CI: typechecks across the shell and the core, broker unit tests, a production build, a from-source compile smoke, and a secret scan. That is unit and build-gate coverage, not full end-to-end coverage. This is still early-stage software that runs with shell access. Read the files and verify it yourself before you run anything on your machine. Don't take my word that it's safe.

---

**What makes it different**

- 🧩 **You build it out.** Every capability is a module. Add your own two ways: a JSON description (no code) or your own code. It grows the way *you* want, instead of waiting on a feature-request queue.
- 🧠 **Built for executive dysfunction.** It came out of my own ADHD: it remembers across conversations, runs recurring tasks on its own, and helps you *start* and stay focused instead of adding one more thing to manage.
- 🏠 **A 3D interface.** Your modules sit as clickable orbs you can open and rearrange. Or skip the UI and run it headless over Telegram, WhatsApp, Discord, or HTTP.
- 🔑 **Entirely yours.** Self-hosted on your hardware, your models, your keys. Bring an API key, or run a local model with no cloud account at all.

---

## The first ten minutes

One install command. You open `http://127.0.0.1:3100` and hit a dark lock screen: *Secure Access. Enter your PIN.* Nothing reaches the agent until you're past it.

Then the home screen loads: a 3D scene with an animated central blob, ringed by one orb per module: Chat, Memory, Monitor, Settings, and whatever else your install includes. A clock sits overhead, with a greeting that changes by time of day. Drag to rotate the view, scroll to zoom, click an orb to open that tab. There's no setup wizard or tour.

Start in Chat. Type a message, leave the model on Auto or pick one, and the reply streams in. When the agent calls a tool (your shell, your files, a screenshot), the call shows inline as a chip you can expand. Anything that touches something sensitive waits for your Approve or Deny first. Turns run on the server, so you can close the tab mid-answer and it finishes without you. Follow-up messages queue behind the one in progress.

---

> **🚧 Early development.** Spectre Agent is young and moving fast. Expect rough edges, breaking changes, and unfinished features. Kick the tires and file issues, but don't trust it with anything critical yet.

_On the name: **Spectre Agent** runs on your own machine and answers only to you. It has no relation to the [Spectre CPU vulnerability](https://en.wikipedia.org/wiki/Spectre_%28security_vulnerability%29); the name is about the ghost, not the exploit._

## Quick Install

**Install with your AI CLI (recommended)**

You're installing an AI agent, so let one do the installing: your CLI adapts to your exact OS, installs whatever is missing, runs the same wizard, and hands you the terminal when the wizard needs a human. Tell Claude Code, Codex, Gemini CLI, or any agentic CLI:

```text
Install Spectre Agent on this machine from https://github.com/EliasT5/spectre-agent — follow the playbook in its agent-install/ folder exactly.
```

The step-by-step playbook lives at [`agent-install/`](agent-install/): every guardrail, from prerequisite checks to a verified daemon setup.

**Or, the one-line script**

**Linux / macOS**

```bash
curl -fsSL https://elias-teubner.dev/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://elias-teubner.dev/install.ps1 | iex
```

Both paths bootstrap the same Node wizard, `installer/install.mjs`. It checks for git, Docker, and Node, then asks three questions:

- **Which database.** A bundled local one (default, no cloud account anywhere) or your own Supabase project.
- **Which model.** Local Ollama by default, zero API keys. Or any provider through the gateway.
- **How much Spectre Agent:**

| Install profile | What you get |
|---|---|
| **Headless** | The agent with no web UI. Runs on a server, talks through Telegram, WhatsApp, Discord or raw HTTP. |
| **Standard** | The web app plus the essentials: chat, memory, monitor, settings. The default. |
| **Full** | Everything: the web app, Tempus time tracking, and the Workspaces code IDE. |

Already cloned? Run the wizard directly:

```bash
node installer/install.mjs
```

With a UI profile, open **http://127.0.0.1:3100** and enter your PIN. Headless, just message your bot.

> **Note:** the core is in this repo at [`core/`](core/) and builds from source; the installer compiles it. Nothing to pull, nothing sealed. To update: `git pull && docker compose up -d --build`.

---

## Modules

Everything in the home is a module. Chat is a module. Memory is a module. So are the monitor, the library, and settings. They all run on the same platform you build on, under the same rules and quotas.

<div align="center">
<img src="docs/media/customize.png" alt="Blobs and slots panel, your modules in orbit" width="720">

*Your modules. Rearrange and recolor them, or add one you wrote yourself.*
</div>

So when Spectre Agent is missing something you want, you don't file a feature request. You build a module:

- **Data mode.** Write a JSON description (widgets, data, actions) and Spectre Agent renders it in the app's style. No build step, nothing to compile, and no way to inject code, because the schema is data.
- **Code mode.** Ship real code. Spectre Agent treats it as untrusted: fingerprint-checked (SHA-384) before it runs, locked in a sandboxed iframe, with no network of its own and a short read-only list of SDK calls with rate caps.

Whoever wrote it, every module gets the same deal:

- **Private storage.** Its own key-value and row store, pinned to its id by the core. No peeking at other modules' data.
- **Only the capabilities you grant.** The manifest asks, you decide. Fetches go through an allowlist and get logged.
- **Same gates.** Module actions pass the same permission checks and quotas as everything else.
- **Signed manifests.** An ed25519 keyring (`SPECTRE_MODULE_TRUSTED_KEYS`) verifies who made it. Tampered or unsigned? Refused.
- **Drop-in install.** Put it in the data dir. The registry checks the manifest before it loads.

### A real module

This is **Tally**, a tiny counter built with no code, just a manifest: an id, a private data store, and a UI written as data.

```json
{
  "schemaVersion": 2,
  "id": "tally",
  "label": "Tally",
  "version": "0.1.0",
  "route": "/m/tally",
  "icon": "ListChecks",
  "uiMode": "data",
  "permissions": { "data": "rw" },
  "backend": {
    "routes": [
      { "method": "POST", "path": "/tick",   "binding": "data.append",
        "args": { "collection": "ticks", "doc": { "at": "{date}", "note": "{body.note}" } } },
      { "method": "GET",  "path": "/recent", "binding": "data.rows",
        "args": { "collection": "ticks", "limit": 50 } }
    ]
  },
  "ui": { "schema": {
    "version": 2,
    "title": "Tally",
    "data":    { "recent": { "source": "module", "endpoint": "/recent" } },
    "actions": { "tick": { "steps": [
      { "step": "module", "endpoint": "/tick", "method": "POST", "body": "@form:note" },
      { "step": "refetch", "names": ["recent"] }
    ] } },
    "body": [
      { "kind": "form",      "fields":  [ { "bind": "note", "label": "Note", "placeholder": "what happened?" } ] },
      { "kind": "actionRow", "buttons": [ { "label": "Tally", "action": "tick", "variant": "primary" } ] },
      { "kind": "list", "from": "recent.items", "empty": "No ticks yet.",
        "rowHead": "{{item.doc.note}}", "rowMeta": "{{item.created_at}}" }
    ]
  } }
}
```

No build step, no React, no server of its own. `permissions.data: "rw"` gives it a private store walled off from every other module. The `backend` routes append and read its own rows, and the `ui.schema` is the whole screen: a form, a button, and a list that re-reads after each tick. Drop it in your data dir and a Tally orb appears in the home, sandboxed and running. Yours can be this small, or grow into [Pulse](core/supabase/seed-pulse-demo.sql), the live-telemetry reference that does the same with four data sources and a polling feed.

Full SDK reference: [`docs/MODULES.md`](docs/MODULES.md).

---

## The shell comes off

The web UI is optional. Turn it off and Spectre Agent keeps working:

- Text it. Telegram, WhatsApp, and Discord ride the same conversation engine; replies come back to the channel, images included.
- Walk away. Every turn runs on the server, so you can shut your laptop mid-answer and it finishes without you.
- Let it run errands. Recurring reports, check-ins, and the nightly memory cleanup, all on the built-in scheduler.
- Script it. The whole core is one HTTP API behind one token, so you can cron it, pipe it, or wire it into anything.
- Stay reachable. It pings your phone when something matters.

Don't like this shell? Build your own. It's MIT, it holds no data, and every feature you see is an API call. Fork it, reskin it, or start from scratch.

---

## What it can do

**Any model.** One agent loop speaks the OpenAI API to a [LiteLLM](https://docs.litellm.ai) gateway: Anthropic, OpenAI, Gemini, Bedrock, Azure, Ollama, vLLM, 100+ backends. Local models need no keys. Pick a model per message, or let the router choose.

**Tools, gated.** Dozens of them: shell, files, calendar, schedules, screenshots, modules. Every call passes an approval gate with saved permissions and quotas. It blocks disk-wiping commands before the prompt even appears. A daily spend cap cuts off paid models at your limit; local models run free.

**Persistent memory.** Tell it once and it finds the fact later by meaning, not keywords, across conversations. Overnight, it merges duplicate memories and lets stale ones fade. Feed it PDFs and it answers from them.

**Skills.** Written playbooks in plain Markdown: your own procedures the agent loads on demand and follows. Drop new ones in the data dir and it picks them up.

**Autonomy, off by default.** A heartbeat can wake it for small background runs, with a capped budget, a tool allowlist, and a hard time limit. Until you turn it on, it does nothing on its own.

**Self-reporting.** It logs problems, pushes the critical ones to your phone, and turns the health check red when the stack breaks.

---

## Why this exists

I built Spectre Agent for my ADHD. Boring tasks pile up, and executive dysfunction makes starting them the hardest part. I wanted something that helps me lock in. Not another thing to manage.

It started as a simple chatbot. Then it grew tools and became an agent. Then it got a voice and took over my calendar. Then it started doing tasks on its own when it judged them useful. I built a coding space into it so it could watch me work. I juggle a lot of projects and couldn't care less about time logging, but my employer does, so I built Tempus, a time tracker, right into it.

Then a friend saw it running and asked if I'd tried Hermes. I said no. Everything Hermes has that I need, mine already had. Whatever it lacks, I can build as a module. He said: then why not open it up. So here we are — shell and core, both open, in one repo.

This is an early version and it will keep improving. I daily-drive a private build with more capabilities, and I'm moving them over one by one, each once it's stable enough (to the best of my abilities) to hand to strangers. Expect steady updates, not a finished product.

And I won't stop. I built this because I needed it to exist, for the days when starting anything at all felt impossible — and that's not something I walk away from because a graph stays flat. No number of stars makes this worth doing, and no shortage of them makes it not. I opened it up because the thing that got me through my week might do the same for yours; if you know that same weight, it was built for you too, and it's yours now.

---

## Provider rules

By default, Spectre Agent talks to a gateway you control, using your own API keys or local models. That is the supported path. Configure it in [`core/`](core/) (`docker-compose.yml` plus `litellm-config.yaml`).

> ### A note on subscriptions
>
> Spectre Agent can also run on a personal AI subscription instead of metered API keys. It drives your own Claude, Codex, or Gemini session through the vendor's own CLI, the way their first-party agent tools do. All three ship off by default; turn one on in the config or in Settings → Providers (with `SPECTRE_ALLOW_CLI_UI=1`). Check your provider's terms first, since some don't allow it. That's why it's opt-in. Either way, the default stays your own API key through the gateway, or a local model with no keys.

---

## How it's built

Two halves, both open source, in this one repo.

The repo root (**shell**) is the optional UI and a thin proxy. MIT, open, yours to modify.

[`core/`](core/) is everything else: model routing, memory, tools, modules, scheduling, autonomy. It's a Bun/Hono backend you build from source. It binds to a loopback port and answers nothing without the token. Even past the PIN, the core stays silent without it, and you can read how in the source.

<img src="docs/media/architecture.svg" alt="browser to shell to loopback core to your model gateway" width="100%">

| Piece | Where |
|---|---|
| PIN / session gate (browser edge) | `src/proxy.ts`, `src/lib/session.ts` |
| Catch-all proxy to the core (adds `CORE_TOKEN`, streams SSE through) | `src/app/api/[...path]/route.ts` |
| Blob home and module slots | `src/components/blob/*` |
| Module runtimes: data-mode renderer and code-mode sandbox | `src/components/ui/SchemaRuntime.tsx`, `src/components/ui/ModuleFrame.tsx` |
| Tabs (chat, monitor, memory, settings, modules) | `src/app/*` |
| Provider-agnostic brain | `core/src/lib/ai/providers/litellm.ts`, OpenAI-compatible tool loop |
| Tool execution and governance | `core/spectre-mcp-broker/`, MCP broker |

The shell handles the PIN. The core checks `CORE_TOKEN`. The `/api/auth/pin` route is answered in the shell, so your PIN never reaches the core. Everything else under `/api/*` passes through untouched.

For the full data-flow and security walkthrough, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

More compose profiles: `--profile screenshot` (Playwright capture), `--profile workspace` (an embedded code IDE). Telegram setup lives in `.env.docker.example`.

---

## Coming from Hermes or OpenClaw?

Bring your stuff:

```bash
node installer/import-configs.mjs
```

It finds your existing install, lifts the provider keys, channel tokens and preferences into Spectre Agent's `.env.docker`, and stages your persona and memory files for adoption. You don't start from zero.

---

## Roadmap

Built in stages. Now: **early development**, then harden & expand, then the [Workshop](https://elias-teubner.dev/spectre). Shell and core are both open source. Full detail in **[ROADMAP.md](ROADMAP.md)**.

---

## Documentation

| Doc | What's in it |
|---|---|
| [`agent-install/`](agent-install/) | Playbook an AI CLI follows to install Spectre Agent and set up the daemon |
| [`docs/M6-INSTALLER.md`](docs/M6-INSTALLER.md) | Full install and operations guide, troubleshooting |
| [`docs/MODULES.md`](docs/MODULES.md) | Module SDK: build your own tools and screens |
| [`.env.docker.example`](.env.docker.example) | Every knob, documented |
| [`SECURITY.md`](SECURITY.md) | Reporting and the threat model in brief |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to help |

---

## License

MIT. See [LICENSE](LICENSE). It covers the whole project: the shell at the repo root and the core in [`core/`](core/). Both are fully open source. Third-party dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Issues and PRs welcome. If you spot code that could be cleaner or faster, send a pull request. Suggestions of any size help.
