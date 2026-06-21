"use client";

/**
 * ModuleFrame — the host for a Code-mode module.
 *
 * A Code-mode module ships UNTRUSTED JS. This component runs it under a strict
 * isolation pipeline:
 *
 *  1. The bundle is FETCHED AS TEXT by the parent (this React tree), SHA-384
 *     SRI-verified against the manifest, and ONLY THEN posted into the frame.
 *     It is NEVER a <script src> on the shell page and NEVER imported into the
 *     shell React tree — if it executed on the shell origin the sandbox would be
 *     defeated. Inside the frame it is `blob:`-imported (see host-runtime.js).
 *  2. The iframe is `sandbox="allow-scripts"` ONLY (→ opaque "null" origin),
 *     `allow=""`, referrerPolicy="no-referrer". The /sandbox/* docs carry a
 *     locked CSP (next.config headers) — that, not auth, is what secures them.
 *  3. The bridge runs over a dedicated MessageChannel. The ONLY window-level
 *     listener is the one-time handshake, which verifies
 *     event.source === frame.contentWindow AND event.origin === "null" before
 *     transferring the port. All SDK traffic is over the port (module-bridge).
 *  4. Theme: the host tokens are read live and posted in; a debounced
 *     MutationObserver re-posts them on theme/class changes (over the port).
 *
 * Lifecycle is one effect: fetch+verify → handshake → init → watchdog → observe,
 * with full teardown on unmount.
 */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type {
  ModuleManifestV2,
  ModulePermissions,
  ModuleUiCode,
} from "@/lib/module-manifest";
import { readTokens } from "@/lib/tokens";
import { mountBridge } from "./module-bridge";
import { ErrorState } from "./kit";

// The frame document is served by a route handler (not the static .html) so it
// can carry a per-request CSP nonce — required because the opaque-origin frame
// can't authorize the host-runtime script via 'self'. See app/sandbox/host.
const SANDBOX_DOC = "/sandbox/host";
const READY_TIMEOUT_MS = 8000;
const THEME_DEBOUNCE_MS = 120;

/** Narrow the opaque `ui` field to a Code-mode bundle descriptor, if present. */
function readCode(ui: unknown): ModuleUiCode | null {
  if (!ui || typeof ui !== "object") return null;
  const code = (ui as { code?: unknown }).code;
  if (!code || typeof code !== "object") return null;
  const entry = (code as { entry?: unknown }).entry;
  if (typeof entry !== "string" || !entry) return null;
  const css = (code as { css?: unknown }).css;
  const integrity = (code as { integrity?: unknown }).integrity;
  return {
    entry,
    css: typeof css === "string" ? css : undefined,
    integrity: typeof integrity === "string" ? integrity : undefined,
  };
}

/** base64 of an ArrayBuffer (for SRI comparison). */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Fetch the entry bundle AS TEXT and, if the manifest declares `integrity`,
 * verify SHA-384 over the bytes BEFORE returning. Throws on any mismatch — the
 * caller must never post unverified source into the frame.
 */
async function fetchVerifiedBundle(code: ModuleUiCode): Promise<string> {
  const res = await fetch(code.entry, { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) throw new Error(`bundle ${code.entry} -> ${res.status}`);
  const source = await res.text();

  if (code.integrity) {
    const m = /^sha384-(.+)$/.exec(code.integrity.trim());
    if (!m) throw new Error("bad integrity format");
    const expected = m[1];
    const digest = await crypto.subtle.digest("SHA-384", new TextEncoder().encode(source));
    const actual = toBase64(digest);
    if (actual !== expected) throw new Error("integrity_mismatch");
  }
  return source;
}

const FRAME_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  width: "100%",
  height: "100%",
  border: "none",
  background: "var(--color-bg)",
  zIndex: 1,
};

const OVERLAY_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 2,
  display: "grid",
  placeItems: "center",
  background: "var(--color-bg)",
  pointerEvents: "none",
};

const ERROR_WRAP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 3,
  display: "grid",
  placeItems: "center",
  padding: 24,
  background: "var(--color-bg)",
};

export function ModuleFrame({
  moduleId,
  manifest,
  permissions,
}: {
  moduleId: string;
  manifest: ModuleManifestV2;
  permissions: ModulePermissions;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const code = readCode(manifest.ui);

  useEffect(() => {
    if (!code) {
      setError("This module declares uiMode “code” but carries no ui.code bundle.");
      return;
    }
    const frame = frameRef.current;
    if (!frame) return;

    let cancelled = false;
    let channel: MessageChannel | null = null;
    let bridgeCleanup: (() => void) | null = null;
    let observer: MutationObserver | null = null;
    let themeTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let frameReady = false; // the frame sent spectre:ready
    let initSent = false; // we've transferred the port + posted init

    // holds the verified source between fetch and handshake
    const verifiedSourceRef = { current: null as string | null };

    // Fail closed: any error shows an ErrorState and we never post source.
    const fail = (msg: string) => {
      if (cancelled) return;
      setError(msg);
    };

    // Fire the init exactly once, when BOTH the frame is ready AND the bundle is
    // fetched+SRI-verified. Their ordering is a race — this gates on both.
    const initIfReady = () => {
      if (cancelled || initSent) return;
      const source = verifiedSourceRef.current;
      if (!frameReady || source == null) return;
      initSent = true;

      channel = new MessageChannel();
      bridgeCleanup = mountBridge({
        frame,
        port: channel.port1,
        moduleId,
        permissions,
      });

      frame.contentWindow?.postMessage(
        {
          type: "spectre:init",
          tokens: readTokens(),
          css: code.css,
          source,
          moduleId,
        },
        "*",
        [channel.port2],
      );

      // (c) watchdog cleared — the frame answered and the module is initializing.
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
      if (!cancelled) setReady(true);

      // (d) re-theme: debounced MutationObserver on the document root.
      observer = new MutationObserver(() => {
        if (themeTimer) clearTimeout(themeTimer);
        themeTimer = setTimeout(() => {
          channel?.port1.postMessage({ type: "spectre:theme", tokens: readTokens() });
        }, THEME_DEBOUNCE_MS);
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["style", "class"],
      });
    };

    // ── (b) one-time handshake + frame-error channel ──
    const onWindowMessage = (ev: MessageEvent) => {
      const data = ev.data as { type?: string; message?: string } | undefined;
      if (!data) return;

      // Only ever trust messages from THIS frame, on the OPAQUE origin.
      if (ev.source !== frame.contentWindow || ev.origin !== "null") return;

      if (data.type === "spectre:error") {
        fail(data.message ? `module error: ${data.message}` : "module error");
        return;
      }

      if (data.type !== "spectre:ready" || frameReady) return;
      frameReady = true;
      window.removeEventListener("message", onWindowMessage);
      initIfReady();
    };

    window.addEventListener("message", onWindowMessage);

    // (c) watchdog: no handshake within READY_TIMEOUT_MS → unresponsive.
    watchdog = setTimeout(() => {
      if (!frameReady) fail("module unresponsive");
    }, READY_TIMEOUT_MS);

    // ── (a) fetch + SRI-verify the bundle, THEN allow init to post it ──
    void (async () => {
      try {
        const source = await fetchVerifiedBundle(code);
        if (cancelled) return;
        verifiedSourceRef.current = source;
        initIfReady();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "bundle load failed";
        fail(msg === "integrity_mismatch" ? "integrity check failed" : msg);
      }
    })();

    // ── (e) teardown ──
    return () => {
      cancelled = true;
      window.removeEventListener("message", onWindowMessage);
      if (observer) observer.disconnect();
      if (themeTimer) clearTimeout(themeTimer);
      if (watchdog) clearTimeout(watchdog);
      if (bridgeCleanup) bridgeCleanup();
      if (channel) {
        try {
          channel.port1.close();
        } catch {
          /* already closed */
        }
      }
    };
    // moduleId/manifest/permissions are stable for the life of the route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleId]);

  if (error) {
    return (
      <div style={ERROR_WRAP_STYLE}>
        <ErrorState>{error}</ErrorState>
      </div>
    );
  }

  return (
    <>
      <iframe
        ref={frameRef}
        src={SANDBOX_DOC}
        sandbox="allow-scripts"
        allow=""
        referrerPolicy="no-referrer"
        title={manifest.label}
        style={FRAME_STYLE}
      />
      {!ready && (
        <div style={OVERLAY_STYLE} aria-hidden>
          <span className="label">loading module…</span>
        </div>
      )}
    </>
  );
}
