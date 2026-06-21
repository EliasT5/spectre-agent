// The registry of everything Spectre can connect to — the single source of truth
// for "anything connectable." The installer's detect + setup flow iterates this,
// so adding a service is just adding an entry here.
//
// A CLI connector can be authed two ways, and the installer stores BOTH when
// given (so the later model picker can use either):
//   login : run the account login. `capture:true` means the command prints a
//           long-lived token we capture into `env` (portable into Docker -- the
//           Claude path). `capture:false` = host-only OAuth that doesn't port
//           into the container, so the container uses the API key instead.
//   apikey: a plain API key env var (always portable into the container).
//   install: how the wizard can pull a missing CLI ({ npm } or { url }).

export const CONNECTORS = [
  {
    id: "claude-code",
    label: "Claude Code -- Anthropic subscription (opt-in brain)",
    kind: "cli",
    bin: "claude",
    required: false,
    install: { npm: "@anthropic-ai/claude-code" },
    login: {
      cmd: "claude setup-token",
      capture: true,
      env: "CLAUDE_CODE_OAUTH_TOKEN",
      note: "opt-in token for your own Claude subscription",
    },
    apikey: { env: "ANTHROPIC_API_KEY", note: "pay-per-use fallback" },
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI -- Google",
    kind: "cli",
    bin: "gemini",
    install: { npm: "@google/gemini-cli" },
    login: { cmd: "gemini", capture: false, note: "host-only OAuth -- the container itself uses the API key" },
    apikey: { env: "GOOGLE_GENAI_API_KEY" },
  },
  {
    id: "codex-cli",
    label: "Codex CLI -- OpenAI",
    kind: "cli",
    bin: "codex",
    install: { npm: "@openai/codex" },
    login: { cmd: "codex login", capture: false, note: "host-only -- the container uses the API key" },
    apikey: { env: "OPENAI_API_KEY" },
  },
  {
    id: "ollama",
    label: "Ollama -- local models (embeddings + dream/learn)",
    kind: "local",
    bin: "ollama",
    install: { url: "https://ollama.com/download" },
    auth: {
      type: "none",
      note: "Runs on the host; the container reaches it at host.docker.internal. Recommended: `ollama pull nomic-embed-text` + `ollama pull gemma3`.",
    },
  },
];

// ---- declarative provider registry ------------------------------------------
// Each entry: { id, label, envVars, litellmPrefix, signupUrl }
//   envVars[0] is the canonical key written to .env.docker.
//   envVars[1..] are aliases checked during detection (read-only, not written).

export const API_PROVIDERS = [
  {
    id: "anthropic",
    label: "Anthropic",
    envVars: ["ANTHROPIC_API_KEY"],
    litellmPrefix: "anthropic",
    signupUrl: "https://console.anthropic.com",
  },
  {
    id: "openai",
    label: "OpenAI",
    envVars: ["OPENAI_API_KEY"],
    litellmPrefix: "openai",
    signupUrl: "https://platform.openai.com",
  },
  {
    id: "google",
    label: "Google (Gemini)",
    envVars: ["GOOGLE_GENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
    litellmPrefix: "gemini",
    signupUrl: "https://aistudio.google.com",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    envVars: ["OPENROUTER_API_KEY"],
    litellmPrefix: "openrouter",
    signupUrl: "https://openrouter.ai",
  },
  {
    id: "groq",
    label: "Groq",
    envVars: ["GROQ_API_KEY"],
    litellmPrefix: "groq",
    signupUrl: "https://console.groq.com",
  },
  {
    id: "mistral",
    label: "Mistral",
    envVars: ["MISTRAL_API_KEY"],
    litellmPrefix: "mistral",
    signupUrl: "https://console.mistral.ai",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    envVars: ["DEEPSEEK_API_KEY"],
    litellmPrefix: "deepseek",
    signupUrl: "https://platform.deepseek.com",
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    envVars: ["XAI_API_KEY"],
    litellmPrefix: "xai",
    signupUrl: "https://console.x.ai",
  },
  {
    id: "together",
    label: "Together AI",
    envVars: ["TOGETHER_API_KEY", "TOGETHERAI_API_KEY"],
    litellmPrefix: "together_ai",
    signupUrl: "https://api.together.ai",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    envVars: ["FIREWORKS_API_KEY", "FIREWORKS_AI_API_KEY"],
    litellmPrefix: "fireworks_ai",
    signupUrl: "https://fireworks.ai",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    envVars: ["CEREBRAS_API_KEY"],
    litellmPrefix: "cerebras",
    signupUrl: "https://cloud.cerebras.ai",
  },
  {
    id: "perplexity",
    label: "Perplexity",
    envVars: ["PERPLEXITY_API_KEY", "PERPLEXITYAI_API_KEY"],
    litellmPrefix: "perplexity",
    signupUrl: "https://perplexity.ai",
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    envVars: ["HF_TOKEN", "HUGGINGFACE_API_KEY"],
    litellmPrefix: "huggingface",
    signupUrl: "https://huggingface.co/settings/tokens",
  },
];

// ---- local daemon probes -----------------------------------------------------
// Each entry: { id, label, url, probePath }
// The installer fetches url+probePath (1.5 s timeout); success = daemon detected.

export const LOCAL_DAEMONS = [
  { id: "ollama",   label: "Ollama",    url: "http://127.0.0.1:11434", probePath: "/api/tags" },
  { id: "lmstudio", label: "LM Studio", url: "http://127.0.0.1:1234",  probePath: "/v1/models" },
  { id: "llamacpp", label: "llama.cpp", url: "http://127.0.0.1:8080",  probePath: "/v1/models" },
  { id: "vllm",     label: "vLLM",      url: "http://127.0.0.1:8000",  probePath: "/v1/models" },
];
