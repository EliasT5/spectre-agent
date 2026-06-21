"use client";

import { useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useDevice } from "@/lib/device-context";

/**
 * Top-left "Spectre" mark present in every tab — flies back to the blob home.
 *
 * Styled to match the monolith's signature Spectre plaque (see SpectrePlaque):
 * dark glass gradient, cyan (#7eedff) hairline + corner brackets, a specular
 * sheen, and the Georgia "Spectre" wordmark with the RGB-split holographic glow —
 * but compact and clickable (the universal escape hatch from any module).
 */

const HOLO_SHADOW =
  "-1px 0 0 rgba(255,80,120,0.40), 1px 0 0 rgba(110,220,255,0.45)," +
  " 0 0 14px rgba(167,139,250,0.55), 0 0 24px rgba(126,237,255,0.30)";
const CYAN = "#7eedff";

function Corner({ corner }: { corner: "tl" | "tr" | "bl" | "br" }) {
  const s: CSSProperties = { position: "absolute", width: 7, height: 7, opacity: 0.75, pointerEvents: "none" };
  if (corner === "tl") Object.assign(s, { left: 3, top: 3, borderLeft: `1px solid ${CYAN}`, borderTop: `1px solid ${CYAN}` });
  if (corner === "tr") Object.assign(s, { right: 3, top: 3, borderRight: `1px solid ${CYAN}`, borderTop: `1px solid ${CYAN}` });
  if (corner === "bl") Object.assign(s, { left: 3, bottom: 3, borderLeft: `1px solid ${CYAN}`, borderBottom: `1px solid ${CYAN}` });
  if (corner === "br") Object.assign(s, { right: 3, bottom: 3, borderRight: `1px solid ${CYAN}`, borderBottom: `1px solid ${CYAN}` });
  return <span style={s} aria-hidden />;
}

export function SpectreBackButton() {
  const device = useDevice();
  const router = useRouter();
  const [hover, setHover] = useState(false);

  // Desktop has the persistent sidebar (logo + Home link) -- the floating
  // back-to-home mark is redundant there. Keep it on mobile (the escape hatch).
  if (device === "desktop") return null;

  return (
    <button
      type="button"
      onClick={() => router.push("/")}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label="Back to Spectre"
      style={{
        position: "fixed",
        top: 16,
        left: 16,
        zIndex: 50,
        cursor: "pointer",
        padding: "9px 18px",
        borderRadius: 6,
        border: `1px solid ${hover ? "rgba(126,237,255,0.70)" : "rgba(126,237,255,0.42)"}`,
        background: "linear-gradient(135deg, rgba(15,28,55,0.55), rgba(8,10,24,0.88))",
        backdropFilter: "blur(10px) saturate(1.3)",
        WebkitBackdropFilter: "blur(10px) saturate(1.3)",
        boxShadow: hover
          ? "0 10px 36px rgba(0,0,0,0.55), 0 0 30px rgba(126,237,255,0.34), inset 0 1px 0 rgba(196,232,255,0.45)"
          : "0 8px 32px rgba(0,0,0,0.55), 0 0 22px rgba(126,237,255,0.22), inset 0 1px 0 rgba(196,232,255,0.40)",
        fontFamily: "Georgia, 'Cormorant Garamond', serif",
        fontSize: 18,
        lineHeight: 1,
        color: "#e0f7ff",
        textShadow: HOLO_SHADOW,
        transform: hover ? "translateY(-1px)" : "none",
        transition: "border-color 200ms ease-out, box-shadow 200ms ease-out, transform 200ms ease-out",
      }}
    >
      {/* specular sheen */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 6,
          pointerEvents: "none",
          background: "radial-gradient(circle at 50% 30%, rgba(255,255,255,0.18) 0%, transparent 62%)",
        }}
      />
      <Corner corner="tl" />
      <Corner corner="tr" />
      <Corner corner="bl" />
      <Corner corner="br" />
      <span style={{ position: "relative" }}>Spectre</span>
    </button>
  );
}
