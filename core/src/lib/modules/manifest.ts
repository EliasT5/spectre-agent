/**
 * jerome.module.json v2 — the manifest contract for an installable module.
 *
 * This file owns the canonical `ModuleManifestV2` type AND the runtime zod
 * validator. The validator is the gate used at install time (later phases);
 * in P2a it ships but the route does not enforce it (the built-ins are
 * already trusted). `builtins.ts` re-exports `ModuleManifestV2` from here so
 * there is a single source of truth for the shape.
 */
import { z } from "zod";

const uiModeSchema = z.enum(["native", "data", "code"]);

// ── permissions (object form) ───────────────────────────────────────────────
// The capabilities a module requests. Back-compat: built-ins ship NO
// `permissions` at all (the field is .optional()), so they stay valid.
// `.passthrough()` keeps unknown keys for forward compatibility. The data grant
// is an enum: '' (none, default) | 'r' (read) | 'rw' (read+write).
const permissionsSchema = z
  .object({
    /** dotted @spectre/sdk paths the schema may call, e.g. "monitor", "health" */
    sdk: z.array(z.string()).optional(),
    /** core /api routes a module backend may reach (forward-looking) */
    core: z.array(z.string()).optional(),
    /** per-module data grant: '' none | 'r' read | 'rw' read+write */
    data: z.enum(["", "r", "rw"]).optional(),
    /** EXACT outbound origins a module backend's ctx.fetch may reach (https) */
    network: z.array(z.string()).optional(),
    /** named capability scopes: 'ingest' | 'notify' | 'schedule' | … */
    scopes: z.array(z.string()).optional(),
  })
  .passthrough();

/** The capabilities a module requests, object form. */
export type ModulePermissions = z.infer<typeof permissionsSchema>;

// ── backend (declarative routes) ────────────────────────────────────────────
// A module ships its OWN backend as DATA: a list of routes, each bound to ONE
// capability `binding` from the closed `BindingKind` vocabulary. There is NO
// module code here — `handler` is reserved for P2f and dispatches to 501.
const httpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** The closed set of declarative bindings a route may use. */
export const BINDING_KINDS = [
  "data.get",
  "data.set",
  "data.list",
  "data.del",
  "data.append",
  "data.rows",
  "ingest",
  "schedule.add",
  "schedule.remove",
  "handler",
] as const;

const bindingKindSchema = z.enum(BINDING_KINDS);

/** A declarative binding name — what a route does, from a closed vocabulary. */
export type BindingKind = (typeof BINDING_KINDS)[number];

const backendRouteSchema = z
  .object({
    method: httpMethodSchema,
    /** route path under /api/m/<id>, e.g. "/tick" or "/item/:id" */
    path: z.string(),
    binding: bindingKindSchema,
    /** declarative args, interpolated against the request (see runBinding) */
    args: z.record(z.string(), z.unknown()).optional(),
    /** reserved for P2f code handlers — dispatches to 501 until then */
    handler: z.string().optional(),
  })
  .passthrough();

/** One declarative backend route a module ships in its manifest. */
export type BackendRoute = z.infer<typeof backendRouteSchema>;

const backendSchema = z
  .object({
    routes: z.array(backendRouteSchema).default([]),
  })
  .passthrough();

/** Author block — pubkey + signature are base64url (see signing.ts). */
const authorSchema = z
  .object({
    name: z.string().optional(),
    url: z.string().optional(),
    /** ed25519 public key, base64url */
    pubkey: z.string().optional(),
  })
  .passthrough();

export const ModuleManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    id: z.string(),
    label: z.string(),
    version: z.string(),
    description: z.string().optional(),
    route: z.string(),
    icon: z.string(),
    hint: z.string().optional(),
    builtin: z.boolean().optional(),
    /** required @spectre/sdk semver range (e.g. "^1.0.0") */
    sdkRange: z.string().optional(),
    /** required core /api contract semver range */
    coreRange: z.string().optional(),
    uiMode: uiModeSchema,
    /** ui bundle descriptor (entry, assets) — opaque here */
    ui: z.unknown().optional(),
    /** declarative backend — { routes: BackendRoute[] }. Back-compat: optional. */
    backend: backendSchema.optional(),
    /** data/schema descriptor — opaque here */
    data: z.unknown().optional(),
    /** requested capabilities (object form). Back-compat: optional. */
    permissions: permissionsSchema.optional(),
    author: authorSchema.optional(),
    /** ed25519 signature over the canonicalized manifest, base64url */
    signature: z.string().optional(),
  })
  .passthrough();

/** The canonical manifest type — inferred from the schema so they cannot drift. */
export type ModuleManifestV2 = z.infer<typeof ModuleManifestSchema>;

/** Validate a raw manifest object. Used at install time, not in the P2a route. */
export function validateManifest(
  raw: unknown,
): { ok: true; manifest: ModuleManifestV2 } | { ok: false; errors: string[] } {
  const parsed = ModuleManifestSchema.safeParse(raw);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  const errors = parsed.error.issues.map(
    (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
  );
  return { ok: false, errors };
}

/**
 * Validate ONLY the subset the dispatch relies on, out of a RAW manifest jsonb.
 *
 * The capability shim reads `manifest` straight from the DB row and calls this —
 * it never trusts the whole document, only the `backend.routes` it will dispatch
 * and the `permissions` it will gate against. Returns:
 *   - null  → the backend subobject is absent or malformed (route answers 404),
 *   - { routes, permissions } → a validated, narrowed slice; `permissions`
 *     defaults to {} when absent or malformed (NEVER inheriting a grant on a
 *     bad permissions block — fail closed).
 */
export function resolveBackend(
  rawManifest: unknown,
): { routes: BackendRoute[]; permissions: ModulePermissions } | null {
  if (!rawManifest || typeof rawManifest !== "object") return null;
  const raw = rawManifest as Record<string, unknown>;

  const backendParsed = backendSchema.safeParse(raw.backend);
  if (!backendParsed.success) return null;

  // Permissions are gated separately: a malformed block must NOT silently grant
  // anything, so it falls back to {} (no grants) rather than failing the route.
  const permParsed = permissionsSchema.safeParse(raw.permissions);
  const permissions: ModulePermissions = permParsed.success ? permParsed.data : {};

  return { routes: backendParsed.data.routes, permissions };
}
