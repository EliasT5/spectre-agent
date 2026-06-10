/**
 * spectre.module.json v2 — the shell-side type for a registry item.
 *
 * This is a PLAIN TypeScript type only: no zod, no runtime, no new dependency.
 * It mirrors the core's `ModuleManifestV2` shape so the shell can read items
 * returned by the live `/api/modules` registry. Runtime validation lives in the
 * core (it owns the trust boundary); the shell only consumes already-trusted
 * registry data.
 */

export type ModuleUiMode = "native" | "data" | "code";

/**
 * The capabilities a module requests, as an OBJECT (not a flat string[]).
 * `sdk` is the load-bearing field in Data mode: dotted @spectre/sdk paths the
 * module's UI Schema is allowed to call (e.g. ["monitor", "health", "usage"]).
 * The other arrays are forward-looking grant lists (core endpoints, network
 * hosts, scopes) consumed by later phases; the Data-mode gate only reads `sdk`.
 */
export interface ModulePermissions {
  /** dotted @spectre/sdk paths the schema may call, e.g. "monitor", "health" */
  sdk?: string[];
  /** core /api routes a module backend may reach (P2c) */
  core?: string[];
  /** opaque data grants (P2c) */
  data?: unknown;
  /** outbound network hosts a module backend may reach (P2c) */
  network?: string[];
  /** named capability scopes */
  scopes?: string[];
}

/**
 * Code-mode UI bundle descriptor (the `ui.code` field of a `uiMode: "code"`
 * manifest). `entry` is the URL of the module's ESM bundle (its default export
 * is `mount(root, ctx)`); `css` is optional module CSS injected into the frame;
 * `integrity` is a Subresource-Integrity hash (`sha384-<base64>`) the shell
 * verifies AGAINST THE FETCHED TEXT before the bundle is ever posted into the
 * sandbox. The bundle is fetched as text, SRI-checked, then blob:-imported
 * INSIDE the opaque frame — never a <script src> on the shell, never imported
 * into the shell React tree.
 */
export interface ModuleUiCode {
  /** URL of the module's ESM entry bundle (default export = mount(root, ctx)). */
  entry: string;
  /** optional module CSS, injected into the frame's document. */
  css?: string;
  /** SRI hash over the entry text, e.g. "sha384-<base64>". */
  integrity?: string;
}

export interface ModuleManifestV2 {
  schemaVersion: 2;
  /** stable id, kebab-case */
  id: string;
  /** slot label under the icon */
  label: string;
  /** module version (semver) */
  version: string;
  description?: string;
  /** route the slot opens */
  route: string;
  /** lucide icon name (resolved by the slot launcher) */
  icon: string;
  /** optional one-line hint */
  hint?: string;
  /** ships with the core product (vs workshop/installed) */
  builtin?: boolean;
  /** required @spectre/sdk semver range (e.g. "^1.0.0") */
  sdkRange?: string;
  /** required core /api contract semver range */
  coreRange?: string;
  /** how the module's UI is delivered */
  uiMode: ModuleUiMode;
  /** ui bundle descriptor (entry, assets) — opaque to the shell */
  ui?: unknown;
  /** backend/handler descriptor — opaque to the shell */
  backend?: unknown;
  /** data/schema descriptor — opaque to the shell */
  data?: unknown;
  /** requested capabilities (object form; `sdk` gates Data mode) */
  permissions?: ModulePermissions;
  author?: {
    name?: string;
    url?: string;
    /** ed25519 public key, base64url */
    pubkey?: string;
    [k: string]: unknown;
  };
  /** ed25519 signature over the canonicalized manifest, base64url */
  signature?: string;
}
