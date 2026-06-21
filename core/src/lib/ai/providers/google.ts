import { GoogleGenAI } from "@google/genai";
import type { StreamChunk, StreamOptions } from "./types";

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GOOGLE_GENAI_API_KEY! });
  return client;
}

export async function* streamGoogle(opts: StreamOptions): AsyncGenerator<StreamChunk> {
  const contents = opts.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const response = await getClient().models.generateContentStream({
    model: opts.model.id,
    config: {
      systemInstruction: opts.system,
      maxOutputTokens: opts.maxTokens ?? opts.model.maxOutputTokens,
    },
    contents,
  });

  let totalTokens = 0;

  for await (const chunk of response) {
    const text = chunk.text;
    if (text) yield { type: "token", text };
    if (chunk.usageMetadata) {
      totalTokens =
        (chunk.usageMetadata.promptTokenCount ?? 0) +
        (chunk.usageMetadata.candidatesTokenCount ?? 0);
    }
  }

  yield {
    type: "done",
    model: opts.model.id,
    inputTokens: 0,
    outputTokens: totalTokens,
  };
}

export async function quickCompleteGoogle(prompt: string): Promise<string> {
  const res = await getClient().models.generateContent({
    model: "gemini-2.0-flash",
    contents: prompt,
  });
  return res.text?.trim() ?? "";
}
