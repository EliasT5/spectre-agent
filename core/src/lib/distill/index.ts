import type { ChatMessage } from "@/lib/ai";
import { addMemory } from "@/lib/ai/memory";

const OLLAMA_URL = process.env.OLLAMA_HOST ?? process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_DISTILL_MODEL ?? process.env.OLLAMA_LEARN_MODEL ?? "gemma3";

export interface DistilledEntry {
  category: "fact" | "preference" | "decision" | "incident" | "task" | "reference";
  content: string;
  importance: number; // 1-10
}

const DISTILL_SYSTEM = `\
You are a memory distiller for Jerome, the user's personal AI assistant.
Given a chat transcript, extract the FACTS, PREFERENCES, DECISIONS,
INCIDENTS, TASKS, or REFERENCES worth keeping in long-term memory. Output
JSON only - an array of entries. No prose, no markdown fences.

Schema: an array of objects with keys:
- category: one of "fact" | "preference" | "decision" | "incident" | "task" | "reference"
- content: 1-3 sentences capturing the meaningful information
- importance: integer 1-10 (1 = trivial, 10 = critical)

Skip filler. If the transcript has nothing worth remembering, return [].

Examples:
- "The user prefers to be addressed formally in voice replies" -> preference, 6
- "The user decided to migrate the project's database to Postgres" -> decision, 7
- "The user's working hours are 9 to 5 on weekdays" -> fact, 8

Return raw JSON. No \`\`\` fences. No commentary.`;

export async function distillThread(
  messages: ChatMessage[],
): Promise<DistilledEntry[]> {
  if (messages.length === 0) return [];
  const transcript = messages
    .map((m) => `[${m.role}] ${m.content}`)
    .join("\n\n");

  const body = {
    model: OLLAMA_MODEL,
    stream: false,
    messages: [
      { role: "system", content: DISTILL_SYSTEM },
      { role: "user", content: transcript },
    ],
    options: { num_predict: 500, temperature: 0.3 },
    keep_alive: "1h",
  };

  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw new Error(`distill: ollama ${r.status}`);
  const data = (await r.json()) as { message?: { content?: string } };
  const raw = data.message?.content ?? "[]";

  // Models occasionally wrap in markdown fences despite instructions.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((e): e is DistilledEntry => {
    if (!e || typeof e !== "object") return false;
    const x = e as Record<string, unknown>;
    return (
      typeof x.content === "string" &&
      typeof x.category === "string" &&
      typeof x.importance === "number"
    );
  });
}

export async function persistDistilled(
  entries: DistilledEntry[],
  sourceThreadId: string,
): Promise<number> {
  // Write straight through the shared memory store (embeds on write). The old
  // path POSTed to a hardcoded http://127.0.0.1:3000/api/memory with no token —
  // dead against the gated core. addMemory is the one true write path now.
  let count = 0;
  for (const e of entries) {
    try {
      await addMemory({
        content: `[from thread ${sourceThreadId}] ${e.content}`,
        category: e.category,
        importance: e.importance,
      });
      count++;
    } catch {
      // skip failed individual entries
    }
  }
  return count;
}
