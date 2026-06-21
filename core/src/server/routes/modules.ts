import { Hono } from "hono";
import { CORE_API_VERSION } from "@/lib/core-version";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  BUILTINS,
  mergeInstalledOverBuiltins,
  type ModuleManifestV2,
} from "@/lib/modules/builtins";
import { manifestTrustError } from "@/lib/modules/signing";
import { loadUserModules } from "@/lib/modules/user-modules";

export const modules = new Hono();

modules.get("/", async (c) => {
  // DB-installed modules (the registry-install path, when populated).
  let installed: ModuleManifestV2[] = [];
  try {
    const supabase = createServiceSupabase();
    const { data, error } = await supabase
      .from("module_installs")
      .select("manifest")
      .eq("status", "installed");
    // Missing table (42P01) or any other read error -> fall back to no installs.
    if (!error && Array.isArray(data)) {
      installed = data
        .map((row) => (row as { manifest?: ModuleManifestV2 }).manifest)
        .filter((m): m is ModuleManifestV2 => !!m)
        // Signing gate (mirrors the /api/m dispatch): with a keyring configured,
        // untrusted installs don't even reach the registry, so the blob never
        // shows a slot that dispatch would 403.
        .filter((m) => {
          const trustErr = manifestTrustError(m);
          if (trustErr) console.warn(`[modules] hiding installed "${m.id}": ${trustErr}`);
          return !trustErr;
        });
    }
  } catch {
    installed = [];
  }

  // Drop-in modules from the data dir (<SPECTRE_DATA_DIR>/modules/<id>/module.json)
  // — the no-edit, no-SQL extension path for users who don't want to touch the
  // core. Precedence: BUILTINS < data-dir modules < DB-installed.
  let userModules: ModuleManifestV2[] = [];
  try {
    userModules = loadUserModules();
  } catch {
    userModules = [];
  }

  return c.json({
    coreApiVersion: CORE_API_VERSION,
    modules: mergeInstalledOverBuiltins([...userModules, ...installed], BUILTINS),
  });
});
