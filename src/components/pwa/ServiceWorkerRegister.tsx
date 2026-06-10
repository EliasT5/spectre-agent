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
    if (!window.isSecureContext) return;
    const register = () =>
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    // Defer past first paint so registration never competes with the live UI.
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
