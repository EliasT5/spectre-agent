// demo-sandbox — the UNTRUSTED vanilla-JS Code-mode demo (P2d-1).
//
// This is "third-party" module code. It runs inside the opaque-origin sandbox,
// themed by the host's tokens, and may ONLY reach the core through the bridged
// `spectre` SDK (read-only, permission-gated). It is pure DOM — no React, no
// kit. The contract: default export is mount(root, ctx); ctx = { spectre }. It
// may return a cleanup fn.

export default function mount(root, { spectre }) {
  root.innerHTML = "";

  const card = document.createElement("div");
  card.style.cssText = [
    "max-width: 560px",
    "margin: 0 auto",
    "padding: 20px 22px",
    "border: 1px solid var(--color-border, rgba(255,255,255,0.08))",
    "border-radius: var(--r-lg, 18px)",
    "background: var(--glass-2, var(--color-surface, #0f0f1a))",
    "box-shadow: var(--glow-soft, 0 12px 48px rgba(0,0,0,0.35))",
    "display: flex",
    "flex-direction: column",
    "gap: 14px",
  ].join(";");

  const eyebrow = document.createElement("div");
  eyebrow.textContent = "MODULE · CODE · SANDBOXED";
  eyebrow.style.cssText = [
    "font-family: var(--font-mono, ui-monospace, monospace)",
    "font-size: 10px",
    "letter-spacing: 0.14em",
    "text-transform: uppercase",
    "color: var(--color-text-muted, #8888a0)",
  ].join(";");

  const title = document.createElement("h1");
  title.textContent = "Sandbox demo";
  title.style.cssText = [
    "margin: 0",
    "font-family: var(--font-display, system-ui)",
    "font-size: 26px",
    "font-weight: 600",
    "color: var(--color-text, #eeeef0)",
  ].join(";");

  // ── tap counter ──
  const btn = document.createElement("button");
  let count = 0;
  const renderBtn = () => {
    btn.textContent = `Tap me · ${count}`;
  };
  btn.style.cssText = [
    "align-self: flex-start",
    "cursor: pointer",
    "font-family: var(--font-display, system-ui)",
    "font-size: 13px",
    "font-weight: 600",
    "color: #fff",
    "border: none",
    "border-radius: var(--r-sm, 9px)",
    "padding: 0 18px",
    "height: 40px",
    "background: var(--color-accent, #6366f1)",
    "box-shadow: var(--glow-sm, 0 0 16px rgba(99,102,241,0.4))",
  ].join(";");
  renderBtn();
  const onClick = () => {
    count += 1;
    renderBtn();
  };
  btn.addEventListener("click", onClick);

  // ── live readings panel ──
  const readout = document.createElement("dl");
  readout.style.cssText = [
    "display: grid",
    "grid-template-columns: auto 1fr",
    "gap: 6px 16px",
    "margin: 0",
    "font-family: var(--font-mono, ui-monospace, monospace)",
    "font-size: 12px",
  ].join(";");

  const errLine = document.createElement("div");
  errLine.style.cssText = [
    "font-family: var(--font-mono, ui-monospace, monospace)",
    "font-size: 12px",
    "color: var(--color-error, #ef4444)",
    "min-height: 16px",
  ].join(";");

  function addRow(key, value) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    dt.style.cssText = "color: var(--color-text-muted, #8888a0); letter-spacing: 0.04em;";
    const dd = document.createElement("dd");
    dd.textContent = value;
    dd.style.cssText = "margin: 0; color: var(--color-text-secondary, #c8c8d0); text-align: right;";
    readout.appendChild(dt);
    readout.appendChild(dd);
  }

  card.appendChild(eyebrow);
  card.appendChild(title);
  card.appendChild(btn);
  card.appendChild(readout);
  card.appendChild(errLine);
  root.appendChild(card);

  // ── pull two live readings through the bridged SDK ──
  (async () => {
    try {
      const health = await spectre.health();
      addRow("core", health && health.name ? String(health.name) : "—");
      addRow(
        "api version",
        health && health.coreApiVersion != null ? String(health.coreApiVersion) : "—",
      );
    } catch (e) {
      errLine.textContent = `health failed: ${e && e.message ? e.message : "error"}`;
    }

    try {
      const monitor = await spectre.monitor();
      const summary = (monitor && monitor.summary) || {};
      addRow("criticals", String(summary.criticals != null ? summary.criticals : 0));
      addRow("warnings", String(summary.warnings != null ? summary.warnings : 0));
    } catch (e) {
      errLine.textContent = `monitor failed: ${e && e.message ? e.message : "error"}`;
    }
  })();

  // Cleanup contract: detach listeners on unmount.
  return () => {
    btn.removeEventListener("click", onClick);
  };
}
