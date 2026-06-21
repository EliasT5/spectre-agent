/**
 * Soul loader — reads Jerome's soul files and skills at runtime
 * to assemble the system prompt dynamically.
 *
 * This is what makes Jerome self-modifiable: edit a soul file,
 * and the next message uses the updated personality/rules.
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { loadSkillDocs, projectRoot as getProjectRoot } from "@/lib/ext/dirs";

// ── Paths ──────────────────────────────────────────────────────

function soulDir(): string {
  return join(getProjectRoot(), "soul");
}

// ── File readers ───────────────────────────────────────────────

function readMd(path: string): string {
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    return "";
  }
}

// ── Soul loading ───────────────────────────────────────────────

export interface SoulContext {
  soul: string;
  identity: string;
  user: string;
  agents: string;
  heartbeat: string;
  files: { name: string; content: string }[];
  skills: { name: string; content: string }[];
}

export function loadSoul(): SoulContext {
  const dir = soulDir();
  const files = loadSoulFiles(dir);
  return {
    soul: readMd(join(dir, "SOUL.md")),
    identity: readMd(join(dir, "IDENTITY.md")),
    user: readMd(join(dir, "USER.md")),
    agents: readMd(join(dir, "AGENTS.md")),
    heartbeat: readMd(join(dir, "HEARTBEAT.md")),
    files,
    skills: loadSkills(),
  };
}

const SOUL_FILE_ORDER = [
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "AGENTS.md",
  "HEARTBEAT.md",
];

function loadSoulFiles(dir: string): { name: string; content: string }[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".md"))
    .map((d) => ({ name: d.name, content: readMd(join(dir, d.name)) }))
    .filter((f) => f.content.length > 0)
    .sort((a, b) => {
      const ai = SOUL_FILE_ORDER.indexOf(a.name);
      const bi = SOUL_FILE_ORDER.indexOf(b.name);
      if (ai !== -1 || bi !== -1) {
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      }
      return a.name.localeCompare(b.name);
    });
}

function loadSkills(): { name: string; content: string }[] {
  return loadSkillDocs().map((s) => ({ name: s.name, content: s.content }));
}

// ── Skill index (progressive loading) ──────────────────────────

/** Pull `key: value` out of a SKILL.md YAML frontmatter block (flat keys only). */
export function frontmatterField(content: string, key: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) return "";
  const line = m[1].split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
  return line ? line.slice(key.length + 1).trim() : "";
}

/** One index line per skill: name + description (+ trigger when present). */
function skillIndexLine(s: { name: string; content: string }): string {
  const desc =
    frontmatterField(s.content, "description") ||
    s.content.replace(/^---[\s\S]*?---/, "").trim().split(/\r?\n/)[0]?.slice(0, 140) ||
    "(no description)";
  const trigger = frontmatterField(s.content, "trigger");
  return trigger
    ? `- **${s.name}** — ${desc} _(when: ${trigger})_`
    : `- **${s.name}** — ${desc}`;
}

// ── System prompt assembly ─────────────────────────────────────

/**
 * Build the full system prompt from soul files.
 * Called on every message — picks up live changes.
 *
 * `overrides.skills` replaces the loadSkills() set under "# Available Skills"
 * with EXACTLY the supplied skills — everything else (soul files, assembly,
 * ordering, separators) is identical. This is the SkillOpt rollout isolation:
 * a rollout injects ONLY the skill under optimization so the reward isn't
 * contaminated by the other five skills' attribution noise. With no argument
 * (or no `skills` key), normal-chat assembly applies (progressive skill index
 * unless SPECTRE_SKILLS_PROGRESSIVE=0).
 */
export function buildSystemPrompt(overrides?: {
  skills?: { name: string; content: string }[];
}): string {
  const ctx = loadSoul();
  const skills = overrides?.skills ?? ctx.skills;

  const sections: string[] = [];

  for (const file of ctx.files) {
    sections.push(`<!-- soul/${file.name} -->\n\n${file.content}`);
  }

  if (skills.length > 0) {
    // SkillOpt rollouts (overrides.skills) ALWAYS get full bodies — the rollout
    // contract is "exactly this skill, fully loaded". Normal chat ships only a
    // one-line-per-skill index and the model loads bodies on demand, keeping
    // the prompt small and stable. SPECTRE_SKILLS_PROGRESSIVE=0 opts out.
    const progressive =
      !overrides?.skills && process.env.SPECTRE_SKILLS_PROGRESSIVE !== "0";
    if (progressive) {
      const index = skills.map(skillIndexLine).join("\n");
      sections.push(
        `# Available Skills (index)\n\n` +
          `Skill bodies are NOT preloaded. Before doing a skill's work, load its ` +
          `full instructions first: call the \`mcp__spectre__skill.read\` tool ` +
          `with { name }, or read skills/<name>/SKILL.md.\n\n${index}`,
      );
    } else {
      const skillList = skills
        .map((s) => `## Skill: ${s.name}\n\n${s.content}`)
        .join("\n\n---\n\n");
      sections.push(`# Available Skills\n\n${skillList}`);
    }
  }

  return sections.join("\n\n---\n\n");
}
