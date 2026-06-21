<div align="center">

<img src="docs/media/banner.png" alt="Spectre Agent — it's your assistant. Haunt your own machine." width="760">

<img src="docs/media/home.png" alt="Spectre Agent — a living 3D home with your modules in orbit" width="760">

**A self-hosted AI agent you build into exactly what you need.**

**Spectre Agent** is a ghost on your machine — a self-hosted agent in a living 3D home where every capability orbits as a **module you can write yourself**. I built it to fight my own ADHD: something that remembers what matters, breaks the "starting is the hard part" inertia, and quietly runs the boring recurring stuff so I can lock in — then made it extensible so it becomes whatever *you* need. Your hardware, your models, your keys. Wear the interface, or run it headless on your server.

[![CI](https://github.com/EliasT5/spectre-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/EliasT5/spectre-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-5965e0.svg)](LICENSE)
[![Self-hosted](https://img.shields.io/badge/self--hosted-docker%20compose-1a1a2e.svg)](#quick-install)
[![Bring your own model](https://img.shields.io/badge/brain-bring%20your%20own%20model-7a5cff.svg)](#what-it-can-do)
[![Status: early development](https://img.shields.io/badge/status-early%20development-f59e0b.svg)](#)

**[Quick install](#quick-install)** · **[Build a module](docs/MODULES.md)** · **[Roadmap](ROADMAP.md)**

</div>

---

> ## ⚠️ Recently opened — read the code before you run it
>
> The core went public sooner than planned, and the latest commit hasn't been through a full clean-room test yet. This is early-stage software that runs with shell access — read the files and verify it yourself before you run anything on your machine. Don't take my word that it's safe.

---

**What makes it different**

- 🧩 **You build it out** — every capability is a module orbiting the blob. Add your own two ways: a JSON description (no code) or your own code. It grows the way *you* want, not the way a feature-request queue allows.
- 🧠 **Built to beat executive dysfunction** — born from fighting my own ADHD: it remembers across conversations, runs recurring tasks on its own, and is shaped to help you *start* and stay locked in — not another thing to manage.
- 🏠 **A home, not a chat box** — a living 3D interface with your modules in orbit; or take it off and run it invisible over Telegram, WhatsApp, Discord or HTTP.
- 🔑 **Entirely yours** — self-hosted on your hardware, your models, your keys; bring an API key or run a local model with no cloud account at all.

---

> **🚧 Early development.** Spectre Agent is young and moving fast — expect rough edges, breaking changes, and features that aren't finished yet. Kick the tires, file issues, and help shape it; just don't trust it with anything critical for now.

_On the name: this is **Spectre Agent** — a ghost that lives on your machine and answers only to you (that's the tagline). It has **no relation** to the [Spectre CPU vulnerability](https://en.wikipedia.org/wiki/Spectre_%28security_vulnerability%29); the name is about the ghost, not the exploit._

## Quick Install

**Linux / macOS**

```bash
curl -fsSL https://elias-teubner.dev/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://elias-teubner.dev/install.ps1 | iex
```

One line. The installer brings everything else, and if git, Docker or Node are missing it offers to install them too. Then it asks three questions:

- **Which database.** A bundled local one (default, no cloud account anywhere) or your own Supabase project.
- **Which brain.** Local Ollama by default, zero API keys. Or any provider through the gateway.
- **How much Spectre Agent:**

| Install profile | What you get |
|---|---|
| **Headless** | The ghost without the shell. Runs on a server, talks through Telegram, WhatsApp, Discord or raw HTTP. |
| **Standard** | The web app plus the essentials: chat, memory, monitor, settings. The default. |
| **Full** | Everything: the web app, Tempus time tracking, and the Workspaces code IDE. |

Already cloned? Run the wizard directly:

```bash
node installer/install.mjs
```

With a UI profile, open **http://127.0.0.1:3100** and enter your PIN. Headless, just message your bot.

> **Note:** the brain lives in this repo at [`core/`](core/) and builds from source — the installer compiles it. Nothing to pull, nothing sealed. To update: `git pull && docker compose up -d --build`.

---

## Modules

Look at the blob. Every orb circling it is a module. Chat is a module. Memory is a module. The monitor, the PDF library, settings: modules. The platform they run on is the same one you get to build on, same rules, same guardrails.

<div align="center">
<img src="docs/media/customize.png" alt="Blobs and slots panel, your modules in orbit" width="720">

*Your modules in orbit. Drag, recolor, rename. Or add a new orb you wrote yourself.*
</div>

So when Spectre Agent is missing something you want, you don't file a feature request. You build a module:

- **Data mode.** Write a JSON description: widgets, data, actions. Spectre Agent draws it in the house style. No build step, nothing to compile, and no way to inject code, because the schema is data.
- **Code mode.** Ship real code. Spectre Agent treats it like a stranger in the house: fingerprint-checked (SHA-384) before a single byte runs, locked in a sandboxed iframe, no network of its own, and a short read-only list of SDK calls with rate caps.

Whoever wrote it, every module gets the same deal:

- **Private storage.** Its own key-value and row store, pinned to its id by the core. No peeking at other modules' data.
- **Only the capabilities you grant.** The manifest asks, you decide. Fetches go through an allowlist and get logged.
- **The house rules.** Module actions pass the same permission gate and quotas as everything else.
- **Signed manifests.** An ed25519 keyring (`SPECTRE_MODULE_TRUSTED_KEYS`) verifies who made it. Tampered or unsigned? Refused.
- **Drop-in install.** Put it in the data dir. The registry checks the manifest before anything wakes up.

Build your first one: [`docs/MODULES.md`](docs/MODULES.md).

---

## The shell comes off

The 3D home is a window. Close it and Spectre Agent keeps working:

- **Text it.** Telegram, WhatsApp and Discord ride the same conversation engine. Replies come back to the channel, images included.
- **Walk away.** Every turn runs on the server. Shut your laptop mid-answer; the answer finishes and waits for you.
- **Let it run errands.** Recurring reports, check-ins, the nightly memory cleanup, all on the built-in scheduler.
- **Script it.** The whole core is one HTTP API behind one token. cron it, pipe it, wire it into anything.
- **Stay reachable.** It still pings your phone when something matters.

And if you don't like this shell? Build your own. It's MIT, it holds no data, and every feature you see is an API call. Fork it, reskin it, or replace it from scratch.

---

## What it can do

**Any brain.** One agent loop speaks the OpenAI API to a [LiteLLM](https://docs.litellm.ai) gateway: Anthropic, OpenAI, Gemini, Bedrock, Azure, Ollama, vLLM, 100+ backends. Local models need no keys at all. Pick a model per message or let the router decide.

**Tools, on a leash.** Dozens of them: shell, files, calendar, schedules, screenshots, modules. Every call passes an approval gate with saved permissions and quotas. Disk-wiping commands get blocked before the approval prompt even appears. A daily spend cap cuts off paid models at your limit; local models run free forever.

**A memory that sticks.** Tell it once and it finds the fact later by meaning, not keywords, even from another conversation. At night it dreams: merges duplicate memories, lets stale ones fade. Feed it PDFs and it answers from them.

**Skills it follows.** Skills are written playbooks in plain Markdown — your own procedures the agent loads on demand and follows. Drop new ones in the data dir and it picks them up.

**Autonomy, off by default.** A heartbeat can wake it for small background runs: capped budget, tool allowlist, hard time limit. Until you flip that switch, it does nothing on its own.

**It tells on itself.** Problems get logged, critical ones hit your phone, and the health probe reports red over a broken stack instead of smiling.

---

## Why this exists

I built Spectre Agent for my ADHD. Boring tasks pile up, and executive dysfunction makes starting them the hardest part. I wanted something that helps me lock in. Not another thing to manage.

It started as a simple chatbot. Then it grew tools and became an agent. Then it got a voice and took over my calendar. Then it started doing tasks on its own when it judged them useful. I built a coding space into it so it could watch me work. I juggle a lot of projects and couldn't care less about time logging, but my employer does, so I built Tempus, a time tracker, right into it.

Then a friend saw it running and asked if I'd tried Hermes. I said no. Everything Hermes has that I need, mine already had. Whatever it lacks, I can build as a module. He said: then why not open it up. So here we are — shell and core, both open, in one repo.

This is an early version and it will keep improving. I daily-drive a private build with more capabilities, and I'm moving them over one by one, each once it's stable enough (to the best of my abilities) to hand to strangers. Expect steady updates, not a finished product.

And I won't stop. I built this because I needed it to exist, for the days when starting anything at all felt impossible — and that's not something I walk away from because a graph stays flat. No number of stars makes this worth doing, and no shortage of them makes it not. I opened it up because the thing that got me through my week might do the same for yours; if you know that same weight, it was built for you too, and it's yours now.

---

## Provider rules

Spectre Agent's standard brain talks to a gateway you control, with your own API keys or your own local models. That is the supported path. Configure it in [`core/`](core/) (`docker-compose.yml` plus `litellm-config.yaml`).

> ### A note on subscriptions
>
> Spectre Agent can run on a personal AI subscription instead of metered API keys — scripting your own Claude / Codex / Gemini session through their CLIs, where you stay on your own subscription (this is what the vendors' own CLIs / agent SDKs are for). All three ship off by default; switch them on in the config, or toggle them live in Settings → Providers (when the core runs with `SPECTRE_ALLOW_CLI_UI=1`). **Use at your own risk:** depending on the vendor and how you use it, driving a consumer subscription this way may run against their terms and could get the account flagged — which is exactly why it's opt-in and off by default. The default brain is your own API key through the gateway, or a local model with no keys at all.

---

## How it's built

Two halves, both open source, in this one repo.

The repo root (**shell**) is the optional UI and a thin proxy. MIT, open, yours to gut.

[`core/`](core/) (**brain**) is everything else: model routing, memory, tools, modules, scheduling, autonomy. It's a Bun/Hono backend you build from source. It binds to a loopback port and answers nothing without the token. Get past the PIN somehow and the core still won't talk to you — and now you can read exactly why, line by line.

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

Built in stages — **early development** (now) → harden & expand → the [Workshop](https://elias-teubner.dev/spectre). Shell and core are both open source. Full detail in **[ROADMAP.md](ROADMAP.md)**.

---

## Documentation

| Doc | What's in it |
|---|---|
| [`docs/M6-INSTALLER.md`](docs/M6-INSTALLER.md) | Full install and operations guide, troubleshooting |
| [`docs/MODULES.md`](docs/MODULES.md) | Module SDK: build your own tools and screens |
| [`.env.docker.example`](.env.docker.example) | Every knob, documented |
| [`SECURITY.md`](SECURITY.md) | Reporting and the threat model in brief |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to help |

---

## License

MIT — see [LICENSE](LICENSE). It covers the whole project: the shell at the repo root and the core in [`core/`](core/). Both are fully open source. Third-party dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Issues and PRs are happily accepted — if you spot a part of the code that could be cleaner, faster, or just better, send a pull request. Suggestions and improvements of any size are welcome.
