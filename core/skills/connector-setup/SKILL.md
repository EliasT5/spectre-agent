---
name: connector-setup
description: Walk the user through every Spectre setup step — GitHub, web push, Microsoft 365, Google, Telegram/WhatsApp/Discord channels, CLI brains (Claude/Codex/Gemini), custom CLIs, and feature toggles. Check status, save what you can, guide the rest in plain English.
trigger: When the user wants to connect, set up, or authenticate an integration / connector / CLI, or asks "how do I connect X", "help me set up Y", or "add the Z CLI", or "what's already linked"
autonomy: level-1
---

# Connector setup — complete guide

Help the user set up every part of Spectre that needs authentication or a secret: cloud integrations, chat channels, CLI brains, and custom commands. Work through one item at a time in plain language. Most setup happens in Settings, but you can save tokens directly.

## Always start here

Call `setup.status` first. It tells you what's already connected and what's still off. Show the user the status, then ask which one thing they want to set up right now. Focus on that one only — don't dump the whole list.

---

## 1. GitHub token (Workspace repo clone/push)

**What it does:** Lets Spectre push/pull code from your GitHub repos without entering credentials each time.

**What the user provides:** A GitHub personal access token (PAT).

**Can Spectre do it?** YES. You can save the token via `setup.save_secret` with `target: "github_token"`. The user pastes the token, you confirm it, and it's saved. Alternatively, the user can go to **Settings → GitHub → "Login with GitHub"** and use device-flow authentication.

**Steps:**
1. Ask: "Do you want to paste a GitHub token, or use the device login in Settings?"
2. If token: "Create a GitHub PAT at github.com/settings/tokens (scope: `repo`), copy it, and paste it here."
3. Confirm before saving: "I'll save this token as your GitHub auth."
4. Use `setup.save_secret` with `target: "github_token"` and the token they provided.
5. Call `setup.status` again to confirm it's listed.

---

## 2. Web push (browser notifications)

**What it does:** Sends Spectre alerts to your browser instead of only through chat. Requires a push service and client-side setup.

**What the user provides:** A push service subject (mailto: URL or https: endpoint) and browser permission.

**Can Spectre do it?** GUIDE ONLY — you cannot generate keys or manage subscriptions from chat.

**Steps:**
1. Send them to **Settings → Web push**.
2. They click **"Generate keys"** — this creates a push service keypair (public/private).
3. They add a subject (e.g., `mailto:your-email@example.com` or a webhook URL).
4. Click **Save**.
5. Then in their browser: enable notifications when prompted.
6. Test by sending a notification from Spectre.

---

## 3. Microsoft 365 (calendar, email, multi-account)

**What it does:** Reads your Outlook calendar and email across all connected Microsoft accounts. Personal @outlook/@hotmail accounts need extra setup.

**What the user provides:** Microsoft device code (automatic), or Azure app credentials for personal accounts.

**Can Spectre do it?** GUIDE ONLY — device login and advanced auth must happen in Settings.

**Steps:**
1. Send them to **Settings → Microsoft 365**.
2. They click **"Sign in with Microsoft"** — a short code appears that they enter at `microsoft.com/devicelogin`.
3. Approve in their Microsoft account.
4. Spectre syncs their calendar and mail.

If they have personal accounts (@outlook/@hotmail):
5. They go to **Settings → Microsoft 365 → Advanced**.
6. They create an Azure app (or use an existing one with Calendar + Mail scope), copy the Client ID, and paste it.
7. Spectre uses that app to connect personal accounts.

---

## 4. Google (Google Calendar + Gmail, multi-account)

**What it does:** Reads your Google Calendar and Gmail across all connected Google accounts.

**What the user provides:** Google Cloud OAuth app credentials (Client ID + Client Secret).

**Can Spectre do it?** GUIDE ONLY — you can't create cloud apps or run browser flows from chat.

**Steps:**
1. Guide them to create a Google Cloud OAuth app:
   - Go to Google Cloud Console (console.cloud.google.com).
   - Create a new project (or use an existing one).
   - Enable **Google Calendar API** and **Gmail API** (note: Gmail is a restricted scope, so they must bring their own app).
   - Create an OAuth 2.0 credential: **Create credentials → OAuth client ID → Web application**.
   - Add authorized redirect URIs (Spectre will show them the exact URI in Settings).
2. Send them to **Settings → Google**.
3. Copy the redirect URI shown there.
4. Back in Google Cloud Console, add that redirect URI to their OAuth client.
5. Add themselves as a test user in the OAuth consent screen.
6. Return to **Settings → Google** and paste their Client ID + Client Secret.
7. Click **Connect** — this opens a browser flow to grant Spectre access.
8. Call `setup.status` to confirm.

---

## 5. Channels — Telegram / WhatsApp / Discord (let people chat with Spectre)

**What it does:** Lets people message Spectre via Telegram, WhatsApp, or Discord. Spectre replies in each channel.

**What the user provides:** A bot token (Telegram / WhatsApp / Discord) and allowed sender IDs.

**Can Spectre do it?** PARTIALLY. You can save each bot token, but the user must set allowed sender IDs manually in Settings.

**For Telegram:**
1. Ask the user to create a bot via Telegram's BotFather (@botfather on Telegram).
2. BotFather gives them a token.
3. They paste it to you.
4. Confirm: "I'll save this Telegram bot token."
5. Use `setup.save_secret` with `target: "telegram_bot_token"` and the token.
6. Then guide them to **Settings → Channels → Telegram → Allowed Sender IDs** and add Telegram user IDs (comma-separated; empty = nobody can talk).
7. Test by messaging the bot.

**For WhatsApp:**
1. Ask: "Do you have a WhatsApp Business bot token?" (Usually from Meta or a WhatsApp integration).
2. They paste it to you.
3. Confirm: "I'll save this WhatsApp token."
4. Use `setup.save_secret` with `target: "whatsapp_token"` and the token.
5. Guide them to **Settings → Channels → WhatsApp → Allowed Sender IDs** and add phone numbers or IDs.

**For Discord:**
1. Ask them to create a Discord bot (discord.com/developers/applications).
2. They enable Message Content intent in **Bot → Privileged Gateway Intents**.
3. Copy the bot token under **Bot**.
4. They paste it to you.
5. Confirm: "I'll save this Discord bot token."
6. Use `setup.save_secret` with `target: "discord_bot_token"` and the token.
7. Guide them to **Settings → Channels → Discord → Allowed Sender IDs** (Discord user IDs, comma-separated).
8. Have them add the bot to their Discord server with appropriate permissions.

---

## 6. CLI brains (Claude Code, Codex, Gemini) — subscription CLIs

**What it does:** Lets Spectre run Claude Code, Codex, or Gemini CLI commands in the background so you can use multiple AI backends.

**What the user provides:** Auth credentials (API key or token from running a CLI on their machine). Also: "CLI management" must be turned on in Settings.

**Can Spectre do it?** PARTIALLY. You can save each CLI token, but the user must (a) ensure the CLI is installed in the core container, and (b) enable "CLI management" in Settings.

**Prerequisites:**
- Guide them to enable **Settings → Danger Zone → "CLI management"** (they must do this; Spectre cannot).
- If the CLI is not installed in the core container: Guide them to rebuild the core with the flag `INSTALL_CLIS=1` at build time, or set the CLI binary path manually in Settings.

**For Claude Code (claude-code):**
1. They run `claude setup-token` on their own computer.
2. It prints a token.
3. They copy it and paste it to you.
4. Confirm: "I'll save this Claude Code token."
5. Use `setup.save_secret` with `target: "cli_token"`, `cli_id: "claude-code"`, and the token.
6. Alternatively, they can point Spectre at `~/.claude` login (mount it).

**For Codex CLI (codex-cli):**
1. They provide an OpenAI API key, OR they mount `~/.codex` (ChatGPT subscription auth).
2. If they paste an API key:
   - Confirm: "I'll save this OpenAI API key for Codex."
   - Use `setup.save_secret` with `target: "cli_token"`, `cli_id: "codex-cli"`, and the key.

**For Gemini CLI (gemini-cli):**
1. They get a Google AI (Gemini) API key from Google AI Studio (aistudio.google.com).
2. They paste it to you.
3. Confirm: "I'll save this Gemini API key."
4. Use `setup.save_secret` with `target: "cli_token"`, `cli_id: "gemini-cli"`, and the key.

---

## 7. Custom CLI (add any command as a brain)

**What it does:** Registers a command (already installed in the core container) as a new Spectre brain, so you can use `grok`, `qwen`, `llama`, or any other CLI.

**What the user provides:** Command name, full path or command string, optional arguments, optional auth env var.

**Can Spectre do it?** YES — but two prerequisites:
- The binary must already be in the core container (baked into the Docker image or mounted).
- The user must enable **Settings → Danger Zone → "Custom CLI/command backends (runs commands)"** (Spectre cannot enable this; it's RCE-gated).

**Steps:**
1. Confirm prerequisites: "Is the CLI already installed in the core container, and have you enabled 'Custom CLI/command backends' in Settings → Danger Zone?"
2. Ask for:
   - **Name:** What you'll call it (e.g., "grok", "qwen").
   - **Command:** The full command or path (e.g., `/usr/local/bin/grok` or `qwen`).
   - **Optional args:** Any default flags (e.g., `--model 7b`).
   - **Optional auth:** Env var name + value (e.g., `QWEN_API_KEY=abc123`).
3. Confirm: "I'll register `grok` as a brain with command `/usr/local/bin/grok` and default args `--model 7b`."
4. Use `setup.add_cli` with `name`, `command`, `args` (if any), and `env_name`/`env_value` (if it needs an auth env var).
5. Call `setup.status` to confirm it's listed.

---

## 8. Feature toggles — Danger Zone

**What it does:** Advanced toggles that change Spectre's behavior: CLI management, custom CLI backends, agent .env access, and permission/autonomy modes.

**What the user provides:** Manual toggles in Settings.

**Can Spectre do it?** NEVER. These are safety gates; you must guide the user only.

**Explain each:**
- **"CLI management"**: Turn this on to manage Claude/Codex/Gemini CLI auth from chat. Leave it off if you only want Settings-based auth.
- **"Custom CLI/command backends (runs commands)"**: Turn this on to register custom CLIs via `setup.add_cli`. This is RCE — only enable if you trust Spectre's prompts.
- **"Agent access to .env files"**: Turn this on to let Spectre read your .env for secrets (risky). Leave it off unless needed.
- **Permission/autonomy modes**: Control how much Spectre can do without asking. Read each carefully before changing.

**Steps:**
1. Guide them to **Settings → Danger Zone**.
2. Read the description of each toggle carefully.
3. They decide which ones to enable.
4. You never flip these for them.

---

## How to work through setup

1. **Start:** Call `setup.status`.
2. **Show status:** Tell the user what's on and what's off.
3. **Ask focus:** "Which one would you like to set up right now?"
4. **Walk one item:** Pick one from the list above; follow its steps.
5. **Confirm:** Use `setup.status` again after each save.
6. **Repeat:** "Do you want to set up another one, or are we done?"

## Tone and style

- Plain English, one thing at a time.
- Never dump the whole list on them.
- Confirm each secret before saving.
- When you can't do something (Microsoft, Google, cloud apps, user's machine), say clearly: "I'll guide you to Settings, then you do this part."
- Be direct: "You need to turn on 'CLI management' in Danger Zone for this to work. Let me know when you've done that."
