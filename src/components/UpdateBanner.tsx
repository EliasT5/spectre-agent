"use client";

/**
 * Global "update available" banner. Polls the core's /api/update/status (which
 * compares the running image's baked git SHA against origin/main via the GitHub
 * API) and shows a bar when a newer Spectre version is on GitHub.
 *
 * ONE-CLICK: when the updater sidecar is enabled (compose `update` profile), the
 * "Update now" button POSTs /api/update/apply and polls /api/update/apply/status
 * for live progress — no terminal. If the sidecar is off, it falls back to showing
 * the host command. "Mute 1w" silences server-side reminders; ✕ dismisses per SHA.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, X, Loader2 } from "lucide-react";
import { call } from "@/lib/sdk";

interface UpdateStatus {
  runningSha: string | null;
  latestSha: string | null;
  updateAvailable: boolean;
}
interface ApplyStatus {
  enabled?: boolean;
  state?: string; // "idle" | "running" | "unavailable" | "unknown"
  exitCode?: number | null;
  log?: string[];
}

const DISMISS_KEY = "spectre-update-dismissed";

export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null); // one-click available?
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY));
    } catch {
      /* no storage */
    }
  }, []);

  const check = useCallback(async () => {
    try {
      setStatus(await call<UpdateStatus>("/update/status"));
    } catch {
      /* fail-soft */
    }
  }, []);

  useEffect(() => {
    void check();
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    const id = setInterval(() => void check(), 10 * 60 * 1000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(id);
    };
  }, [check]);

  // Probe whether one-click updates are available (updater sidecar running).
  useEffect(() => {
    (async () => {
      try {
        const s = await call<ApplyStatus>("/update/apply/status");
        setEnabled(!!s.enabled);
        if (s.state === "running") {
          setApplying(true);
          startPolling();
        }
      } catch {
        setEnabled(false);
      }
    })();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    let sawRunning = false;
    pollRef.current = setInterval(async () => {
      try {
        const s = await call<ApplyStatus>("/update/apply/status");
        if (s.state === "running") {
          sawRunning = true;
          const tail = s.log?.length ? s.log[s.log.length - 1] : "";
          setProgress(tail || "Updating…");
        } else if (sawRunning) {
          if (pollRef.current) clearInterval(pollRef.current);
          if (s.exitCode === 0) {
            setProgress("Updated ✓ — reloading…");
            setTimeout(() => window.location.reload(), 1500);
          } else {
            setProgress(`Update failed (exit ${s.exitCode ?? "?"}). Check the update chat.`);
            setApplying(false);
          }
        }
      } catch {
        // The shell is likely restarting near the end of the update — keep polling;
        // when it's back, either the done-state reloads us or the user refreshes.
        setProgress("Updating… (the app is restarting)");
      }
    }, 3000);
  }

  const applyNow = async () => {
    setApplying(true);
    setProgress("Starting the update…");
    try {
      await call("/update/apply", { method: "POST", body: JSON.stringify({ target: "both" }) });
    } catch {
      // 503 (updater off) or error → fall back to the command.
      setApplying(false);
      setEnabled(false);
      return;
    }
    startPolling();
  };

  if (!status?.updateAvailable || !status.latestSha) return null;
  // While applying, always show progress (ignore the per-SHA dismiss).
  if (!applying && dismissed && status.latestSha.startsWith(dismissed)) return null;

  const dismiss = () => {
    const sha = status.latestSha!;
    try {
      localStorage.setItem(DISMISS_KEY, sha);
    } catch {
      /* ignore */
    }
    setDismissed(sha);
  };

  const mute = async () => {
    const muteForMs = 7 * 24 * 3600 * 1000;
    const put = (target: "core" | "shell") =>
      call("/update/reminders", { method: "PUT", body: JSON.stringify({ target, muteForMs }) }).catch(() => {});
    await Promise.all([put("core"), put("shell")]);
    dismiss();
  };

  if (applying) {
    return (
      <div className="update-banner" role="status">
        <Loader2 size={14} className="update-banner-icon update-banner-spin" aria-hidden />
        <span className="update-banner-text">{progress || "Updating Spectre…"}</span>
      </div>
    );
  }

  const from = status.runningSha ? status.runningSha.slice(0, 7) : "?";
  const to = status.latestSha.slice(0, 7);

  return (
    <div className="update-banner" role="status">
      <RefreshCw size={14} className="update-banner-icon" aria-hidden />
      <span className="update-banner-text">
        A new Spectre version is available ({from} → {to}).
        {enabled === false && (
          <>
            {" "}
            Run <code>scripts/spectre-update.sh --apply</code> on the host to update.
          </>
        )}
      </span>
      {enabled !== false && (
        <button
          className="update-banner-apply"
          onClick={() => void applyNow()}
          title="Update Spectre now"
        >
          Update now
        </button>
      )}
      <button
        className="update-banner-mute"
        onClick={() => void mute()}
        aria-label="Mute update reminders for a week"
        title="Mute update reminders for a week"
      >
        Mute 1w
      </button>
      <button className="update-banner-close" onClick={dismiss} aria-label="Dismiss update notice">
        <X size={14} />
      </button>
    </div>
  );
}
