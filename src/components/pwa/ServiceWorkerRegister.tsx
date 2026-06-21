"use client";

import { useEffect } from "react";

/**
 * Registers the service worker (installability + offline shell). Mounted once in
 * the root layout; renders nothing. Registration only runs in the browser, over
 * a secure context (https or localhost) — exactly the contexts where the PIN
 * cookie's Secure flag also works, so it never fights the auth gate.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    // In dev the caching SW serves stale bundles, so code changes look like they
    // did nothing. Never register it in dev, and actively unregister any SW a
    // prior run left behind so a refresh always shows the live code.
    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker
        .getRegistrations?.()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
      return;
    }
    if (!window.isSecureContext) return;
    const register = () =>
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    // Defer past first paint so registration never competes with the live UI.
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
