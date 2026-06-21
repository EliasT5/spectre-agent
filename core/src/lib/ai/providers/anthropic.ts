import Anthropic from "@anthropic-ai/sdk";
import type { StreamChunk, StreamOptions } from "./types";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export async function* streamAnthropic(opts: StreamOptions): AsyncGenerator<StreamChunk> {
  const stream = getClient().messages.stream({
    model: opts.model.id,
    max_tokens: opts.maxTokens ?? opts.model.maxOutputTokens,
    system: opts.system,
    messages: opts.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  });

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield { type: "token", text: event.delta.text };
    }
  }

  const final = await stream.finalMessage();
  yield {
    type: "done",
    model: final.model,
    inputTokens: final.usage.input_tokens,
    outputTokens: final.usage.output_tokens,
  };
}

export async function quickCompleteAnthropic(prompt: string): Promise<string> {
  const res = await getClient().messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 60,
    messages: [{ role: "user", content: prompt }],
  });
  const block = res.content[0];
  return block.type === "text" ? block.text.trim() : "";
}
