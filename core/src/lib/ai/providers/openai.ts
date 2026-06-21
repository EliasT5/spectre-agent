import OpenAI from "openai";
import type { StreamChunk, StreamOptions } from "./types";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) client = new OpenAI();
  return client;
}

export async function* streamOpenAI(opts: StreamOptions): AsyncGenerator<StreamChunk> {
  // o-series reasoning models accept `reasoning_effort` (low|medium|high)
  // and reject `max_tokens` in favor of `max_completion_tokens`.
  const isReasoning = /^o[0-9]/.test(opts.model.id);
  const effort = opts.reasoningEffort;
  const allowedEffort = effort === "low" || effort === "medium" || effort === "high" ? effort : undefined;

  const stream = await getClient().chat.completions.create({
    model: opts.model.id,
    ...(isReasoning
      ? { max_completion_tokens: opts.maxTokens ?? opts.model.maxOutputTokens }
      : { max_tokens: opts.maxTokens ?? opts.model.maxOutputTokens }),
    ...(isReasoning && allowedEffort ? { reasoning_effort: allowedEffort } : {}),
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: "system", content: opts.system },
      ...opts.messages.filter((m) => m.role !== "system"),
    ],
  });

  let model = "";
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield { type: "token", text: delta };
    if (chunk.model) model = chunk.model;
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? 0;
      outputTokens = chunk.usage.completion_tokens ?? 0;
    }
  }

  yield { type: "done", model, inputTokens, outputTokens };
}

export async function quickCompleteOpenAI(prompt: string): Promise<string> {
  const res = await getClient().chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 60,
    messages: [{ role: "user", content: prompt }],
  });
  return res.choices[0]?.message?.content?.trim() ?? "";
}
