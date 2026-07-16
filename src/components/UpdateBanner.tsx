"use client";

/**
 * Global "update available" banner. Polls the core's /api/update/status (which
 * compares the running image's baked git SHA against origin/main via the GitHub
 * API) and shows a dismissible bar when a newer Spectre version is on GitHub.
 * Applying stays a host action — a container can't rebuild itself — so the banner
 * tells the user the command to run. Dismissal is remembered per target SHA, so
 * it reappears when a NEWER version lands.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { call } from "@/lib/sdk";

interface UpdateStatus {
  runningSha: string | null;
  latestSha: string | null;
  updateAvailable: boolean;
}

const DISMISS_KEY = "spectre-update-dismissed";

export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY));
    } catch {
      /* no storage */
    }
  }, []);

  const check = useCallback(async () => {
    try {
      const s = await call<UpdateStatus>("/update/status");
      setStatus(s);
    } catch {
      /* fail-soft: no banner on a failed check */
    }
  }, []);

  // Check on mount, when the tab regains focus (e.g. after running --apply), and
  // every 10 min. Each check hits the GitHub API server-side, so keep it gentle.
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

  if (!status?.updateAvailable || !status.latestSha) return null;
  if (dismissed && status.latestSha.startsWith(dismissed)) return null;

  const dismiss = () => {
    const sha = status.latestSha!;
    try {
      localStorage.setItem(DISMISS_KEY, sha);
    } catch {
      /* ignore */
    }
    setDismissed(sha);
  };

  const from = status.runningSha ? status.runningSha.slice(0, 7) : "?";
  const to = status.latestSha.slice(0, 7);

  return (
    <div className="update-banner" role="status">
      <RefreshCw size={14} className="update-banner-icon" aria-hidden />
      <span className="update-banner-text">
        A new Spectre version is available ({from} → {to}). Run{" "}
        <code>scripts/spectre-update.sh --apply</code> on the host to update.
      </span>
      <button className="update-banner-close" onClick={dismiss} aria-label="Dismiss update notice">
        <X size={14} />
      </button>
    </div>
  );
}
