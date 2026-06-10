"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { motion } from "framer-motion";

// A bottom-left holographic plaque that tilts toward the cursor: RGB-split glow,
// cyan border, corner brackets, specular highlight, a Georgia "Spectre" wordmark
// and an optional mono credit line (set NEXT_PUBLIC_BUILT_BY to show one).
const HOLO_SHADOW =
  "-1px 0 0 rgba(255,80,120,0.40), 1px 0 0 rgba(110,220,255,0.45), 0 0 14px rgba(167,139,250,0.55), 0 0 24px rgba(126,237,255,0.30)";

// Optional per-install credit shown under the wordmark; empty (hidden) by default.
const BUILT_BY = process.env.NEXT_PUBLIC_BUILT_BY ?? "";

function Corner({ corner }: { corner: "tl" | "tr" | "bl" | "br" }) {
  const s: CSSProperties = { position: "absolute", width: 8, height: 8, opacity: 0.7 };
  const c = "#7eedff";
  if (corner === "tl") Object.assign(s, { left: 2, top: 8, borderLeft: `1px solid ${c}`, borderTop: `1px solid ${c}` });
  if (corner === "tr") Object.assign(s, { right: 2, top: 8, borderRight: `1px solid ${c}`, borderTop: `1px solid ${c}` });
  if (corner === "bl") Object.assign(s, { left: 2, bottom: 8, borderLeft: `1px solid ${c}`, borderBottom: `1px solid ${c}` });
  if (corner === "br") Object.assign(s, { right: 2, bottom: 8, borderRight: `1px solid ${c}`, borderBottom: `1px solid ${c}` });
  return <div style={s} aria-hidden />;
}

export function SpectrePlaque() {
  const ref = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = (e.clientX - cx) / 250;
      const dy = (e.clientY - cy) / 250;
      setTilt({ x: Math.max(-1.5, Math.min(1.5, dx)), y: Math.max(-1.5, Math.min(1.5, dy)) });
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.6, delay: 0.4 }}
      style={{ position: "fixed", bottom: 32, left: 32, zIndex: 20, userSelect: "none", perspective: 1000, pointerEvents: "none" }}
    >
      <div
        className="holo-scan"
        style={{
          position: "relative",
          padding: "16px 28px",
          transform: `rotateX(${-tilt.y * 7}deg) rotateY(${tilt.x * 7}deg)`,
          transformStyle: "preserve-3d",
          transition: "transform 220ms ease-out, box-shadow 220ms ease-out",
          background: "linear-gradient(135deg, rgba(15,28,55,0.55), rgba(8,10,24,0.88))",
          backdropFilter: "blur(10px) saturate(1.3)",
          WebkitBackdropFilter: "blur(10px) saturate(1.3)",
          border: "1px solid rgba(126,237,255,0.42)",
          borderRadius: 6,
          boxShadow: `0 8px 32px rgba(0,0,0,0.55), 0 0 22px rgba(126,237,255,0.22), inset 0 1px 0 rgba(196,232,255,0.40), ${tilt.x * 8}px ${tilt.y * 8}px 26px rgba(167,139,250,0.20)`,
        }}
      >
        <Corner corner="tl" />
        <Corner corner="tr" />
        <Corner corner="bl" />
        <Corner corner="br" />
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 6,
            pointerEvents: "none",
            background: `radial-gradient(circle at ${50 + tilt.x * 35}% ${50 + tilt.y * 35}%, rgba(255,255,255,0.20) 0%, transparent 60%)`,
            transition: "background 220ms ease-out",
          }}
        />
        <div
          style={{
            position: "relative",
            fontFamily: "Georgia, 'Cormorant Garamond', serif",
            fontSize: 28,
            lineHeight: 1,
            color: "#e0f7ff",
            textShadow: HOLO_SHADOW,
          }}
        >
          Spectre
        </div>
        {BUILT_BY ? (
          <div
            style={{
              position: "relative",
              marginTop: 6,
              fontSize: 9,
              textTransform: "uppercase",
              letterSpacing: "0.22em",
              fontFamily: "var(--font-mono)",
              color: "rgba(126,237,255,0.78)",
              textShadow: "0 0 10px rgba(126,237,255,0.4)",
            }}
          >
            {BUILT_BY}
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}
