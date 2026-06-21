/**
 * SkillOpt — Step 6: the APPROVAL-GATED DEPLOY (jerome-core-local, NO git).
 *
 * This is the FINAL step of the optimizer loop and the ONLY place in the whole
 * system that writes the live `skills/<skill>/SKILL.md` (the pre-existing
 * unconditional POST in src/app/api/skills/route.ts is the manual editor; this
 * is the optimizer's gated path). The optimizer's accept (Step 4 val-gate) only
 * marks a skillopt_runs row deploy_status='pending' and persists the candidate
 * as the gitignored skillopt/envs/<skill>/skill_v<N>.md — it NEVER touches the
 * live doc. Promotion happens here, and ONLY via the explicit human approve
 * action:
 *
 *   approveDeploy(runId) → copy the accepted candidate onto the live SKILL.md.
 *   discardDeploy(runId) → leave the live doc untouched; just mark discarded.
 *
 * The running core rebuilds the system prompt per-turn (buildSystemPrompt in
 * src/lib/ai/soul.ts re-reads skills/ on every message), so an approved deploy
 * takes effect on the next message — no restart.
 *
 * SAFETY INVARIANT: nothing here writes the live doc except approveDeploy(), and
 * approveDeploy() refuses unless (a) the run is in 'pending' state and (b) the
 * candidate file actually exists (never write garbage). The worker (monolith) is
 * deliberately NOT involved — its self-edit guard refuses jerome-core, so this
 * deploy gate is jerome-core-local by design.
 *
 * Paths resolve from process.cwd() (the jerome-core root) — the same convention
 * as skillopt/scripts/train.ts. NEVER SPECTRE_REPO_PATH (that's the monolith).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { createServiceSupabase } from "@/lib/supabase/server";

// ── paths (process.cwd(), never SPECTRE_REPO_PATH) ─────────────────────
function envDir(skill: string): string {
  return join(process.cwd(), "skillopt", "envs", skill);
}
/** The LIVE skill doc — the ONE file approveDeploy() is allowed to write. */
function liveSkillPath(skill: string): string {
  return join(process.cwd(), "skills", skill, "SKILL.md");
}

/**
 * Resolve the accepted candidate doc for a deploy. Prefer the exact versioned
 * champion skill_v<N>.md the round wrote; fall back to best_skill.md (the
 * always-current champion mirror). Returns null if neither exists (the gate
 * then refuses to deploy rather than write garbage).
 */
function loadCandidate(
  skill: string,
  newVersion: string | null,
): { doc: string; source: string } | null {
  if (newVersion) {
    const versioned = join(envDir(skill), `skill_${newVersion}.md`);
    if (existsSync(versioned)) {
      return { doc: readFileSync(versioned, "utf-8"), source: `skill_${newVersion}.md` };
    }
  }
  const best = join(envDir(skill), "best_skill.md");
  if (existsSync(best)) {
    return { doc: readFileSync(best, "utf-8"), source: "best_skill.md" };
  }
  return null;
}

// ── ledger row shape (only the columns the gate reads) ─────────────────
interface DeployRow {
  id: string;
  skill_name: string;
  new_version: string | null;
  val_delta: number | null;
  test_score: number | null;
  deploy_status: string | null;
  created_at: string;
  metadata: { diff?: string } | null;
}

const SELECT_COLS =
  "id, skill_name, new_version, val_delta, test_score, deploy_status, created_at, metadata";

// ── list ───────────────────────────────────────────────────────────────
export interface PendingDeploy {
  runId: string;
  skill: string;
  newVersion: string | null;
  valDelta: number | null;
  testScore: number | null;
  createdAt: string;
  /** The incumbent→candidate line diff captured by the round (for eyeballing). */
  diffPreview: string;
}

/** Every accepted-but-not-yet-decided deploy candidate, newest first. */
export async function listPendingDeploys(): Promise<PendingDeploy[]> {
  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("skillopt_runs")
    .select(SELECT_COLS)
    .eq("deploy_status", "pending")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  return (data as DeployRow[] | null ?? []).map((r) => ({
    runId: r.id,
    skill: r.skill_name,
    newVersion: r.new_version,
    valDelta: r.val_delta,
    testScore: r.test_score,
    createdAt: r.created_at,
    diffPreview: typeof r.metadata?.diff === "string" ? r.metadata.diff : "",
  }));
}

// ── approve (THE ONLY LIVE WRITE) ──────────────────────────────────────
export interface ApproveResult {
  ok: boolean;
  skill: string;
  version: string | null;
  /** Absolute path of the live doc that was written. */
  wrote: string;
}

/**
 * Promote a PENDING deploy to the live skills/<skill>/SKILL.md. This is the
 * ONLY live-doc write in the optimizer loop. Guards:
 *   - the run must exist and be deploy_status='pending' (else no-op error),
 *   - the candidate file must exist (else error — never write garbage).
 * On success: writes the live doc, sets deploy_status='approved', deployed_at=now().
 */
export async function approveDeploy(runId: string): Promise<ApproveResult> {
  const supabase = createServiceSupabase();

  const { data: row, error: lookupErr } = await supabase
    .from("skillopt_runs")
    .select(SELECT_COLS)
    .eq("id", runId)
    .single();
  if (lookupErr || !row) {
    throw new Error(`deploy run not found: ${runId}`);
  }
  const run = row as DeployRow;
  if (run.deploy_status !== "pending") {
    throw new Error(
      `deploy run ${runId} is not pending (deploy_status=${run.deploy_status ?? "null"})`,
    );
  }

  const candidate = loadCandidate(run.skill_name, run.new_version);
  if (!candidate) {
    throw new Error(
      `no candidate doc for ${run.skill_name} ${run.new_version ?? ""} ` +
        `(neither skill_v<N>.md nor best_skill.md present) — refusing to deploy`,
    );
  }

  // THE deploy: copy the accepted candidate onto the live skill doc.
  const live = liveSkillPath(run.skill_name);
  const dir = join(process.cwd(), "skills", run.skill_name);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(live, candidate.doc, "utf-8");

  const { error: updErr } = await supabase
    .from("skillopt_runs")
    .update({ deploy_status: "approved", deployed_at: new Date().toISOString() })
    .eq("id", runId);
  if (updErr) {
    // The live write already happened; surface the DB failure but don't pretend
    // it didn't deploy. The row stays 'pending' so a retry is a safe no-op write.
    throw new Error(`deployed live doc but failed to mark approved: ${updErr.message}`);
  }

  return { ok: true, skill: run.skill_name, version: run.new_version, wrote: live };
}

// ── discard (NO live write) ────────────────────────────────────────────
export interface DiscardResult {
  ok: boolean;
}

/**
 * Reject a PENDING deploy: mark deploy_status='discarded'. Does NOT touch the
 * live doc — the running skill is left exactly as-is.
 */
export async function discardDeploy(runId: string): Promise<DiscardResult> {
  const supabase = createServiceSupabase();

  const { data: row, error: lookupErr } = await supabase
    .from("skillopt_runs")
    .select("id, deploy_status")
    .eq("id", runId)
    .single();
  if (lookupErr || !row) {
    throw new Error(`deploy run not found: ${runId}`);
  }
  if ((row as { deploy_status: string | null }).deploy_status !== "pending") {
    throw new Error(
      `deploy run ${runId} is not pending ` +
        `(deploy_status=${(row as { deploy_status: string | null }).deploy_status ?? "null"})`,
    );
  }

  const { error: updErr } = await supabase
    .from("skillopt_runs")
    .update({ deploy_status: "discarded" })
    .eq("id", runId);
  if (updErr) throw new Error(updErr.message);

  return { ok: true };
}
