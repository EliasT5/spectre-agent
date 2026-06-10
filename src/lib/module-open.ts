/**
 * Tab-open behavior. Clicking a module in the blob can open it in the SAME
 * window (navigate), a NEW window, or ASK each time (with an optional per-module
 * "remember"). Configured in Settings; stored in localStorage. The 'ask' flow
 * uses a tiny pub/sub that the global <ModuleOpenPrompt> subscribes to, so the
 * R3F scene can stay decoupled from the DOM prompt.
 */

export type OpenMode = "same" | "new";
export type OpenDefault = OpenMode | "ask";

const LS = "spectre.moduleOpen";

interface Store {
  global?: OpenDefault;
  overrides?: Record<string, OpenMode>;
}

function read(): Store {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(LS) || "{}") as Store;
  } catch {
    return {};
  }
}
function write(s: Store) {
  try {
    localStorage.setItem(LS, JSON.stringify(s));
  } catch {
    /* private mode / quota — non-fatal */
  }
}

export function getGlobalMode(): OpenDefault {
  return read().global ?? "ask";
}
export function setGlobalMode(m: OpenDefault) {
  const s = read();
  s.global = m;
  write(s);
}
export function getOverride(id: string): OpenMode | undefined {
  return read().overrides?.[id];
}
export function setOverride(id: string, m: OpenMode) {
  const s = read();
  s.overrides = { ...s.overrides, [id]: m };
  write(s);
}
export function clearOverrides() {
  const s = read();
  delete s.overrides;
  write(s);
}
export function overrideCount(): number {
  return Object.keys(read().overrides ?? {}).length;
}

/** Derive a stable module id from a slot route (/m/<id> or a builtin like /chat). */
export function moduleIdFromRoute(route: string): string {
  if (route.startsWith("/m/")) return route.split("/")[2] || route;
  return route.replace(/^\//, "") || "home";
}

/**
 * Open a route as a separate APP WINDOW (a new window, not a browser tab).
 * Spectre is meant to behave like a webapp: passing window features (size +
 * popup) makes the browser spawn a standalone window instead of a tab, and in
 * an installed PWA this opens a fresh standalone app instance. Each call is a
 * new window (target "_blank", no shared name).
 */
export function openNewWindow(route: string) {
  if (typeof window === "undefined") return;
  const aw = window.screen?.availWidth ?? 1440;
  const ah = window.screen?.availHeight ?? 900;
  const w = Math.min(1400, Math.round(aw * 0.9));
  const h = Math.min(900, Math.round(ah * 0.9));
  const left = Math.max(0, Math.round((aw - w) / 2));
  const top = Math.max(0, Math.round((ah - h) / 2));
  window.open(
    route,
    "_blank",
    `popup=yes,noopener,width=${w},height=${h},left=${left},top=${top}`,
  );
}

// ── 'ask' prompt pub/sub ────────────────────────────────────────────────────
export interface AskRequest {
  route: string;
  moduleId: string;
  /** Resolve with the chosen mode (null = cancelled) and whether to remember it. */
  decide: (mode: OpenMode | null, remember: boolean) => void;
}
type AskListener = (req: AskRequest) => void;
const listeners = new Set<AskListener>();
export function onAsk(fn: AskListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Resolve how to open `route`: per-module override wins, then the global default;
 * 'ask' shows the prompt (and falls back to 'same' if no prompt is mounted).
 * Returns the concrete mode, or null if the user cancelled an 'ask'.
 */
export async function resolveOpen(route: string): Promise<OpenMode | null> {
  const id = moduleIdFromRoute(route);
  const ov = getOverride(id);
  if (ov) return ov;
  const g = getGlobalMode();
  if (g !== "ask") return g;
  if (listeners.size === 0) return "same";
  return new Promise<OpenMode | null>((resolve) => {
    const req: AskRequest = {
      route,
      moduleId: id,
      decide: (mode, remember) => {
        if (mode && remember) setOverride(id, mode);
        resolve(mode);
      },
    };
    listeners.forEach((fn) => fn(req));
  });
}
