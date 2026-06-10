"use client";

// Last-resort boundary: catches a crash in the root layout itself, so it must
// render its own <html>/<body>. Self-contained (no router/components — those
// may be what failed).
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          background: "#070711",
          color: "#e7e7f5",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: 420, padding: 24 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Spectre&apos;s shell crashed</div>
          <div style={{ opacity: 0.6, fontSize: 14, marginBottom: 16 }}>{error?.message || "Unexpected error."}</div>
          <button
            onClick={() => reset()}
            style={{ background: "#8b5cf6", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", cursor: "pointer", marginRight: 8 }}
          >
            Reload
          </button>
          <a href="/" style={{ color: "#8b5cf6" }}>Home</a>
        </div>
      </body>
    </html>
  );
}
