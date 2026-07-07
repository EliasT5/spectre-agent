import type { StreamChunk, StreamOptions } from "./types";

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";

export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Returns the model IDs currently pulled in the local Ollama instance.
 * Uses /api/tags (same endpoint as isOllamaAvailable). Returns [] on any error.
 */
// Sync snapshot of the last-fetched Ollama model list, so route() (which is
// synchronous) can recognize a pulled local model and send it to THIS provider
// instead of the LiteLLM catch-all. Warmed by listOllamaModels() (called on every
// GET /api/models and at provider detection).
let cachedModels: string[] = [];
export function ollamaModelsSync(): string[] {
  return cachedModels;
}

export async function listOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const names = (data.models ?? []).map((m) => m.name).filter(Boolean);
    cachedModels = names;
    return names;
  } catch {
    return [];
  }
}

interface OllamaChatChunk {
  model?: string;
  message?: { role: string; content: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export async function* streamOllama(opts: StreamOptions): AsyncGenerator<StreamChunk> {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model.id,
      stream: true,
      messages: [
        { role: "system", content: opts.system },
        ...opts.messages
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role, content: m.content })),
      ],
      options: {
        num_predict: opts.maxTokens ?? opts.model.maxOutputTokens,
      },
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Ollama error ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let model = opts.model.id;
  let inputTokens = 0;
  let outputTokens = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;

      let evt: OllamaChatChunk;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }

      if (evt.model) model = evt.model;
      if (evt.message?.content) {
        yield { type: "token", text: evt.message.content };
      }
      if (evt.done) {
        inputTokens = evt.prompt_eval_count ?? 0;
        outputTokens = evt.eval_count ?? 0;
      }
    }
  }

  yield { type: "done", model, inputTokens, outputTokens };
}

const NARRATION_MODEL = process.env.OLLAMA_NARRATION_MODEL || "llama3.2:1b";

export async function narrateToolCall(name: string, input: unknown): Promise<string> {
  const summary = (() => {
    if (!input || typeof input !== "object") return String(input ?? "").slice(0, 60);
    const entries = Object.entries(input as Record<string, unknown>);
    if (!entries.length) return "";
    const [k, v] = entries[0];
    return `${k}=${String(v).slice(0, 50)}`;
  })();
  const prompt = `Tool: ${name}\nInput: ${summary}\nIn 6 words, what is this doing? Start with a verb.`;
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: NARRATION_MODEL,
        prompt,
        stream: false,
        options: { num_predict: 20, temperature: 0 },
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { response?: string };
    return data.response?.trim().replace(/^["']|["']$/g, "").slice(0, 60) ?? "";
  } catch {
    return "";
  }
}

export async function quickCompleteOllama(prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama3.2:3b",
      prompt,
      stream: false,
      options: { num_predict: 60 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama error ${res.status}`);
  const data = (await res.json()) as { response?: string };
  return data.response?.trim() ?? "";
}
