"use client";

import { memo, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Html, Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { AdditiveBlending, CanvasTexture, Vector3, type Sprite, type SpriteMaterial, type Texture } from "three";
import type { Line2 } from "three-stdlib";
import { MiniBlob } from "./MiniBlob";
import type { Blob } from "@/lib/blob-layout";

// A soft radial-gradient texture, white so the sprite's `color` can tint it to
// any blob hue. Built once, lazily, on the client (guarded for SSR). Used by the
// hover halo — a camera-facing additive sprite, NOT a fresnel shell: the old
// shell drew "weird circles" at rest and its onBeforeCompile shader crashed the
// GL program, so this stays a plain Sprite that's invisible until hover.
let _haloTex: Texture | null = null;
function haloTexture(): Texture | null {
  if (_haloTex) return _haloTex;
  if (typeof document === "undefined") return null;
  const s = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.4, "rgba(255,255,255,0.4)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  _haloTex = new CanvasTexture(cv);
  _haloTex.needsUpdate = true;
  return _haloTex;
}

/**
 * The hover halo for an outer-view blob — a colored bloom that lights up only
 * while the blob is hovered and fades back to nothing at rest. Opacity + scale
 * ease in/out each frame off `hoverRef`, so there's never a halo at rest.
 */
function HoverHalo({ color, hoverRef }: { color: string; hoverRef: MutableRefObject<boolean> }) {
  const sprRef = useRef<Sprite>(null);
  const matRef = useRef<SpriteMaterial>(null);
  const opRef = useRef(0);
  const tex = useMemo(() => haloTexture(), []);
  useFrame((_, delta) => {
    const target = hoverRef.current ? 0.6 : 0;
    opRef.current += (target - opRef.current) * Math.min(1, delta * 8);
    if (matRef.current) matRef.current.opacity = opRef.current;
    if (sprRef.current) sprRef.current.scale.setScalar(1.9 + 0.5 * opRef.current);
  });
  if (!tex) return null;
  return (
    <sprite ref={sprRef} scale={1.9}>
      <spriteMaterial
        ref={matRef}
        map={tex}
        color={color}
        transparent
        opacity={0}
        depthWrite={false}
        blending={AdditiveBlending}
        toneMapped={false}
      />
    </sprite>
  );
}

/**
 * Connecting strands between the surrounding blobs — the same graph threads the
 * slot icons have between them. A woven polyline through the nodes, gently
 * pulsing. Only shown in the outer constellation view.
 */
export function Strands({ positions }: { positions: Vector3[] }) {
  const ref = useRef<Line2>(null);
  const points = useMemo(
    () => (positions.length > 1 ? [...positions, positions[0]] : []),
    [positions],
  );
  useFrame(({ clock }) => {
    if (ref.current) ref.current.material.opacity = 0.16 + 0.12 * Math.sin(clock.elapsedTime * 1.1);
  });
  if (points.length < 2) return null;
  return (
    <Line ref={ref} points={points} color="#818cf8" lineWidth={1} transparent opacity={0.22} toneMapped={false} />
  );
}

/**
 * One non-active blob, sitting at its fixed position in space, in its actual
 * voxel form (a tinted mini-swarm + colored core). It only becomes
 * clickable/hoverable in the outer constellation view (`interactive`); hovering
 * there lights a soft colored halo (the additive `HoverHalo` sprite). Click it
 * and the camera travels there. The active blob is the full swarm; everything
 * else is one of these.
 */
export const ConstellationBlob = memo(function ConstellationBlob({
  blob,
  color,
  position,
  interactive,
  wasDragRef,
  onSelect,
}: {
  blob: Blob;
  color: string;
  position: Vector3;
  interactive: boolean;
  wasDragRef?: MutableRefObject<boolean>;
  onSelect: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const hoverRef = useRef(false);
  const setHover = (v: boolean) => {
    hoverRef.current = v;
    setHovered(v);
  };
  // Leaving the outer view drops any hover (and its glow).
  useEffect(() => {
    if (!interactive) {
      setHover(false);
      document.body.style.cursor = "";
    }
  }, [interactive]);

  return (
    <group position={position}>
      {/* invisible pickable bounds — only in the outer view */}
      {interactive && (
        <mesh
          onPointerOver={(e) => {
            e.stopPropagation();
            setHover(true);
            document.body.style.cursor = "pointer";
          }}
          onPointerOut={() => {
            setHover(false);
            document.body.style.cursor = "";
          }}
          onClick={(e) => {
            e.stopPropagation();
            if (wasDragRef?.current) return; // an orbit-drag, not a pick
            onSelect(blob.id);
          }}
        >
          <sphereGeometry args={[0.78, 16, 16]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}

      {interactive && <HoverHalo color={color} hoverRef={hoverRef} />}
      <MiniBlob color={color} hoverRef={hoverRef} />

      <Html position={[0, -0.95, 0]} center pointerEvents="none">
        <div
          style={{
            fontFamily: "var(--font-mono), ui-monospace, monospace",
            fontSize: 11,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: hovered ? "#fff" : "rgba(238,238,240,0.7)",
            whiteSpace: "nowrap",
            textShadow: hovered ? `0 0 14px ${color}` : "0 1px 3px rgba(0,0,0,0.7)",
            transition: "color 0.2s, text-shadow 0.2s",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, boxShadow: `0 0 8px ${color}` }} />
          {blob.label}
          <span style={{ opacity: 0.5 }}>· {blob.slots.length}</span>
        </div>
      </Html>
    </group>
  );
});
