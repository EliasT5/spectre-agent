import { Hono } from "hono";
import { createServiceSupabase } from "@/lib/supabase/server";
import { manifestTrustError } from "@/lib/modules/signing";
import { resolveBackend } from "@/lib/modules/manifest";
import { matchRoute, runBinding } from "@/lib/modules/bindings";
import {
  buildCtx,
  ModuleDenied,
  ModuleBadRequest,
  ModuleNotImplemented,
} from "@/lib/modules/ctx";

export const m = new Hono();

m.all("/:id/*", async (c) => {
  const id = c.req.param("id");
  const rest = c.req.path.split(`/api/m/${id}/`)[1] ?? "";
  const restSegments = rest.split("/").filter((seg) => seg.length > 0);

  // Path-traversal guard.
  if (restSegments.some((seg) => seg === "..") || restSegments.join("/").includes("..")) {
    return c.json({ error: "bad_request" }, 400);
  }

  // Resolve the installed manifest (raw jsonb).
  let manifest: unknown = null;
  try {
    const supabase = createServiceSupabase();
    const { data, error } = await supabase
      .from("module_installs")
      .select("manifest")
      .eq("module_id", id)
      .eq("status", "installed")
      .maybeSingle();
    if (error || !data) {
      return c.json({ error: "module_not_found" }, 404);
    }
    manifest = (data as { manifest?: unknown }).manifest ?? null;
  } catch {
    return c.json({ error: "module_not_found" }, 404);
  }

  // Signing gate: with a keyring configured (SPECTRE_MODULE_TRUSTED_KEYS), a
  // DB-installed manifest must be signed by a trusted key before its routes and
  // permission grants are honored. The compiled-in BUILTINS never dispatch
  // through this table, so everything here is untrusted provenance.
  const trustErr = manifestTrustError(manifest);
  if (trustErr) {
    console.warn(`[modules] refusing dispatch for "${id}": ${trustErr}`);
    return c.json({ error: "module_untrusted" }, 403);
  }

  // Narrow to the dispatch-relevant subset (routes + gated permissions).
  const backend = resolveBackend(manifest);
  if (!backend || backend.routes.length === 0) {
    return c.json({ error: "no_backend" }, 404);
  }

  const path = "/" + restSegments.join("/");
  const match = matchRoute(backend.routes, c.req.method, path);
  if (!match) {
    return c.json({ error: "route_not_found" }, 404);
  }

  const ctx = buildCtx({ moduleId: id, permissions: backend.permissions });

  try {
    const result = await runBinding({
      route: match.route,
      ctx,
      request: c.req.raw,
      pathParams: match.pathParams,
    });
    return c.json(result ?? { ok: true });
  } catch (e) {
    if (e instanceof ModuleDenied) {
      return c.json({ error: "forbidden" }, 403);
    }
    if (e instanceof ModuleBadRequest) {
      return c.json({ error: "bad_request" }, 400);
    }
    if (e instanceof ModuleNotImplemented) {
      return c.json({ error: "not_implemented" }, 501);
    }
    return c.json({ error: "module_error" }, 500);
  }
});
