// The conversational layer of the installer. A LOCAL Ollama model narrates each
// step in plain language and answers the user's questions — while the wizard
// script does every real action. The model is PURELY advisory: it never runs a
// command, it just explains what the installer is about to do and reassures /
// troubleshoots. If Ollama (or a chat model) isn't there, it goes silent and the
// script's own static prompts carry the flow — so guidance is a bonus, never a
// dependency.

const OLLAMA = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");

/** Installed model names, or null if the Ollama daemon isn't reachable. */
export async function ollamaModels(timeout = 4000) {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return null;
    const j = await r.json();
    return (j.models || []).map((m) => m.name);
  } catch {
    return null;
  }
}

/**
 * One-token chat ping straight at the local Ollama daemon to confirm a model
 * actually answers. Used by the installer's brain-model test: the LiteLLM gateway
 * isn't up yet during setup (it starts in the launch phase and only proxies to
 * this same daemon), so testing the backing model here validates the same path.
 * A generous timeout because a cold model has to load into memory first.
 * Returns { ok, detail }; never throws.
 */
export async function testOllamaChat(model, timeout = 60000) {
  try {
    const r = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with just the word: ok" }],
        stream: false,
        options: { num_predict: 5 },
      }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) return { ok: false, detail: `Ollama returned HTTP ${r.status}` };
    const j = await r.json();
    const text = (j?.message?.content ?? "").trim();
    return text
      ? { ok: true, detail: text.slice(0, 40) }
      : { ok: false, detail: "the model returned an empty reply" };
  } catch (e) {
    return {
      ok: false,
      detail: e?.name === "TimeoutError"
        ? "timed out (the model may still be loading -- try chat once the stack is up)"
        : (e?.message || String(e)),
    };
  }
}

/** Pick a chat model from what's installed (prefer the user's stack; skip embed-only). */
export function pickGuideModel(models) {
  if (!models?.length) return null;
  const want = process.env.SPECTRE_GUIDE_MODEL;
  const has = (p) => models.find((m) => m === p || m.startsWith(p + ":") || m.includes(p));
  if (want && has(want)) return has(want);
  for (const p of ["gemma3", "llama3.2", "llama3.1", "qwen2.5", "mistral", "phi3", "llama3"]) {
    const hit = has(p);
    if (hit) return hit;
  }
  return models.find((m) => !/embed/i.test(m)) || null;
}

export const SYSTEM = `You are the Spectre install guide — a warm, concise sysadmin sitting beside the user while a terminal wizard installs Spectre, a self-hosted AI assistant. Spectre is "open-core": a public shell (the UI) plus a private Docker "core" (the brain) that runs on the user's OWN machine using their OWN models — local Ollama with zero API keys, or any OpenAI-compatible provider via the gateway — so nothing is hosted by anyone else.

Hard rules:
- You ONLY explain, reassure, and answer questions. You NEVER run commands, never claim to have done anything — "the installer" performs every action. You are the friendly narration on top of it.
- Keep replies to 1-3 short sentences unless the user explicitly asks for more. Plain conversational language. No markdown headings, no bullet dumps, no code fences unless quoting one short command.
- Given a STEP, tell the user in simple terms what's about to happen and what they need to do or paste.
- Given DETECTION results, interpret them: what's ready, what's missing, and the single next action.
- Given a QUESTION, answer it for THIS install specifically, then gently point them back to the prompt.
- Be encouraging and a little dry-witted, never patronising. Address the user directly ("you").`;

export class Guide {
  constructor(model) {
    this.model = model;
    this.history = [{ role: "system", content: SYSTEM }];
  }

  async _stream(userContent) {
    this.history.push({ role: "user", content: userContent });
    let acc = "";
    try {
      const r = await fetch(`${OLLAMA}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: this.history,
          stream: true,
          options: { temperature: 0.4, num_predict: 220 },
        }),
        signal: AbortSignal.timeout(90000),
      });
      if (!r.ok || !r.body) throw new Error(`ollama ${r.status}`);
      process.stdout.write("   \x1b[38;5;99m◈\x1b[0m  \x1b[2m"); // ◈ accent + dim body
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const t = JSON.parse(line).message?.content || "";
            if (t) {
              process.stdout.write(t.replace(/\n/g, "\n      "));
              acc += t;
            }
          } catch {
            /* partial JSON line — wait for more */
          }
        }
      }
      process.stdout.write("\x1b[0m\n");
    } catch {
      // model hiccup — stay quiet; the script's static text already covers it.
      this.history.pop();
      return null;
    }
    this.history.push({ role: "assistant", content: acc });
    return acc;
  }

  narrate(step) {
    return this._stream(`STEP: ${step}`);
  }
  detected(summary) {
    return this._stream(`DETECTION of the user's machine:\n${summary}\n\nGreet the user in one line, then say in one line whether they look ready or what's missing.`);
  }
  answer(question) {
    return this._stream(`USER QUESTION: ${question}`);
  }
}
