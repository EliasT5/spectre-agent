/**
 * The live module registry — the shell-side bridge to the core's /api/modules.
 *
 * The static `MODULES` list (lib/modules.ts) is the instant SSR/offline seed:
 * first paint always uses it. This module swaps in the live registry once it
 * loads, so installed modules show up without a redeploy — but never at the
 * cost of a blank first frame.
 *
 * The fetch is a SHELL-RELATIVE `/api/modules`: it rides the existing shell
 * proxy that injects CORE_TOKEN, so there's no client-side token here.
 */
import { useEffect, useState } from "react";
import { MODULES, type ModuleManifest } from "@/lib/modules";
import type { ModuleManifestV2 } from "@/lib/module-manifest";

const CACHE_KEY = "spectre:modules:v1";

/** Map a v2 registry item down to the existing shell ModuleManifest shape. */
function toModuleManifest(m: ModuleManifestV2): ModuleManifest {
  return {
    id: m.id,
    label: m.label,
    route: m.route,
    icon: m.icon,
    hint: m.hint,
    builtin: m.builtin,
    // ^1.0.0 -> 1 ; the shell only tracks the major for now.
    sdk: parseSdkMajor(m.sdkRange),
  };
}

/**
 * Dev-time guard against the two-source trap: the blob renders from the LIVE
 * registry (core BUILTINS), while the static MODULES here is only the offline
 * fallback. If you add a module to one and not the other (e.g. the core's
 * src/lib/modules/builtins.ts vs this repo's src/lib/modules.ts), the slot
 * silently won't appear / will flicker offline. This screams in the dev console
 * the moment the two drift, so it never has to be debugged by hand again.
 */
function warnOnDrift(live: ModuleManifest[]): void {
  if (process.env.NODE_ENV === "production") return;
  // Only BUILT-IN modules must mirror the static fallback; user/installed +
  // data-dir-dropped modules (builtin !== true) are EXPECTED to differ.
  const liveIds = new Set(live.filter((m) => m.builtin === true).map((m) => m.id));
  const seedIds = new Set(MODULES.map((m) => m.id));
  const onlyLive = [...liveIds].filter((id) => !seedIds.has(id));
  const onlySeed = [...seedIds].filter((id) => !liveIds.has(id));
  if (onlyLive.length || onlySeed.length) {
    console.warn(
      "[modules] DRIFT between the live registry (core BUILTINS) and the static fallback (src/lib/modules.ts).\n" +
        `  only in live registry: [${onlyLive.join(", ") || "—"}]\n` +
        `  only in static fallback: [${onlySeed.join(", ") || "—"}]\n` +
        "  → keep spectre-core/src/lib/modules/builtins.ts and spectre-agent/src/lib/modules.ts in sync.",
    );
  }
}

function parseSdkMajor(range: string | undefined): number | undefined {
  if (!range) return undefined;
  const match = range.match(/(\d+)/);
  return match ? Number(match[1]) : undefined;
}

function readCache(): ModuleManifest[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ModuleManifest[]) : null;
  } catch {
    return null;
  }
}

function writeCache(modules: ModuleManifest[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(modules));
  } catch {
    // ignore quota / disabled storage
  }
}

/**
 * Fetch the live module list from the core (via the shell proxy), map it to the
 * shell ModuleManifest shape, and cache it in localStorage. On ANY failure,
 * fall back to the cached list if present, otherwise the static MODULES seed.
 */
export async function getModules(): Promise<ModuleManifest[]> {
  try {
    const res = await fetch("/api/modules");
    if (!res.ok) throw new Error(`/api/modules -> ${res.status}`);
    const body = (await res.json()) as { modules?: ModuleManifestV2[] };
    const items = Array.isArray(body?.modules) ? body.modules : [];
    if (items.length === 0) throw new Error("empty registry");
    const mapped = items.map(toModuleManifest);
    warnOnDrift(mapped);
    writeCache(mapped);
    return mapped;
  } catch {
    return readCache() ?? MODULES;
  }
}

/**
 * Fetch the RAW v2 manifest for a single module id, with `uiMode` + `ui` +
 * `permissions` intact. Unlike getModules()/useModules() — which flatten v2 down
 * to the lossy shell ModuleManifest — this preserves everything the Data-mode
 * route (/m/[moduleId]) needs to render a UI Schema. `no-store` so a just-
 * installed module is visible without a redeploy. Returns null on any failure or
 * if the id isn't in the registry.
 */
export async function getModuleV2(id: string): Promise<ModuleManifestV2 | null> {
  try {
    const res = await fetch("/api/modules", { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { modules?: ModuleManifestV2[] };
    const items = Array.isArray(body?.modules) ? body.modules : [];
    return items.find((m) => m.id === id) ?? null;
  } catch {
    return null;
  }
}

/**
 * React hook: returns the static MODULES on the very first render (or the
 * localStorage-cached list if one exists), then swaps in the live registry
 * once getModules() resolves. FIRST PAINT ALWAYS EQUALS static MODULES on the
 * server and on a cold client — the cache only ever upgrades a warm client.
 */
export function useModules(): ModuleManifest[] {
  const [modules, setModules] = useState<ModuleManifest[]>(MODULES);

  useEffect(() => {
    let active = true;
    // Warm-client upgrade: prefer a cached list immediately (post-first-paint).
    const cached = readCache();
    if (cached && active) setModules(cached);
    getModules().then((live) => {
      if (active) setModules(live);
    });
    return () => {
      active = false;
    };
  }, []);

  return modules;
}
