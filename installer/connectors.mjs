// The registry of everything Spectre can connect to — the single source of truth
// for "anything connectable." The installer's detect + setup flow iterates this,
// so adding a service is just adding an entry here.
//
// A CLI connector can be authed two ways, and the installer stores BOTH when
// given (so the later model picker can use either):
//   login : run the account login. `capture:true` means the command prints a
//           long-lived token we capture into `env` (portable into Docker — the
//           Claude path). `capture:false` = host-only OAuth that doesn't port
//           into the container, so the container uses the API key instead.
//   apikey: a plain API key env var (always portable into the container).
//   install: how the wizard can pull a missing CLI ({ npm } or { url }).

export const CONNECTORS = [
  {
    id: "claude-code",
    label: "Claude Code — Anthropic subscription (PERSONAL use only — off by default; against Anthropic ToS to ship)",
    kind: "cli",
    bin: "claude",
    required: false,
    install: { npm: "@anthropic-ai/claude-code" },
    login: {
      cmd: "claude setup-token",
      capture: true,
      env: "CLAUDE_CODE_OAUTH_TOKEN",
      note: "personal-use opt-in that prints a long-lived token for your own Claude subscription",
    },
    apikey: { env: "ANTHROPIC_API_KEY", note: "pay-per-use fallback" },
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI — Google",
    kind: "cli",
    bin: "gemini",
    install: { npm: "@google/gemini-cli" },
    login: { cmd: "gemini", capture: false, note: "host-only OAuth — the container itself uses the API key" },
    apikey: { env: "GOOGLE_GENAI_API_KEY" },
  },
  {
    id: "codex-cli",
    label: "Codex CLI — OpenAI",
    kind: "cli",
    bin: "codex",
    install: { npm: "@openai/codex" },
    login: { cmd: "codex login", capture: false, note: "host-only — the container uses the API key" },
    apikey: { env: "OPENAI_API_KEY" },
  },
  {
    id: "ollama",
    label: "Ollama — local models (embeddings + dream/learn)",
    kind: "local",
    bin: "ollama",
    install: { url: "https://ollama.com/download" },
    auth: {
      type: "none",
      note: "Runs on the host; the container reaches it at host.docker.internal. Recommended: `ollama pull nomic-embed-text` + `ollama pull gemma3`.",
    },
  },
  {
    id: "anthropic-api",
    label: "Anthropic API key (fallback / no-subscription)",
    kind: "api",
    auth: { type: "apikey", env: "ANTHROPIC_API_KEY" },
  },
  {
    id: "openai-api",
    label: "OpenAI API key (image gen + GPT models)",
    kind: "api",
    auth: { type: "apikey", env: "OPENAI_API_KEY" },
  },
  {
    id: "google-api",
    label: "Google Gemini API key",
    kind: "api",
    auth: { type: "apikey", env: "GOOGLE_GENAI_API_KEY" },
  },
];
