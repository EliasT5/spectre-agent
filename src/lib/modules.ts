/**
 * The module registry — the source of truth for what slots orbit the blob.
 *
 * A "module" is a slot: a route in the shell (public, user-modifiable UI) that
 * talks to the private core over the fixed /api contract (see sdk.ts). The base
 * modules ship built-in; the workshop grows the product by scaffolding new
 * modules (a route + a manifest entry) into THIS shell repo — never the core.
 *
 * Adding a module = add a ModuleManifest here + a route at its `route` path.
 * The blob's slot launcher renders straight from this list, so a new entry
 * shows up as a new slot (Next picks up the route; in dev, immediately).
 */

export interface ModuleManifest {
  /** stable id, kebab-case */
  id: string;
  /** slot label under the icon */
  label: string;
  /** route the slot opens */
  route: string;
  /** lucide icon name (resolved by the slot launcher) */
  icon: string;
  /** optional one-line hint */
  hint?: string;
  /** ships with the core product (vs workshop-added) */
  builtin?: boolean;
  /** required @spectre/sdk major version */
  sdk?: number;
}

export const MODULES: ModuleManifest[] = [
  { id: "chat", label: "Chat", route: "/chat", icon: "MessageSquare", builtin: true, sdk: 1 },
  { id: "memory", label: "Memory", route: "/memory", icon: "Brain", builtin: true, sdk: 1 },
  { id: "settings", label: "Settings", route: "/settings", icon: "Settings", builtin: true, sdk: 1 },
  // ── workshop-added modules go below ──
  { id: "monitor", label: "Monitor", route: "/monitor", icon: "Activity", hint: "system health & errors", sdk: 1 },
  { id: "tempus", label: "Tempus", route: "/tempus", icon: "Timer", hint: "time tracking", sdk: 1 },
  { id: "workspace", label: "Workspace", route: "/workspace", icon: "FolderGit2", hint: "code workspaces (opt-in)", sdk: 1 },
  { id: "library", label: "Library", route: "/library", icon: "Image", hint: "PDFs, screenshots & images", sdk: 1 },
];

export const moduleById = (id: string) => MODULES.find((m) => m.id === id);
