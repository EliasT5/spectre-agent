// host-runtime — the trusted in-frame boot loader for a Code-mode module.
//
// Runs inside the opaque-origin (sandbox="allow-scripts") iframe. It NEVER
// fetches the module bundle itself (connect-src 'none' would forbid it anyway):
// the parent fetches + SRI-verifies the bundle, then posts the verified SOURCE
// in over a one-time handshake. This runtime:
//   1. announces readiness:  parent.postMessage({type:"spectre:ready"})
//   2. on the parent's {type:"spectre:init"} (with the transferred port + source
//      + tokens + css): applies the theme, builds the in-frame `spectre` shim
//      (RPC over the port), then blob:-imports the source and calls
//      mod.default(root, { spectre }).
//   3. live re-themes on {type:"spectre:theme"} (over the SAME port).
//   4. reports a mount failure to the parent as {type:"spectre:error"}.
//
// The `spectre` shim mirrors the read surface; every method is a request/reply
// over the MessagePort. The frame can NOT reach the network, the shell DOM, or
// the CORE_TOKEN — only this port, which the parent gates by the closed SDK
// allowlist. A module-backend call's id is ignored here (the parent forces it).

let bridgePort = null; // the MessagePort to the parent (set on init)
let rpcSeq = 0; // request id counter
const pending = new Map(); // id -> { resolve, reject, timer }
const RPC_TIMEOUT_MS = 15000;

// ── RPC over the port ────────────────────────────────────────────────────────
function rpc(kind, path, args) {
  return new Promise((resolve, reject) => {
    if (!bridgePort) {
      reject(new Error("bridge not connected"));
      return;
    }
    const id = ++rpcSeq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("rpc timeout"));
    }, RPC_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    bridgePort.postMessage({ type: "spectre:sdk", id, kind, path, args });
  });
}

function onPortMessage(ev) {
  const msg = ev.data;
  if (!msg || typeof msg !== "object") return;

  // Live re-theme can arrive over the same port.
  if (msg.type === "spectre:theme") {
    applyTokens(msg.tokens, undefined);
    return;
  }

  if (msg.type !== "spectre:sdk:reply") return;
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  clearTimeout(slot.timer);
  if (msg.error) slot.reject(new Error(msg.error));
  else slot.resolve(msg.result);
}

// ── the in-frame spectre shim (mirrors lib/sdk.ts read surface) ──────────────
const sdk = (path) => () => rpc("sdk", path, []);
const sdk1 = (path) => (q) => rpc("sdk", path, [q]);

const spectre = {
  monitor: sdk("monitor"),
  health: sdk("health"),
  usage: sdk("usage"),
  models: sdk("models"),
  schedules: sdk("schedules"),
  calendar: sdk("calendar"),
  skills: sdk("skills"),
  ingestHistory: sdk("ingestHistory"),
  memory: {
    search: sdk1("memory.search"),
    list: sdk("memory.list"),
    searchThreads: sdk1("memory.searchThreads"),
  },
  threads: {
    list: sdk("threads.list"),
  },
  // Self-scoped module backend. The id is IGNORED — the parent hard-binds this
  // module's own id on every call. `init` is sanitized by the parent.
  module: (_id) => ({
    call: (path, init) => rpc("module", path, [init]),
  }),
};

// ── theming ──────────────────────────────────────────────────────────────────
function applyTokens(tokens, css) {
  let styleEl = document.getElementById("spectre-tokens");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "spectre-tokens";
    document.head.appendChild(styleEl);
  }
  const decls = tokens
    ? Object.entries(tokens)
        .map(([k, v]) => `${k}: ${String(v)};`)
        .join(" ")
    : "";
  const reset =
    "* { box-sizing: border-box; }" +
    "html, body { margin: 0; background: var(--color-bg); color: var(--color-text);" +
    " font-family: var(--font-body, system-ui); }" +
    "#root { min-height: 100dvh; padding: 16px; }";
  // Keep any module css already injected (only refresh tokens + reset on theme).
  const moduleCss = css != null ? String(css) : moduleCssCache;
  if (css != null) moduleCssCache = css;
  styleEl.textContent = `:root { ${decls} } ${reset} ${moduleCss || ""}`;
}
let moduleCssCache = "";

// ── mount the untrusted module from verified source ──────────────────────────
async function mountModule(source) {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  let mod;
  try {
    mod = await import(/* webpackIgnore: true */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const mount = mod && mod.default;
  if (typeof mount !== "function") {
    throw new Error("module has no default export mount(root, ctx)");
  }
  const root = document.getElementById("root");
  // The module contract: default export is mount(root, ctx); ctx = { spectre }.
  // It may return a cleanup fn (ignored in P2d-1; the frame is torn down whole).
  await mount(root, { spectre });
}

// ── one-time init handshake from the parent ──────────────────────────────────
let initDone = false;
async function onWindowMessage(ev) {
  const msg = ev.data;
  if (!msg || typeof msg !== "object" || msg.type !== "spectre:init") return;
  if (initDone) return;
  initDone = true;
  window.removeEventListener("message", onWindowMessage);

  // Grab the transferred MessagePort — the ONLY channel to the parent.
  bridgePort = ev.ports && ev.ports[0];
  if (bridgePort) {
    bridgePort.onmessage = onPortMessage;
    bridgePort.start && bridgePort.start();
  }

  try {
    applyTokens(msg.tokens, msg.css);
    if (typeof msg.source !== "string") throw new Error("no module source");
    await mountModule(msg.source);
  } catch (e) {
    const message = e && e.message ? String(e.message) : "mount failed";
    parent.postMessage({ type: "spectre:error", message }, "*");
  }
}

window.addEventListener("message", onWindowMessage);

// Announce readiness — the parent verifies source/origin before transferring
// the port and posting init.
parent.postMessage({ type: "spectre:ready" }, "*");
