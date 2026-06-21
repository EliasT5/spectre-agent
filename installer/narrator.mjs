// Installer narrator — the conversational guide layer, backend-agnostic.
//
// The narrator is PURELY advisory and LOCAL/personal: it explains each step and
// answers questions while the wizard does every real action. It can run on EITHER
// an installed CLI you already have (Claude / Gemini / Codex) OR a local Ollama
// model — whichever you pick. NOTE: using a subscription CLI here is your own
// personal, one-off install assistance on your own machine; it does NOT make
// Spectre's SHIPPED brain use a subscription (that stays provider-agnostic and is
// off-by-default). If nothing is available the installer just runs silently
// on its own static prompts — guidance is a bonus, never a dependency.
import { spawn, spawnSync } from "node:child_process";
import { Guide, ollamaModels, pickGuideModel, SYSTEM } from "./guide.mjs";

const C = { dim: (s) => `\x1b[2m${s}\x1b[0m`, accent: (s) => `\x1b[38;5;99m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };

// One-shot invocation per CLI. The whole (small) context is passed each turn.
// The prompt is delivered on STDIN (not argv) for every CLI: on Windows the CLIs
// are .cmd/.ps1 shims that need a shell to launch, and passing a multi-line
// prompt as a shell arg is a cmd.exe quoting minefield — stdin sidesteps it
// entirely and works identically on POSIX. (All three support headless stdin.)
const CLIS = [
  { id: "claude", bin: "claude", label: "Claude Code CLI", argv: () => ["--print"], stdin: (p) => p },
  { id: "gemini", bin: "gemini", label: "Gemini CLI", argv: () => ["--skip-trust", "-o", "text"], stdin: (p) => p },
  { id: "codex", bin: "codex", label: "Codex CLI", argv: () => ["exec", "--skip-git-repo-check", "-"], stdin: (p) => p },
];

// Pass a single command STRING (not an args array) with shell:true so PATH
// resolution finds .cmd/.ps1/.exe shims on Windows — a bare spawn(bin) ENOENTs on
// npm-installed CLIs there. A command string (vs args+shell) also avoids Node's
// DEP0190 warning; safe here because every arg is a static flag (the prompt goes
// in via STDIN, never the command line).
function cliInstalled(bin) {
  try {
    return spawnSync(`${bin} --version`, { stdio: "ignore", timeout: 8000, shell: true }).status === 0;
  } catch {
    return false;
  }
}

/** Everything that COULD narrate, right now: installed CLIs + local Ollama chat models. */
export async function detectNarrators() {
  const out = [];
  for (const c of CLIS) if (cliInstalled(c.bin)) out.push({ kind: "cli", id: c.id, label: `${c.label} (installed CLI)`, cli: c });
  const models = (await ollamaModels()) ?? [];
  for (const m of models.filter((m) => !/embed/i.test(m))) out.push({ kind: "ollama", id: m, label: `${m} (Ollama)`, model: m });
  return out;
}

function printNarr(text) {
  process.stdout.write(`   ${C.accent("◈")}  ${C.dim(text.replace(/\n/g, "\n      "))}\n`);
}

// CLI-backed narrator: stateless one-shot per turn, with a compact rolling context.
class CliNarrator {
  constructor(cli) {
    this.cli = cli;
    this.history = [];
  }
  async _run(turn) {
    const prompt = [SYSTEM, ...this.history.slice(-6), turn].join("\n\n");
    const text = await new Promise((res) => {
      let o = "";
      // Static flags only (prompt via stdin) → safe as a shell command string.
      const p = spawn(`${this.cli.bin} ${this.cli.argv().join(" ")}`, { stdio: ["pipe", "pipe", "ignore"], shell: true });
      p.stdout.on("data", (d) => (o += d.toString()));
      p.on("close", () => res(o.trim()));
      p.on("error", () => res(""));
      const s = this.cli.stdin?.(prompt);
      if (s) p.stdin.end(s); else p.stdin.end();
    });
    if (text) {
      this.history.push(turn, text);
      printNarr(text);
    }
    return text || null;
  }
  narrate(step) { return this._run(`STEP: ${step}`); }
  detected(summary) { return this._run(`DETECTION of the user's machine:\n${summary}\n\nGreet the user in one line, then say in one line whether they look ready or what's missing.`); }
  answer(q) { return this._run(`USER QUESTION: ${q}`); }
}

/** Build a narrator from a detected choice (ollama -> Guide, cli -> CliNarrator). */
export function makeNarrator(choice) {
  if (!choice) return null;
  return choice.kind === "cli" ? new CliNarrator(choice.cli) : new Guide(choice.model);
}

/**
 * Interactive narrator picker. Lists installed CLIs + Ollama models; lets the user
 * pick one, optionally PULL an Ollama model, or skip. Returns a Narrator | null.
 * `ask(question, default)` is the installer's prompt fn; `rl` its readline.
 */
export async function chooseNarrator(rl, ask) {
  const opts = await detectNarrators();

  if (!opts.length) {
    if (!cliInstalled("ollama")) return null; // no CLI, no daemon — nothing can narrate
    const pull = (await ask("Pull a small Ollama model to guide you? (gemma3, ~3GB) [y/N]", "N")).toLowerCase();
    if (pull === "y" || pull === "yes") {
      try {
        spawnSync("ollama pull gemma3", { stdio: "inherit", shell: true });
        const m = ((await ollamaModels()) ?? []).filter((x) => !/embed/i.test(x));
        if (m.length) return makeNarrator({ kind: "ollama", model: pickGuideModel(m) });
      } catch {
        /* pull failed */
      }
    }
    return null;
  }

  const pick = (await ask(`Guide [1-${opts.length + 1}, 0 to skip]`, "1")).trim();

  if (pick === "0") return null;
  if (pick === String(opts.length + 1)) {
    if (!cliInstalled("ollama")) {
      console.error(C.dim("   Ollama isn't installed (https://ollama.com/download) — skipping guide."));
      return null;
    }
    const name = (await ask("Ollama model to pull", "gemma3")).trim() || "gemma3";
    // Validate before interpolating into a shell command (injection guard).
    if (!/^[a-zA-Z0-9._:/-]+$/.test(name)) {
      console.error(C.dim("   invalid model name — skipping guide."));
      return null;
    }
    try {
      spawnSync(`ollama pull ${name}`, { stdio: "inherit", shell: true });
      return makeNarrator({ kind: "ollama", model: name });
    } catch {
      return null;
    }
  }
  const idx = Number(pick) - 1;
  const choice = Number.isInteger(idx) && opts[idx] ? opts[idx] : opts[0];
  return makeNarrator(choice);
}
