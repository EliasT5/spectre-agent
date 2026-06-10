"use client";

import { useRouter } from "next/navigation";

/**
 * The recover tile shown by a route's error boundary. A crash in one slot (a
 * tab, or the WebGL blob) renders this instead of white-screening the whole
 * shell — the user can retry or fly back to the blob. This is the resilience
 * floor for "users can modify their own UI": a broken piece is contained.
 */
export function ErrorTile({
  error,
  reset,
  scope,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  scope?: string;
}) {
  const router = useRouter();
  return (
    <div className="error-tile">
      <div className="error-card">
        <div className="error-title">{scope ? `${scope} hit a snag` : "Something broke"}</div>
        <div className="error-msg">{error?.message || "Unexpected error."}</div>
        <div className="error-actions">
          <button onClick={() => reset()}>Retry</button>
          <button className="ghost" onClick={() => router.push("/")}>← Spectre</button>
        </div>
      </div>
    </div>
  );
}
