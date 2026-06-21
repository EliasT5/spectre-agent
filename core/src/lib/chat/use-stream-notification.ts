"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Per-turn "notify me when done" using the existing Web Push pipeline:
 * service worker (`public/sw.js`) + VAPID + `/api/push/*` routes +
 * `src/lib/notify.ts` server-side sender.
 *
 * Click bell → ensure browser is subscribed (subscribe inline if not) →
 * POST /api/threads/{id}/notify-on-done to arm a one-shot flag in the
 * server's process-local broker. The streaming messages route consumes
 * that flag at the `done` event and calls `sendPush(...)`. The SW shows
 * the notification.
 *
 * Why Web Push and not the basic Notification API:
 *  - The SW handles `push` events even when the tab is closed or the
 *    user navigated away — the basic-API version we tried first only
 *    fired while the chat tab was alive.
 *  - Mobile actually works. iOS Safari and Android Chrome support Web
 *    Push when the page is installed as a PWA / `Notification.permission`
 *    has been granted.
 *
 * Subscription state persists across reloads (PushManager already has it).
 * `armed` is per-turn — disarms automatically when the server consumes
 * the flag in the `done` event.
 */

type SupportState = "checking" | "unsupported" | "subscribable";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(b64);
  return new Uint8Array(Array.from(raw, (c) => c.charCodeAt(0)));
}

export function useStreamNotification(threadId: string | null) {
  const [support, setSupport] = useState<SupportState>("checking");
  const [subscribed, setSubscribed] = useState(false);
  const [armed, setArmed] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    "unsupported",
  );

  // Detect support + existing subscription on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setSupport("unsupported");
      return;
    }
    setSupport("subscribable");
    setPermission(Notification.permission);
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setSubscribed(!!sub))
      .catch(() => setSubscribed(false));
  }, []);

  // The server clears its flag when the done event fires; mirror that
  // here when streaming ends. The component invokes onStreamEnd().
  const onStreamEnd = useCallback(() => setArmed(false), []);

  /** Ensure the browser is subscribed to push (subscribing inline if
   *  needed), then POST /api/threads/{id}/notify-on-done to arm the
   *  one-shot flag for this turn. Returns true on success. */
  const arm = useCallback(async (): Promise<boolean> => {
    if (!threadId || support !== "subscribable") return false;
    try {
      // Subscribe if we're not already.
      if (!subscribed) {
        const keyRes = await fetch("/api/push/vapid-public-key");
        if (!keyRes.ok) return false;
        const { key } = (await keyRes.json()) as { key: string };
        const reg = await navigator.serviceWorker.ready;
        const perm = await Notification.requestPermission();
        setPermission(perm);
        if (perm !== "granted") return false;
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key),
        });
        await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sub),
        });
        setSubscribed(true);
      }
      // Arm the server-side one-shot for this thread.
      const armRes = await fetch(`/api/threads/${threadId}/notify-on-done`, {
        method: "POST",
      });
      if (!armRes.ok) return false;
      setArmed(true);
      return true;
    } catch {
      return false;
    }
  }, [threadId, support, subscribed]);

  /** Disarm the server-side flag and the local UI state. User changed
   *  their mind mid-stream. */
  const disarm = useCallback(async () => {
    setArmed(false);
    if (!threadId) return;
    try {
      await fetch(`/api/threads/${threadId}/notify-on-done`, { method: "DELETE" });
    } catch {
      // best effort
    }
  }, [threadId]);

  return {
    /** "checking" briefly on mount, "unsupported" on iOS Safari outside
     *  PWA / browsers without SW + PushManager, "subscribable" otherwise. */
    support,
    /** Whether the browser is already subscribed to push (across all
     *  prior sessions). False until we either find a subscription or
     *  arm() subscribes inline. */
    subscribed,
    /** Notification.permission — "default" | "granted" | "denied" |
     *  "unsupported". UI hides the bell if "denied" so we don't tease
     *  something the browser will silently drop. */
    permission,
    /** True between arm() success and the next onStreamEnd() call. */
    armed,
    arm,
    disarm,
    onStreamEnd,
  };
}
