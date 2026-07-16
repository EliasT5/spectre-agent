import { Hono } from "hono";
import { getGithubToken } from "@/lib/github-token";
import { reportEvent } from "@/lib/monitor/report";

/**
 * Update DETECTOR (notify, never auto-apply). The running image carries the git
 * SHA it was built from (SPECTRE_BUILD_SHA, baked in by scripts/spectre-update.mjs
 * → core/Dockerfile ARG). This route compares it against the latest commit on
 * origin/main via the GitHub API — the repo is PRIVATE, so the call authenticates
 * with the runtime GitHub token from Settings (lib/github-token). Applying an
 * update stays a HOST action: scripts/spectre-update.sh --apply (a container
 * can't rebuild and recreate itself).
 *
 * GET /api/update/status → { runningSha, latestSha, behind, updateAvailable, checkedAt }
 *
 * A guarded 6-hourly background check (startUpdateCheckLoop, called from
 * main.ts) logs an info monitor event when a NEW latest SHA shows up — de-duped
 * so it reports once per remote commit, not once per interval. Fail-soft
 * throughout: no token / API down / no SHA baked → "no update", never an error.
 */

const REPO = "EliasT5/spectre-agent";
const BRANCH = "main";

interface UpdateStatus {
  /** SHA the running core image was built from ("" in the image → null = unknown). */
  runningSha: string | null;
  /** Latest commit SHA on origin/main (null when GitHub is unreachable/unauthed). */
  latestSha: string | null;
  /** True when both SHAs are known and differ. Null when either side is unknown. */
  behind: boolean | null;
  updateAvailable: boolean;
  checkedAt: string;
  note?: string;
}

/** Latest commit SHA on main, via the GitHub API (token required — private repo). */
async function fetchLatestSha(token: string): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "spectre-core",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const body = (await res.json()) as { sha?: string };
  return typeof body.sha === "string" && body.sha.length > 0 ? body.sha : null;
}

/** SHAs may be baked short — treat prefix matches as equal. */
function sameCommit(a: string, b: string): boolean {
  const min = Math.min(a.length, b.length);
  return min >= 7 && a.slice(0, min) === b.slice(0, min);
}

export async function checkUpdateStatus(): Promise<UpdateStatus> {
  const checkedAt = new Date().toISOString();
  const runningSha = process.env.SPECTRE_BUILD_SHA?.trim() || null;

  const token = getGithubToken();
  if (!token) {
    return {
      runningSha,
      latestSha: null,
      behind: null,
      updateAvailable: false,
      checkedAt,
      note: "No GitHub token configured (Settings) — cannot check the private repo.",
    };
  }

  let latestSha: string | null = null;
  try {
    latestSha = await fetchLatestSha(token);
  } catch (err) {
    return {
      runningSha,
      latestSha: null,
      behind: null,
      updateAvailable: false,
      checkedAt,
      note: `GitHub check failed: ${err instanceof Error ? err.message : err}`,
    };
  }

  if (!latestSha) {
    return { runningSha, latestSha: null, behind: null, updateAvailable: false, checkedAt, note: "GitHub returned no commit SHA." };
  }
  if (!runningSha) {
    return {
      runningSha,
      latestSha,
      behind: null,
      updateAvailable: false,
      checkedAt,
      note: "Running SHA unknown (image built without SPECTRE_BUILD_SHA) — rebuild via scripts/spectre-update.sh to enable detection.",
    };
  }

  const behind = !sameCommit(runningSha, latestSha);
  return { runningSha, latestSha, behind, updateAvailable: behind, checkedAt };
}

export const update = new Hono();

update.get("/status", async (c) => c.json(await checkUpdateStatus()));

// ── Background check: every 6h, report (once per new remote SHA) when an
//    update is available. Started from main.ts; guarded + fail-soft.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000; // let the token hydrate from app_config first
let loopStarted = false;
let lastReportedSha: string | null = null;

async function backgroundCheck(): Promise<void> {
  try {
    const status = await checkUpdateStatus();
    if (!status.updateAvailable || !status.latestSha) return;
    if (lastReportedSha && sameCommit(lastReportedSha, status.latestSha)) return; // already reported this commit
    lastReportedSha = status.latestSha;
    await reportEvent({
      severity: "info",
      component: "update",
      description:
        `Spectre update available (${status.runningSha?.slice(0, 12)} → ${status.latestSha.slice(0, 12)}) — ` +
        `run scripts/spectre-update.sh --apply on the host.`,
      push: false,
    });
  } catch {
    /* fail-soft: a broken update check must never hurt the core */
  }
}

/** Idempotent — safe to call more than once; only the first call arms the timers. */
export function startUpdateCheckLoop(): void {
  if (loopStarted) return;
  loopStarted = true;
  setTimeout(() => void backgroundCheck(), FIRST_CHECK_DELAY_MS);
  setInterval(() => void backgroundCheck(), CHECK_INTERVAL_MS);
}
