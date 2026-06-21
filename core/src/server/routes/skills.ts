import { Hono } from "hono";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { builtinDir, userDir, loadSkillDocs } from "@/lib/ext/dirs";
import { createServiceSupabase } from "@/lib/supabase/server";
import { quickCompleteLiteLLM } from "@/lib/ai/providers/litellm";
import { reportEvent } from "@/lib/monitor/report";
import { frontmatterField } from "@/lib/ai/soul";

/**
 * Skills API — the harness's user-extensible skill surface.
 *
 * Skills are SKILL.md docs injected into the brain's system prompt (see
 * lib/ai/soul). Built-in skills ship baked + read-only; user skills live in the
 * persistent data dir and OVERRIDE built-ins by name. Writes + deletes target
 * the USER dir only — the baked built-ins are never mutated, so a deploy/re-pull
 * can't be corrupted and user additions persist across restarts.
 */
export const skills = new Hono();

/** GET /api/skills — list built-in + user skills (user overrides built-in). */
skills.get("/", (c) => {
  return c.json(loadSkillDocs()); // [{ name, content, source: "builtin" | "user" }]
});

/** POST /api/skills — create or update a USER skill (persisted in the data dir). */
skills.post("/", async (c) => {
  const { name, content } = await c.req.json();
  if (!name || typeof content !== "string") {
    return c.json({ error: "name and content required" }, 400);
  }
  const safeName = String(name).replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  if (!safeName) return c.json({ error: "invalid name" }, 400);

  const dir = join(userDir("skills"), safeName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content, "utf-8");

  const overridesBuiltin = existsSync(join(builtinDir("skills"), safeName));
  return c.json({ ok: true, name: safeName, source: "user", overridesBuiltin });
});

/**
 * DELETE /api/skills/:name — remove a USER skill. Built-in skills cannot be
 * deleted (they're read-only); deleting a user skill that shadowed a built-in
 * simply re-reveals the built-in.
 */
skills.delete("/:name", (c) => {
  const safeName = c.req.param("name").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  if (!safeName) return c.json({ error: "invalid name" }, 400);

  const dir = join(userDir("skills"), safeName);
  if (!existsSync(dir)) {
    const isBuiltin = existsSync(join(builtinDir("skills"), safeName));
    return c.json(
      { error: isBuiltin ? "built-in skills cannot be deleted" : "skill not found" },
      isBuiltin ? 403 : 404,
    );
  }
  rmSync(dir, { recursive: true, force: true });
  return c.json({ ok: true });
});

/**
 * POST /api/skills/curate — the 'skill_curation' scheduled job (weekly).
 * Reviews 14-day skill.read usage + redundancy across the loaded skill docs
 * and PROPOSES keep/merge/prune. Proposal-only by design — the SkillOpt human
 * gate applies: this never writes or deletes a skill. The proposal lands in
 * scheduled_job_runs.output and a monitor event (push).
 */
skills.post("/curate", async (c) => {
  const docs = loadSkillDocs();
  const supabase = createServiceSupabase();
  const since = new Date(Date.now() - 14 * 24 * 3_600_000).toISOString();
  const { data: usage, error } = await supabase
    .from("skill_usage")
    .select("skill")
    .gte("created_at", since);
  if (error) {
    return c.json(
      { error: error.message, hint: "skill_usage table missing? Apply supabase/skill-usage.sql." },
      500,
    );
  }
  const counts: Record<string, number> = {};
  for (const d of docs) counts[d.name] = 0;
  for (const row of usage ?? []) {
    const k = String(row.skill);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const indexLines = docs
    .map(
      (d) =>
        `- ${d.name} (${counts[d.name]} on-demand loads in 14d): ${frontmatterField(d.content, "description") || "(no description)"}`,
    )
    .join("\n");
  let proposal = "";
  try {
    proposal = await quickCompleteLiteLLM(
      `You curate an AI agent's skill library. For each skill below, output one line: ` +
        `KEEP, MERGE with <other>, or PRUNE-CANDIDATE — plus a one-line reason. ` +
        `Low usage is a signal, not a verdict (rare skills can still be vital). ` +
        `Flag overlapping descriptions as merge candidates. Max 200 words total.\n\n${indexLines}`,
    );
  } catch (err) {
    proposal = `(curation model unavailable: ${err instanceof Error ? err.message : String(err)})`;
  }
  void reportEvent({
    severity: "info",
    component: "skill-curation",
    description: `Skill curation proposal ready (${docs.length} skills, 14d usage attached).`,
    detail: { counts, proposal },
    push: true,
  });
  return c.json({ skills: docs.length, counts, proposal });
});

/** POST /api/skills/:name/used — skill.read telemetry (fire-and-forget from the broker). */
skills.post("/:name/used", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const threadId =
    typeof (body as { thread_id?: unknown }).thread_id === "string"
      ? (body as { thread_id: string }).thread_id
      : null;
  const supabase = createServiceSupabase();
  const { error } = await supabase.from("skill_usage").insert({ skill: name, thread_id: threadId });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});
