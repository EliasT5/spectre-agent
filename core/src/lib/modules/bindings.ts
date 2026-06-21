/**
 * Declarative binding dispatch — turns a manifest `BackendRoute` into a call on
 * the capability shim (ModuleCtx). NO module code runs: each route names ONE
 * `binding` from the closed vocabulary, and we map it to the matching ctx method.
 *
 * `matchRoute` resolves an incoming (method, path) to a route, supporting static
 * segments and `:name` single-segment params (first match wins). `runBinding`
 * parses the body once, builds a token scope from the request, interpolates the
 * route's `args` (single-whole-token rule), and dispatches. `handler`/`schedule.*`
 * throw ModuleNotImplemented (501) — code-mode is P2f.
 *
 * Tokens resolve to PLAIN values handed to ctx (which passes them as query-
 * builder PARAMETERS in store.ts) — never string-concatenated into SQL.
 */

import type { BackendRoute, BindingKind } from "@/lib/modules/manifest";
import {
  type ModuleCtx,
  ModuleBadRequest,
  ModuleNotImplemented,
} from "@/lib/modules/ctx";

export interface RouteMatch {
  route: BackendRoute;
  /** path params captured from `:name` segments */
  pathParams: Record<string, string>;
}

/** Match (method, path) against the routes; static + `:seg` params, first win. */
export function matchRoute(
  routes: BackendRoute[],
  method: string,
  path: string,
): RouteMatch | null {
  const reqSegs = splitPath(path);
  const m = method.toUpperCase();
  for (const route of routes) {
    if (route.method.toUpperCase() !== m) continue;
    const routeSegs = splitPath(route.path);
    if (routeSegs.length !== reqSegs.length) continue;
    const pathParams: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < routeSegs.length; i++) {
      const rs = routeSegs[i];
      if (rs.startsWith(":")) {
        pathParams[rs.slice(1)] = decodeURIComponent(reqSegs[i]);
      } else if (rs !== reqSegs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, pathParams };
  }
  return null;
}

function splitPath(p: string): string[] {
  return p.split("/").filter((s) => s.length > 0);
}

// ── token scope + interpolation ─────────────────────────────────────────────
interface TokenScope {
  date: string;
  userId: string;
  path: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

/** Whole-token "{...}" → raw resolved value; else a literal string. */
const WHOLE = /^\{([^}]*)\}$/;

function resolveToken(token: string, scope: TokenScope): unknown {
  const t = token.trim();
  if (t === "date") return scope.date;
  if (t === "userId") return scope.userId;
  if (t === "body") return scope.body;
  if (t.startsWith("path.")) return scope.path[t.slice(5)];
  if (t.startsWith("query.")) return scope.query[t.slice(6)];
  if (t.startsWith("body.")) return readDot(scope.body, t.slice(5));
  return undefined;
}

/** Dotted read into the parsed body (pure, never throws). */
function readDot(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Interpolate one arg value against the scope.
 *   - a SINGLE whole-token string ("{path.id}") → the RAW resolved value,
 *   - any other string → returned literally (no inline substitution),
 *   - objects/arrays → interpolated deeply,
 *   - everything else → passed through.
 */
function interpolate(val: unknown, scope: TokenScope): unknown {
  if (typeof val === "string") {
    const m = val.match(WHOLE);
    if (m) return resolveToken(m[1], scope);
    return val;
  }
  if (Array.isArray(val)) return val.map((v) => interpolate(v, scope));
  if (val && typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = interpolate(v, scope);
    }
    return out;
  }
  return val;
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
}

/**
 * Execute a matched route's binding via the ctx. Parses the body once (non-GET),
 * builds the token scope, interpolates args, and dispatches by binding kind.
 */
export async function runBinding(opts: {
  route: BackendRoute;
  ctx: ModuleCtx;
  request: Request;
  pathParams: Record<string, string>;
}): Promise<unknown> {
  const { route, ctx, request, pathParams } = opts;
  const binding = route.binding as BindingKind;

  // code handlers / schedule are P2f.
  if (binding === "handler" || binding === "schedule.add" || binding === "schedule.remove") {
    throw new ModuleNotImplemented();
  }

  let body: unknown = undefined;
  if (request.method.toUpperCase() !== "GET" && request.method.toUpperCase() !== "HEAD") {
    body = await request.json().catch(() => ({}));
  }

  const url = new URL(request.url);
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    query[k] = v;
  });

  const scope: TokenScope = {
    date: new Date().toISOString(),
    userId: "owner",
    path: pathParams,
    query,
    body: body ?? {},
  };

  const args = interpolate(route.args ?? {}, scope) as Record<string, unknown>;

  switch (binding) {
    case "data.get":
      return ctx.data.get(asString(args.key));

    case "data.set": {
      // value may be "{body}" (whole body) or "{body.x}" — already interpolated
      // by `args`; if absent, fall back to the whole parsed body.
      const value = "value" in args ? args.value : scope.body;
      return ctx.data.set(asString(args.key), value);
    }

    case "data.list":
      return ctx.data.list(args.prefix == null ? undefined : asString(args.prefix));

    case "data.del":
      return ctx.data.del(asString(args.key));

    case "data.append":
      return ctx.data.append(asString(args.collection), args.doc ?? scope.body);

    case "data.rows": {
      const limit = args.limit == null ? undefined : Number(args.limit);
      return ctx.data.rows(asString(args.collection), limit);
    }

    case "ingest": {
      // Merge the parsed body with declarative args (args win). The ctx forces
      // module = moduleId, so a module can only ingest as itself.
      const bodyObj =
        scope.body && typeof scope.body === "object" && !Array.isArray(scope.body)
          ? (scope.body as Record<string, unknown>)
          : {};
      const merged = { ...bodyObj, ...args };
      // strip any attempt to set module/threadId path via args isn't possible to
      // escape namespacing; ctx.ingest overrides module regardless.
      return ctx.ingest(merged as Parameters<ModuleCtx["ingest"]>[0]);
    }

    default:
      // Exhaustive over the implemented set; anything else is a bad manifest.
      throw new ModuleBadRequest("bad_binding");
  }
}
