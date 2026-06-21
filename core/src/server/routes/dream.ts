import { Hono } from "hono";
import { consolidateMemories } from "@/lib/distill/consolidate";
import { runHealthSweep } from "@/lib/monitor/report";

export const dream = new Hono();

const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

function normalizeHost(value: string | null | undefined): string {
  const host = value?.trim().toLowerCase() ?? "";
  if (host.startsWith("[") && host.includes("]")) return host.slice(1, host.indexOf("]"));
  return host.split(":")[0] ?? "";
}

function isLocal(request: Request): boolean {
  const forwarded = normalizeHost(request.headers.get("x-forwarded-for")?.split(",")[0]);
  if (forwarded) return LOCAL_HOSTS.has(forwarded);
  const host = normalizeHost(request.headers.get("host"));
  return Boolean(host && LOCAL_HOSTS.has(host));
}

dream.post("/consolidate", async (c) => {
  if (!isLocal(c.req.raw)) {
    return c.json({ error: "localhost only" }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as { dryRun?: unknown };
  try {
    const result = await consolidateMemories({ dryRun: body.dryRun === true });
    return c.json(result);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "consolidate failed" },
      500,
    );
  }
});

dream.post("/nightly", async (c) => {
  const consolidation = await consolidateMemories({});
  const health = await runHealthSweep();
  return c.json({ consolidation, health });
});
