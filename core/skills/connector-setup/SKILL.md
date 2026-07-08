---
name: connector-setup
description: Help the user connect or set up an integration (Microsoft, Google, GitHub, Telegram/WhatsApp/Discord, web push, CLI brains) — check status, guide the steps in plain English, and save what you can
trigger: When the user wants to connect, set up, or authenticate an integration / connector / CLI, or asks "how do I connect X", "help me set up Y", or "add the Z CLI"
autonomy: level-1
---

# Connector setup helper

Help the user connect an integration, one step at a time, in plain language. Most
setup happens in Settings — you guide them there and do the parts you can yourself.

## Always start here
Call `setup.status` to see what's already connected. Tell the user what's on and
what's off, then focus on the one thing they want.

## What you can DO for them (each asks the user to confirm first)
- `setup.save_secret` — save a token the user pastes: a **GitHub** token; a **CLI**
  token (pass `cli_id`: `claude-code` | `codex-cli` | `gemini-cli`); or a
  **Telegram / WhatsApp / Discord** bot token.
- `setup.add_cli` — register **any** command as a new brain (e.g. `grok`, `qwen`), so
  the user isn't limited to the built-in Claude/Codex/Gemini. Reminder to tell them:
  the CLI's binary has to already be installed in the core container.

After saving anything, call `setup.status` again and confirm it took.

## What you CANNOT do — walk the user through it instead
- **Microsoft**: the one-click sign-in is in **Settings → Microsoft 365 → "Sign in
  with Microsoft"** (it shows a short code to enter at microsoft.com/devicelogin).
  You can't run it from chat — send them there. Then it reads their Outlook calendar
  and email. (Personal accounts need their own Azure app Client ID in "Advanced".)
- **Google**: needs a Google Cloud OAuth app. Guide them: create an OAuth client,
  enable the **Calendar + Gmail** APIs, add the redirect URI shown in
  **Settings → Google**, add themselves as a **test user**, then paste the Client ID
  + secret in that card. (Gmail is a Google "restricted" scope, so it's bring-your-own-app.)
- **Claude CLI auth**: they run `claude setup-token` on their own computer, copy the
  token, and give it to you — offer to save it with `setup.save_secret` (cli_id
  `claude-code`). Or they point Claude at a mounted `~/.claude` login.
- **Codex CLI auth**: either an OpenAI API key (save via `setup.save_secret`, cli_id
  `codex-cli`), or mounting their `~/.codex` login for ChatGPT-subscription auth.
- Creating cloud apps, or running commands on the user's machine — you can only
  instruct; you can't do these.

## Style
Plain English, one step at a time. Never dump the whole list — ask what they want,
then walk just that one. Confirm each secret before you save it.
