/**
 * cli-text — the Streamer that turns a cli-command backend into a pickable brain.
 *
 * Chat-only: it spawns the user's command once per turn, feeds a serialized
 * transcript, and streams stdout back as tokens. It emits NO tool_use — a raw CLI
 * has no tool protocol (for agentic tool-use, use a cli-server or api backend, or
 * call this backend as a dispatch tool FROM an agentic brain).
 *
 * One generic streamer serves ALL cli-command brains; the specific backend is
 * carried on `opts.model.cliModel` (the backend id), resolved from the sync
 * registry snapshot.
 */
import type { StreamChunk, StreamOptions } from "../providers/types";
import { getBackendSync } from "./registry";
import { runCliCommand } from "./cli-exec";
import { registerAbort } from "../abort";

function buildPrompt(opts: StreamOptions): string {
  const parts: string[] = [];
  if (opts.system) parts.push(opts.system);
  for (const m of opts.messages) {
    const who = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "System";
    parts.push(`${who}: ${m.content}`);
  }
  parts.push("Assistant:");
  return parts.join("\n\n");
}

export async function* streamCliText(opts: StreamOptions): AsyncGenerator<StreamChunk> {
  const backendId = opts.model.cliModel || opts.model.id;
  const spec = getBackendSync(backendId);
  if (!spec || spec.kind !== "cli-command" || !spec.roles?.brain || !spec.enabled) {
    yield { type: "token", text: `[model backend '${backendId}' is not an enabled brain]` };
    yield { type: "done", model: opts.model.id };
    return;
  }

  const prompt = buildPrompt(opts);
  const controller = new AbortController();
  // Provider-agnostic Stop: threads.ts fires abortThread(threadId) which runs this.
  const unregister = opts.threadId ? registerAbort(opts.threadId, () => controller.abort()) : () => {};

  // Bridge the onChunk callback to this async generator via a tiny wake-able queue.
  const queue: string[] = [];
  let finished = false;
  let failure: unknown;
  let notify: (() => void) | null = null;
  const wake = () => {
    if (notify) {
      const n = notify;
      notify = null;
      n();
    }
  };

  const runP = runCliCommand(spec, prompt, {
    signal: controller.signal,
    onChunk: (t) => {
      queue.push(t);
      wake();
    },
  }).then(
    (full) => {
      // json mode never fires onChunk (can't stream partial JSON) — emit at the end.
      if (spec.outputMode === "json" && full) queue.push(full);
      finished = true;
      wake();
    },
    (e) => {
      failure = e;
      finished = true;
      wake();
    },
  );

  try {
    for (;;) {
      while (queue.length) {
        const t = queue.shift();
        if (t) yield { type: "token", text: t };
      }
      if (finished) break;
      await new Promise<void>((res) => {
        notify = res;
      });
    }
    await runP;
    if (failure) {
      const msg = failure instanceof Error ? failure.message : String(failure);
      if (msg !== "aborted") yield { type: "token", text: `\n[error: ${msg}]` };
    }
  } finally {
    unregister();
  }

  yield { type: "done", model: opts.model.id };
}
