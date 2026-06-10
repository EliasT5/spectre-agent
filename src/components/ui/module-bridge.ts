/**
 * module-bridge — the parent half of the Code-mode sandbox RPC.
 *
 * A Code-mode module runs UNTRUSTED inside an opaque-origin sandboxed iframe and
 * can ONLY reach the core by sending RPC requests over a dedicated, unforgeable
 * MessageChannel port. `mountBridge` installs the handler on that port. The port
 * is the SOLE channel — there is no window-level SDK listener; the one-time
 * handshake (in ModuleFrame) verifies the frame's identity and transfers the
 * port before any SDK traffic flows.
 *
 * Every inbound request passes the SAME closed allowlist the Data-mode runtime
 * uses (SDK_CALLS + sdkAllowed, read-only spectre.* only). A non-granted call
 * replies {error:"permission_denied"}; module-backend calls are FORCED to this
 * module's own id (the frame cannot pick a target). A token bucket + in-flight
 * cap + per-session cap bound abuse. Replies carry RESULTS or OPAQUE error codes
 * only — never CORE_TOKEN (the real spectre.* runs on the shell origin and rides
 * the /api proxy, which injects the token server-side).
 */

import { spectre } from "@/lib/sdk";
import type { ModulePermissions } from "@/lib/module-manifest";
import { SDK_CALLS, sdkAllowed, isSafeModulePath } from "./sdk-calls";

interface BridgeArgs {
  /** the sandboxed iframe (kept for symmetry / future origin checks) */
  frame: HTMLIFrameElement;
  /** the parent's end of the MessageChannel (port1) */
  port: MessagePort;
  /** this module's id — FORCED onto every module-backend call */
  moduleId: string;
  /** the module's granted permissions (gates sdk calls) */
  permissions: ModulePermissions;
}

/** A request envelope sent by the frame over the port. */
interface SdkRequest {
  type: "spectre:sdk";
  id: number | string;
  kind: "sdk" | "module";
  path: string;
  args?: unknown[];
}

// ── abuse caps ───────────────────────────────────────────────────────────────
const RATE_PER_SEC = 20; // token-bucket refill
const MAX_INFLIGHT = 8; // concurrent requests
const SESSION_CAP = 600; // total requests for the life of this frame

/** Narrow a frame-supplied RequestInit to a tiny, safe whitelist for a module
 *  backend call: only {method, headers:{content-type}, body:string}. Everything
 *  else (mode, credentials, signal, arbitrary headers, …) is dropped — the
 *  frame cannot influence how the parent's fetch is made beyond this. */
function sanitizeInit(raw: unknown): RequestInit {
  const init: RequestInit = {};
  if (!raw || typeof raw !== "object") return init;
  const r = raw as Record<string, unknown>;
  if (typeof r.method === "string") {
    const m = r.method.toUpperCase();
    if (["GET", "POST", "PUT", "PATCH", "DELETE"].includes(m)) init.method = m;
  }
  if (r.headers && typeof r.headers === "object") {
    const h = r.headers as Record<string, unknown>;
    const ct = h["content-type"] ?? h["Content-Type"];
    if (typeof ct === "string") init.headers = { "content-type": ct };
  }
  if (typeof r.body === "string") init.body = r.body;
  return init;
}

/**
 * Install the RPC handler on `port` and return a cleanup that detaches it.
 * The handler is the ONLY thing that ever runs spectre.* on behalf of the frame.
 */
export function mountBridge({ port, moduleId, permissions }: BridgeArgs): () => void {
  // token bucket: start full, refill RATE_PER_SEC per second up to RATE_PER_SEC.
  let tokens = RATE_PER_SEC;
  let last = Date.now();
  let inflight = 0;
  let total = 0;
  let alive = true;

  const refill = () => {
    const now = Date.now();
    tokens = Math.min(RATE_PER_SEC, tokens + ((now - last) / 1000) * RATE_PER_SEC);
    last = now;
  };

  const reply = (id: SdkRequest["id"], body: { result?: unknown } | { error: string }) => {
    if (!alive) return;
    try {
      port.postMessage({ type: "spectre:sdk:reply", id, ...body });
    } catch {
      // port closed / clone failure — drop silently (opaque to the frame)
    }
  };

  const handler = async (ev: MessageEvent) => {
    const msg = ev.data as SdkRequest | undefined;
    if (!msg || msg.type !== "spectre:sdk") return; // ignore anything off-protocol
    const { id, kind, path } = msg;
    if (id == null) return;

    // ── caps ──
    if (total >= SESSION_CAP) return reply(id, { error: "quota_exceeded" });
    refill();
    if (tokens < 1) return reply(id, { error: "rate_limited" });
    if (inflight >= MAX_INFLIGHT) return reply(id, { error: "too_many_inflight" });
    tokens -= 1;
    total += 1;
    inflight += 1;

    try {
      if (kind === "sdk") {
        if (typeof path !== "string" || !sdkAllowed(path, permissions)) {
          return reply(id, { error: "permission_denied" });
        }
        const fn = SDK_CALLS[path];
        // Cap arity at 4 — these read fns take 0–1 args; extra are ignored.
        const args = Array.isArray(msg.args) ? msg.args.slice(0, 4) : [];
        const result = await fn(...(args as Parameters<typeof fn>));
        return reply(id, { result });
      }

      if (kind === "module") {
        // path traversal guard — a module can only reach ITS OWN backend root.
        if (!isSafeModulePath(path)) {
          return reply(id, { error: "permission_denied" });
        }
        const init = sanitizeInit(Array.isArray(msg.args) ? msg.args[0] : undefined);
        // id is FORCED to this module — the frame's args carry no target id.
        const result = await spectre.module(moduleId).call(path, init);
        return reply(id, { result });
      }

      return reply(id, { error: "unknown_kind" });
    } catch {
      // OPAQUE error — never leak the underlying message / token / status.
      return reply(id, { error: "call_failed" });
    } finally {
      inflight -= 1;
    }
  };

  port.onmessage = handler;
  port.start?.();

  return () => {
    alive = false;
    port.onmessage = null;
  };
}
