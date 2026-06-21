/**
 * Pluggable text embeddings.
 *
 * Default = LOCAL Ollama (private, zero per-call cost, ships inside the
 * self-hostable core). Optional = OpenAI when EMBED_PROVIDER=openai (or an
 * OPENAI_API_KEY is present and EMBED_PROVIDER is unset-but-forced). The rest
 * of the app only imports embedOne/embedBatch/EMBED_DIM, so the backend is a
 * config choice, not a code change at the call sites.
 *
 * NOTE: EMBED_DIM must match the `vector(N)` column the embeddings are stored
 * in. nomic-embed-text = 768; OpenAI text-embedding-3-small = 1536. If you
 * switch providers you must also migrate the column dimension + index.
 */

type Provider = "ollama" | "openai";

const PROVIDER: Provider =
  (process.env.EMBED_PROVIDER as Provider) ||
  (process.env.OPENAI_API_KEY ? "openai" : "ollama");

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
const OPENAI_EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";

export const EMBED_MODEL = PROVIDER === "openai" ? OPENAI_EMBED_MODEL : OLLAMA_EMBED_MODEL;
export const EMBED_DIM =
  Number(process.env.EMBED_DIM) || (PROVIDER === "openai" ? 1536 : 768);

// ── Ollama ─────────────────────────────────────────────────────────
async function embedOllama(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
  });
  if (!res.ok) {
    throw new Error(`ollama embed ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const data = (await res.json()) as { embedding?: number[] };
  if (!data.embedding?.length) throw new Error("ollama embed: empty embedding");
  return data.embedding;
}

// ── OpenAI (optional) ──────────────────────────────────────────────
let openaiClient: import("openai").default | null = null;
async function embedOpenAI(texts: string[]): Promise<number[][]> {
  if (!openaiClient) {
    const OpenAI = (await import("openai")).default;
    openaiClient = new OpenAI();
  }
  const res = await openaiClient.embeddings.create({
    model: OPENAI_EMBED_MODEL,
    input: texts,
  });
  return res.data.map((r) => r.embedding);
}

// ── Public API ─────────────────────────────────────────────────────
export async function embedOne(text: string): Promise<number[]> {
  if (PROVIDER === "openai") return (await embedOpenAI([text]))[0] ?? [];
  return embedOllama(text);
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (PROVIDER === "openai") {
    const out: number[][] = [];
    const BATCH = 100;
    for (let i = 0; i < texts.length; i += BATCH) {
      out.push(...(await embedOpenAI(texts.slice(i, i + BATCH))));
    }
    return out;
  }
  // Ollama has no batch endpoint; run with bounded concurrency.
  const out: number[][] = Array.from({ length: texts.length });
  const CONCURRENCY = 4;
  let idx = 0;
  async function worker() {
    while (idx < texts.length) {
      const i = idx++;
      out[i] = await embedOllama(texts[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length) }, worker));
  return out;
}
