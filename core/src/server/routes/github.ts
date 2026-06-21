import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServiceSupabase } from "@/lib/supabase/server";

/**
 * POST /api/github/webhook
 *
 * Public-facing endpoint (see proxy.ts PUBLIC_PATHS). Called by GitHub
 * when events fire on subscribed repos. Signature-verified via HMAC-SHA256
 * with GITHUB_WEBHOOK_SECRET.
 *
 * Handled events:
 *   - issue_comment  (action=created)  -> if body mentions @jerome,
 *                                        insert a `[proposal]` workshop_task
 *                                        carrying the comment verbatim.
 *   - pull_request   (action=opened)   -> insert a `[proposal]` pointing
 *                                        the user at the PR for triage.
 *   - push           (any branch)      -> accept + log; no side-effect.
 *                                        Intentionally quiet - a full
 *                                        "Haiku summarises the diff" pass
 *                                        is cheap to add later but would
 *                                        spam the inbox for now.
 *
 * Unknown events return 200 so GitHub doesn't keep retrying - we are
 * permissive on purpose, the security boundary is the signature check.
 *
 * To actually receive traffic the box has to be reachable from the
 * public internet (e.g. behind any HTTPS reverse proxy / tunnel).
 * Then set the webhook URL in GitHub to:
 *    https://<your-host>/api/github/webhook
 * Secret: the value of GITHUB_WEBHOOK_SECRET in your .env.docker.
 */

const PROPOSAL_PREFIX = "[proposal]";

function verifySignature(rawBody: string, signatureHeader: string | undefined): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return false;
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

interface IssueCommentPayload {
  action?: string;
  comment?: { body?: string; html_url?: string; user?: { login?: string } };
  issue?: { number?: number; title?: string; html_url?: string };
  repository?: { full_name?: string };
}

interface PullRequestPayload {
  action?: string;
  pull_request?: {
    number?: number;
    title?: string;
    body?: string;
    html_url?: string;
    user?: { login?: string };
  };
  repository?: { full_name?: string };
}

async function insertProposal(title: string, description: string): Promise<void> {
  const supabase = createServiceSupabase();
  await supabase.from("workshop_tasks").insert({
    title: `${PROPOSAL_PREFIX} ${title}`.slice(0, 300),
    description: description.slice(0, 4000),
    status: "pending",
  });
}

export const github = new Hono();

github.post("/webhook", async (c) => {
  const raw = await c.req.text();

  if (!verifySignature(raw, c.req.header("x-hub-signature-256"))) {
    return c.json({ error: "invalid signature" }, 401);
  }

  const event = c.req.header("x-github-event") ?? "";
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  // Always accept a ping during webhook setup so GitHub's "test" button works.
  if (event === "ping") {
    return c.json({ ok: true, ping: "pong" });
  }

  if (event === "issue_comment") {
    const p = payload as IssueCommentPayload;
    if (p.action !== "created") return c.json({ ok: true, skipped: "not-created" });
    const body = p.comment?.body ?? "";
    if (!/@jerome\b/i.test(body)) return c.json({ ok: true, skipped: "no-mention" });

    const who = p.comment?.user?.login ?? "unknown";
    const issueRef = `#${p.issue?.number ?? "?"} ${p.issue?.title ?? ""}`.trim();
    const repo = p.repository?.full_name ?? "unknown/unknown";
    const excerpt = body.replace(/@jerome\s*/i, "").trim().slice(0, 600);

    await insertProposal(
      `@jerome in ${repo} ${issueRef}`,
      `From @${who} on ${issueRef} (${repo}):\n\n${excerpt}\n\n→ ${p.comment?.html_url ?? p.issue?.html_url ?? ""}`,
    );
    return c.json({ ok: true, routed: "issue_comment→proposal" });
  }

  if (event === "pull_request") {
    const p = payload as PullRequestPayload;
    if (p.action !== "opened") return c.json({ ok: true, skipped: `pr-${p.action}` });
    const pr = p.pull_request;
    const who = pr?.user?.login ?? "unknown";
    const num = pr?.number ?? 0;
    const title = pr?.title ?? "(no title)";
    const body = pr?.body?.trim() ?? "(no body)";
    const repo = p.repository?.full_name ?? "unknown/unknown";

    await insertProposal(
      `Review PR #${num} in ${repo}: ${title}`,
      `Opened by @${who} in ${repo}:\n\n${body.slice(0, 600)}\n\n→ ${pr?.html_url ?? ""}`,
    );
    return c.json({ ok: true, routed: "pull_request→proposal" });
  }

  if (event === "push") {
    // Accept silently - we don't want one proposal per commit. Extend
    // later with a diff-summary pass if the inbox feels too quiet.
    return c.json({ ok: true, skipped: "push-silent" });
  }

  return c.json({ ok: true, skipped: `unhandled:${event}` });
});

github.get("/webhook", (c) =>
  c.json({
    endpoint: "/api/github/webhook",
    events: ["issue_comment", "pull_request", "push", "ping"],
    setup:
      "Set GITHUB_WEBHOOK_SECRET in your .env.docker and register " +
      "https://<your-host>/api/github/webhook with the same secret in GitHub. " +
      "Expose the box via any HTTPS reverse proxy / tunnel.",
  }),
);
