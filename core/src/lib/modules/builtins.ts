/**
 * The built-in modules — the four slots that ship with the core product.
 *
 * These mirror the shell's static `MODULES` seed (jerome_prod/src/lib/modules.ts)
 * exactly, expressed in the richer jerome.module.json v2 shape. The live
 * `/api/modules` registry returns these (merged over any installed modules) so
 * the shell's static list is only ever an instant SSR/offline fallback.
 *
 * The canonical `ModuleManifestV2` type lives in manifest.ts (alongside the zod
 * validator) and is re-exported here so callers have one import surface.
 */
export type { ModuleManifestV2 } from "./manifest";
import type { ModuleManifestV2 } from "./manifest";

export const BUILTINS: ModuleManifestV2[] = [
  {
    schemaVersion: 2,
    id: "chat",
    label: "Chat",
    version: "0.1.0",
    route: "/chat",
    icon: "MessageSquare",
    builtin: true,
    uiMode: "native",
    sdkRange: "^1.0.0",
  },
  {
    schemaVersion: 2,
    id: "memory",
    label: "Memory",
    version: "0.1.0",
    route: "/memory",
    icon: "Brain",
    builtin: true,
    uiMode: "native",
    sdkRange: "^1.0.0",
  },
  {
    schemaVersion: 2,
    id: "settings",
    label: "Settings",
    version: "0.1.0",
    route: "/settings",
    icon: "Settings",
    builtin: true,
    uiMode: "native",
    sdkRange: "^1.0.0",
  },
  {
    schemaVersion: 2,
    id: "monitor",
    label: "Monitor",
    version: "0.1.0",
    route: "/monitor",
    icon: "Activity",
    hint: "system health & errors",
    builtin: true,
    uiMode: "native",
    sdkRange: "^1.0.0",
  },
  {
    schemaVersion: 2,
    id: "tempus",
    label: "Tempus",
    version: "0.1.0",
    route: "/tempus",
    icon: "Timer",
    hint: "time tracking",
    builtin: true,
    uiMode: "native",
    sdkRange: "^1.0.0",
  },
  {
    schemaVersion: 2,
    id: "workspace",
    label: "Workspace",
    version: "0.1.0",
    route: "/workspace",
    icon: "FolderGit2",
    hint: "code workspaces (opt-in)",
    builtin: true,
    uiMode: "native",
    sdkRange: "^1.0.0",
  },
  {
    schemaVersion: 2,
    id: "library",
    label: "Library",
    version: "0.1.0",
    route: "/library",
    icon: "Image",
    hint: "PDFs, screenshots & images",
    builtin: true,
    uiMode: "native",
    sdkRange: "^1.0.0",
  },
];

/**
 * Merge installed modules over the built-ins:
 *   - an installed module with the same id as a built-in overrides it (in place),
 *   - non-overridden built-ins pass through,
 *   - installed-only modules are appended.
 * In P2a `installed` is always [] (the module_installs table does not exist yet),
 * so this returns BUILTINS unchanged — but the merge logic is the shape the
 * later install phases rely on.
 */
export function mergeInstalledOverBuiltins(
  installed: ModuleManifestV2[],
  builtins: ModuleManifestV2[],
): ModuleManifestV2[] {
  const byId = new Map(installed.map((m) => [m.id, m]));
  const merged = builtins.map((b) => byId.get(b.id) ?? b);
  const builtinIds = new Set(builtins.map((b) => b.id));
  const installedOnly = installed.filter((m) => !builtinIds.has(m.id));
  return [...merged, ...installedOnly];
}
