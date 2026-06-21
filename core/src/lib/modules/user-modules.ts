/**
 * User-dropped modules — the drop-in extension path for a NEW USER who doesn't
 * want to edit the core. Drop a directory into the persistent data dir:
 *
 *   <SPECTRE_DATA_DIR>/modules/<id>/module.json   (a ModuleManifestV2)
 *
 * and `/api/modules` picks it up (validated) so the blob shows the slot and
 * `/m/<id>` renders it — NO core edit, NO shell edit, NO SQL. This mirrors the
 * skills/tools/mcp overlay (see lib/ext/dirs). A repo may also ship example
 * modules under the baked `modules/` dir; the user data dir overrides by id.
 *
 * Constraints (enforced here):
 *  - manifests are run through validateManifest (fail-closed: a bad one is skipped),
 *  - `uiMode: "native"` is REJECTED — a native slot needs a real shell route, which
 *    a user can't add without editing source. Users add `data` (rendered by
 *    SchemaRuntime) or `code` (sandboxed) modules only.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { builtinDir, userDir } from "@/lib/ext/dirs";
import { manifestTrustError } from "./signing";
import { validateManifest, type ModuleManifestV2 } from "./manifest";

/** Built-in example dir first, user data dir last (user overrides by id). */
function moduleDirs(): string[] {
  return [builtinDir("modules"), userDir("modules")];
}

export function loadUserModules(): ModuleManifestV2[] {
  const byId = new Map<string, ModuleManifestV2>();
  for (const dir of moduleDirs()) {
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of entries) {
      if (!d.isDirectory()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(dir, d.name, "module.json"), "utf8"));
      } catch {
        continue; // no/!invalid module.json — skip silently
      }
      const result = validateManifest(raw);
      if (!result.ok) {
        console.warn(`[modules] skipping data-dir module "${d.name}": ${result.errors.join("; ")}`);
        continue;
      }
      const m = result.manifest;
      if (m.uiMode === "native") {
        console.warn(`[modules] skipping "${m.id}": data-dir modules can't be uiMode "native" (a native route needs shell source — use data or code).`);
        continue;
      }
      // Signing gate: drop-ins are untrusted provenance like DB installs.
      const trustErr = manifestTrustError(m);
      if (trustErr) {
        console.warn(`[modules] skipping data-dir module "${m.id}": ${trustErr}`);
        continue;
      }
      byId.set(m.id, { ...m, builtin: false });
    }
  }
  return [...byId.values()];
}
