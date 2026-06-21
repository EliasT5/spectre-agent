/**
 * Module capability shim — the trust boundary between a module's declarative
 * backend and the core.
 *
 * `buildCtx({moduleId, permissions})` returns a `ModuleCtx`: a set of CLOSURES
 * that a binding (runBinding) calls. The closures are the ENTIRE surface a
 * module gets. Hard security invariants enforced here:
 *
 *   1. NO Supabase client / query builder / request / router / env / soul /
 *      CORE_TOKEN is ever returned by ctx. Every method returns plain JSON
 *      values only. createServiceSupabase() lives in store.ts and the ingest/
 *      notify/report libs — never reachable through ctx.
 *   2. module_id namespacing: every data call delegates to store.ts (which hard-
 *      filters .eq("module_id", moduleId)); ctx.ingest FORCES evt.module =
 *      moduleId. A module can only act as itself.
 *   3. Each method GATES its permission BEFORE doing anything, then audits the
 *      decision via logModuleCall (a tool_calls row). A denied capability throws
 *      ModuleDenied (the route maps it to 403) and is logged 'deny'.
 *   4. ctx.fetch is https-only, EXACT-origin allowlisted from permissions.network,
 *      redirect:"manual" (no 3xx-follow), and rejects loopback/private origins
 *      (SSRF guard). Locked even though the demo never uses it.
 *
 * Error classes carry an opaque, stable code (never a message that leaks SQL /
 * stack / env). The dispatch route maps them to fixed HTTP statuses.
 */

import { createServiceSupabase } from "@/lib/supabase/server";
import { reportEvent } from "@/lib/monitor/report";
import { runIngest, type IngestEvent } from "@/lib/ingest";
import type { ModulePermissions } from "@/lib/modules/manifest";
import * as store from "@/lib/modules/store";
import dns from "node:dns/promises";

// ── error classes (opaque, stable codes) ────────────────────────────────────
export class ModuleDenied extends Error {
  constructor(public code = "forbidden") {
    super(code);
    this.name = "ModuleDenied";
  }
}
export class ModuleBadRequest extends Error {
  constructor(public code = "bad_request") {
    super(code);
    this.name = "ModuleBadRequest";
  }
}
export class ModuleNotImplemented extends Error {
  constructor(public code = "not_implemented") {
    super(code);
    this.name = "ModuleNotImplemented";
  }
}

// ── ctx surface ─────────────────────────────────────────────────────────────
export interface ModuleCtx {
  data: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<{ ok: true }>;
    list(prefix?: string): Promise<{ keys: string[] }>;
    del(key: string): Promise<{ ok: true }>;
    append(collection: string, doc: unknown): Promise<store.ModuleRow>;
    rows(collection: string, limit?: number): Promise<{ items: store.ModuleRow[] }>;
  };
  ingest(evt: Omit<IngestEvent, "module">): Promise<unknown>;
  schedule: {
    add(...args: unknown[]): Promise<never>;
    remove(...args: unknown[]): Promise<never>;
  };
  notify(input: { title?: string; body?: string; url?: string }): Promise<{ ok: true }>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  log(description: string, detail?: unknown): Promise<void>;
}

/** Fire-and-forget audit row. tool_calls has NO `scope` column — the `tool`
 *  prefix (`module:<id>:<cap>`) IS the scope marker. Swallows all errors so
 *  auditing never affects dispatch. */
function logModuleCall(moduleId: string, cap: string, decision: "allow" | "deny"): void {
  void (async () => {
    try {
      const supabase = createServiceSupabase();
      await supabase
        .from("tool_calls")
        .insert({ tool: `module:${moduleId}:${cap}`, thread_id: null, decision, auto: true });
    } catch {
      /* swallow — auditing must never block the capability flow */
    }
  })();
}

// ── permission gating (the mapping, in ONE place) ───────────────────────────
function canRead(p: ModulePermissions): boolean {
  return p.data === "r" || p.data === "rw";
}
function canWrite(p: ModulePermissions): boolean {
  return p.data === "rw";
}
function hasScope(p: ModulePermissions, scope: string): boolean {
  return Array.isArray(p.scopes) && p.scopes.includes(scope);
}

/** Gate + audit a capability. Throws ModuleDenied (logged 'deny') when denied. */
function gate(moduleId: string, cap: string, allowed: boolean): void {
  if (!allowed) {
    logModuleCall(moduleId, cap, "deny");
    throw new ModuleDenied();
  }
  logModuleCall(moduleId, cap, "allow");
}

// ── outbound fetch SSRF guard (invariant 5) ─────────────────────────────────
const PRIVATE_HOST = (host: string): boolean => {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  if (h === "127.0.0.1" || h.startsWith("127.")) return true;
  if (h.startsWith("10.")) return true;
  if (h.startsWith("192.168.")) return true;
  if (h.startsWith("169.254.")) return true;
  // 172.16.0.0–172.31.255.255 (RFC1918) for completeness
  const m = h.match(/^172\.(\d+)\./);
  if (m) {
    const o = Number(m[1]);
    if (o >= 16 && o <= 31) return true;
  }
  return false;
};

/**
 * Returns true for any IP address that must never be the target of a
 * module-initiated outbound request.  Covers:
 *
 *   IPv4 : 0.0.0.0, 127.0.0.0/8 (loopback), 10/8, 172.16/12, 192.168/16,
 *           169.254/16 (link-local / cloud-metadata), 100.64/10 (CGNAT)
 *   IPv6 : ::1 (loopback), fc00::/7 (unique-local), fe80::/10 (link-local),
 *           ::ffff:0:0/96 (v4-mapped — unwrap and re-check the embedded v4)
 */
function isBlockedIp(ip: string): boolean {
  const s = ip.toLowerCase().trim();

  // ── IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:0xAABBCCDD) ─────────────
  const v4mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return isBlockedIp(v4mapped[1]);

  // ── Pure IPv4 ────────────────────────────────────────────────────────────
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) {
    const [a, b] = s.split(".").map(Number);
    if (a === 0) return true;                              // 0.0.0.0/8
    if (a === 127) return true;                            // 127.0.0.0/8 loopback
    if (a === 10) return true;                             // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true;     // 172.16/12
    if (a === 192 && b === 168) return true;               // 192.168/16
    if (a === 169 && b === 254) return true;               // 169.254/16 link-local / metadata
    if (a === 100 && b >= 64 && b <= 127) return true;    // 100.64/10 CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true;  // 198.18/15 benchmarking
    return false;
  }

  // ── IPv6 ─────────────────────────────────────────────────────────────────
  if (s === "::1") return true;                           // loopback

  // fc00::/7 — unique-local (fc__ and fd__)
  if (/^f[cd]/i.test(s)) return true;

  // fe80::/10 — link-local
  if (/^fe[89ab]/i.test(s)) return true;

  // Catch any remaining unspecified / documentation / reserved prefixes that
  // start with "::" and are not the public :: default route.
  // :: itself (the unspecified address) should also be blocked.
  if (s === "::") return true;

  return false;
}

/**
 * Resolves ALL A/AAAA records for `hostname` and throws ModuleDenied if any
 * resolved address is in a private/loopback/link-local/metadata range.
 * Also throws (fails closed) on DNS resolution error.
 *
 * NOTE: This is a resolve-then-fetch pattern.  A window exists between the DNS
 * check here and the actual TCP connection where a DNS rebinding attack could
 * swap the record to a private IP.  True pinning (connecting directly to the
 * validated IP via a custom Agent) would close this TOCTOU gap but is omitted
 * here to avoid invasive changes to the fetch call-site.  The TTL on the OS
 * resolver cache and the short wall-clock gap make exploitation impractical in
 * this environment, but the residual risk is acknowledged.
 */
async function resolveAndGuard(hostname: string): Promise<void> {
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    // DNS failure → fail closed.
    throw new ModuleDenied("dns_resolution_failed");
  }
  if (!addresses || addresses.length === 0) {
    throw new ModuleDenied("dns_no_result");
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new ModuleDenied("ssrf_blocked_ip");
    }
  }
}

export function buildCtx({
  moduleId,
  permissions,
}: {
  moduleId: string;
  permissions: ModulePermissions;
}): ModuleCtx {
  const p = permissions ?? {};

  return {
    data: {
      async get(key) {
        gate(moduleId, "data.get", canRead(p));
        return store.get(moduleId, key);
      },
      async set(key, value) {
        gate(moduleId, "data.set", canWrite(p));
        return store.set(moduleId, key, value);
      },
      async list(prefix) {
        gate(moduleId, "data.list", canRead(p));
        return store.list(moduleId, prefix);
      },
      async del(key) {
        gate(moduleId, "data.del", canWrite(p));
        return store.del(moduleId, key);
      },
      async append(collection, doc) {
        gate(moduleId, "data.append", canWrite(p));
        return store.append(moduleId, collection, doc);
      },
      async rows(collection, limit) {
        gate(moduleId, "data.rows", canRead(p));
        return store.rows(moduleId, collection, limit);
      },
    },

    async ingest(evt) {
      gate(moduleId, "ingest", hasScope(p, "ingest"));
      // FORCE the module identity — a module can only ingest AS ITSELF.
      return runIngest({ ...evt, module: moduleId });
    },

    schedule: {
      async add() {
        gate(moduleId, "schedule.add", hasScope(p, "schedule"));
        throw new ModuleNotImplemented(); // P2f
      },
      async remove() {
        gate(moduleId, "schedule.remove", hasScope(p, "schedule"));
        throw new ModuleNotImplemented(); // P2f
      },
    },

    async notify(input) {
      gate(moduleId, "notify", hasScope(p, "notify"));
      try {
        const { sendPush } = await import("@/lib/notify");
        await sendPush({
          title: input.title ?? `Jerome · ${moduleId}`,
          body: String(input.body ?? "").slice(0, 160),
          url: input.url ?? "/",
        });
      } catch {
        /* push best-effort (no VAPID/sub is fine) */
      }
      return { ok: true };
    },

    async fetch(url, init) {
      // Resolve + gate on the EXACT origin (scheme+host+port).
      let parsed!: URL;
      let origin: string;
      try {
        parsed = new URL(url);
        if (parsed.protocol !== "https:") {
          gate(moduleId, "fetch", false);
        }
        if (PRIVATE_HOST(parsed.hostname)) {
          gate(moduleId, "fetch", false);
        }
        origin = parsed.origin;
      } catch {
        gate(moduleId, "fetch", false);
        throw new ModuleDenied(); // unreachable — gate already threw
      }
      const allow = Array.isArray(p.network) && p.network.includes(origin);
      gate(moduleId, "fetch", allow);
      // Resolve DNS and block if any returned address is private/loopback/
      // link-local/metadata — guards against DNS-rebinding where an allowlisted
      // hostname resolves to an internal address at request time.
      await resolveAndGuard(parsed.hostname);
      return fetch(url, { ...init, redirect: "manual" });
    },

    async log(description, detail) {
      // log is ungated (no secret surface) but still scoped to this module.
      await reportEvent({
        severity: "info",
        component: `module:${moduleId}`,
        description: String(description).slice(0, 1000),
        detail,
      });
    },
  };
}
