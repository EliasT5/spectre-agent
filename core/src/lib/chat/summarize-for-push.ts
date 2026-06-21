/**
 * Build a tight 1-2 sentence summary of Jerome's reply for use as the
 * push-notification body. Routes through the local Ollama daemon at
 * llama3.2:1b — small enough (~1.3 GB) that the call completes in a
 * second or two on the Mini-PC, and OS push toasts have no business
 * dumping a wall of markdown anyway.
 *
 * Falls back to the truncated original on any failure (Ollama down,
 * model not pulled, network blip, timeout) so a slow summarizer never
 * blocks the notification entirely.
 */

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const SUMMARIZE_MODEL = process.env.PUSH_SUMMARIZE_MODEL || "llama3.2:1b";

const SYSTEM_PROMPT =
  "You write phone push-notification bodies. Given an assistant reply, " +
  "respond with a 1-2 sentence summary of what the assistant did or said. " +
  "Plain text only — no markdown, no emojis, no quotes around the summary. " +
  "Keep it under 140 characters. Output the summary and nothing else.";

const MAX_BODY_LEN = 240;
const TIMEOUT_MS = 8000;

export async function summarizeForPush(reply: string): Promise<string> {
  const trimmed = reply.trim();
  if (!trimmed) return "Response ready.";
  // Already short and single-paragraph — no point spinning up the LLM.
  if (trimmed.length <= 140 && !trimmed.includes("\n\n")) {
    return trimmed;
  }

  try {
    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: SUMMARIZE_MODEL,
        system: SYSTEM_PROMPT,
        // Truncate input so a 1B model isn't asked to summarize a wall.
        prompt: trimmed.slice(0, 4000),
        stream: false,
        options: { num_predict: 80, temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = (await res.json()) as { response?: string };
    const summary = (data.response ?? "").trim().replace(/^"+|"+$/g, "");
    if (!summary) throw new Error("empty summary");
    return summary.slice(0, MAX_BODY_LEN);
  } catch {
    // Don't lose the notification just because Ollama hiccuped — show
    // the truncated original as a graceful fallback.
    return trimmed.slice(0, MAX_BODY_LEN);
  }
}
