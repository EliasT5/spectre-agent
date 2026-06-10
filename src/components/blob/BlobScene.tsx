"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { TrackballControls } from "@react-three/drei";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { resolveOpen, openNewWindow } from "@/lib/module-open";
import { Vector3, type PerspectiveCamera } from "three";

import { Blob } from "./Blob";
import { Nodes } from "./Nodes";
import { Atmosphere } from "./atmosphere";
import { ConstellationBlob, Strands } from "./Constellation";
import { CustomizeSlots } from "./CustomizeSlots";
import { blobColor, ensurePlaced, loadLayout, saveLayout, type BlobLayout } from "@/lib/blob-layout";
import { useModules } from "@/lib/module-registry";

/**
 * The blob scene.
 *  - FOCUS: the camera sits in front of ONE blob (at its fixed position) — full
 *    swarm + its slot icons. Drag orbits it freely; scroll zooms.
 *  - CONSTELLATION: scroll out far enough and the camera lifts ABOVE THE MIDDLE
 *    of all blobs and looks down. Every blob is a mini-swarm at its fixed spot
 *    in a ring, interconnected by the same strands the slot icons have.
 * Click a blob in the constellation and the camera flies TO THAT BLOB'S
 * POSITION (not the centre) and focuses it. Free rotation throughout
 * (OrbitControls); no roll, no flash.
 */

const FOCUS_OFFSET = new Vector3(0, 0, 6.5); // camera in front of the focused blob
const ORIGIN = new Vector3(0, 0, 0);
const OVERVIEW_TRIGGER = 14; // scroll the focus camera past this → constellation

// Deterministic per-index hash for controlled jitter.
function rand(k: number): number {
  const x = Math.sin(k * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
// Blobs scattered in the XZ plane: a golden-angle (sunflower) spread for an
// organic, even-but-not-gridlike base, plus seeded jitter in angle/radius/
// height for controlled chaos. Centred on the origin (= the centroid), so the
// top-down overview frames the middle of the set.
function blobPositions(n: number): Vector3[] {
  if (n <= 1) return [new Vector3(0, 0, 0)];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const Rmax = 1.7 + 0.95 * Math.sqrt(n);
  return Array.from({ length: n }, (_, i) => {
    const baseR = Rmax * Math.sqrt((i + 0.5) / n);
    const a = i * golden + (rand(i * 1.7) - 0.5) * 0.55;
    const r = Math.max(0, baseR + (rand(i * 2.3) - 0.5) * 0.9);
    const y = (rand(i * 3.1) - 0.5) * 1.1;
    return new Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
  });
}

type Transition = { target: Vector3; cam: Vector3 } | null;

// Top-down framing of the whole scattered field, centred on the centroid — the
// camera lifted above the origin looking down. Shared by goOverview and the
// settle effect so deleting/adding a blob while zoomed out re-frames the field
// instead of diving the camera into a single mini-blob.
function overviewTransition(positions: Vector3[]): NonNullable<Transition> {
  let maxR = 3;
  for (const p of positions) maxR = Math.max(maxR, Math.hypot(p.x, p.z));
  const h = maxR * 1.9 + 4.5;
  return { target: ORIGIN.clone(), cam: new Vector3(0, h, h * 0.16) };
}

// Drives camera transitions (fly to a blob / lift to the overview) and triggers
// the overview once the user scrolls the focus camera out far enough. Between
// transitions, OrbitControls owns the camera (free rotate + zoom).
function Rig({
  mode,
  controlsRef,
  transitionRef,
  onScrollOut,
}: {
  mode: "focus" | "overview";
  controlsRef: MutableRefObject<{ target: Vector3; update: () => void; enabled: boolean } | null>;
  transitionRef: MutableRefObject<Transition>;
  onScrollOut: () => void;
}) {
  const { camera } = useThree();
  useFrame(() => {
    const c = controlsRef.current;
    if (!c) return;
    const tr = transitionRef.current;
    if (tr) {
      c.enabled = false;
      c.target.lerp(tr.target, 0.12);
      camera.position.lerp(tr.cam, 0.12);
      camera.lookAt(c.target);
      if (camera.position.distanceTo(tr.cam) < 0.08 && c.target.distanceTo(tr.target) < 0.08) {
        camera.position.copy(tr.cam);
        c.target.copy(tr.target);
        c.enabled = true;
        c.update();
        transitionRef.current = null;
      }
      return;
    }
    // TrackballControls (drei) runs its own update each frame — don't call
    // c.update() here too.
    if (mode === "focus" && camera.position.distanceTo(c.target) > OVERVIEW_TRIGGER) {
      onScrollOut();
    }
  });
  return null;
}

function ResponsiveCamera() {
  const { camera, size } = useThree();
  useEffect(() => {
    camera.position.set(0, 0, size.width < 1280 ? 7.0 : 6.5);
    camera.lookAt(0, 0, 0);
    if ("isPerspectiveCamera" in camera) {
      const cam = camera as PerspectiveCamera;
      cam.fov = 35;
      // Shift the rendered scene DOWN ~12% of viewport height (copied verbatim
      // from the Spectre monolith's kiosk/blob ResponsiveCamera): sample the
      // camera frustum from a NEGATIVE-y offset so the blob + constellation sit
      // just below page-middle, leaving the clock room above. Negative y crops
      // the bottom → objects appear lower. View-offset is projection-only — it
      // does not touch the scene graph, trackball target, or pointer raycasting.
      cam.setViewOffset(
        size.width,
        size.height,
        0,
        -size.height * 0.12,
        size.width,
        size.height,
      );
      cam.updateProjectionMatrix();
    }
  }, [camera, size.width, size.height]);
  return null;
}

export interface TrailRipple {
  origin: Vector3;
  born: number;
  alive: boolean;
}

function CursorShell({
  trailRef,
  draggingRef,
}: {
  trailRef: MutableRefObject<TrailRipple[]>;
  draggingRef: MutableRefObject<boolean>;
}) {
  const lastPushRef = useRef({ t: -1, x: 0, y: 0, z: 0 });
  return (
    <mesh
      onPointerMove={(event) => {
        if (draggingRef.current) return;
        const now = performance.now() / 1000;
        const last = lastPushRef.current;
        const dx = event.point.x - last.x;
        const dy = event.point.y - last.y;
        const dz = event.point.z - last.z;
        if (last.t > 0 && dx * dx + dy * dy + dz * dz < 0.0009) return;
        const trail = trailRef.current;
        let slot = trail[0];
        for (let i = 0; i < trail.length; i++) {
          const en = trail[i];
          if (!en.alive) {
            slot = en;
            break;
          }
          if (en.born < slot.born) slot = en;
        }
        slot.origin.copy(event.point);
        slot.born = now;
        slot.alive = true;
        last.t = now;
        last.x = event.point.x;
        last.y = event.point.y;
        last.z = event.point.z;
      }}
    >
      <sphereGeometry args={[1.2, 24, 24]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

export function BlobScene() {
  const router = useRouter();
  const modules = useModules();
  const [isDragging, setIsDragging] = useState(false);
  const [transitioningTo, setTransitioningTo] = useState<string | null>(null);

  const [layout, setLayout] = useState<BlobLayout>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [mode, setMode] = useState<"focus" | "overview">("focus");
  const transitionRef = useRef<Transition>(null);

  const positions = useMemo(() => blobPositions(layout.length), [layout.length]);

  // Live registry ids (incl. installed modules). loadLayout reconciles a saved
  // layout against these; ensurePlaced drops new installs onto a blob so an
  // installed module actually appears. Re-runs once when the registry resolves.
  const moduleIds = useMemo(() => modules.map((m) => m.id), [modules]);

  useEffect(() => {
    let cancelled = false;
    loadLayout(moduleIds).then((l) => {
      if (cancelled) return;
      const placed = ensurePlaced(l, moduleIds);
      setLayout(placed);
      setActiveId((a) => a || placed[0]?.id || "");
      if (placed !== l) void saveLayout(placed);
    });
    return () => {
      cancelled = true;
    };
  }, [moduleIds]);

  // Settle the camera once the layout is known, and re-aim it whenever the blob
  // count changes (add/delete reshuffles every position). Mode-aware: in focus
  // we land on the active blob; in overview we re-frame the whole field from
  // above — so deleting a blob from the constellation doesn't dive the camera
  // into a single mini-blob.
  useEffect(() => {
    if (!layout.length) return;
    if (mode === "overview") {
      transitionRef.current = overviewTransition(positions);
    } else {
      const idx = Math.max(0, layout.findIndex((b) => b.id === activeId));
      const P = positions[idx] ?? ORIGIN;
      transitionRef.current = { target: P.clone(), cam: P.clone().add(FOCUS_OFFSET) };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.length]);

  const impactRef = useRef<{ origin: Vector3; born: number } | null>(null);
  const trailRef = useRef<TrailRipple[]>(
    Array.from({ length: 24 }, () => ({ origin: new Vector3(), born: -1, alive: false })),
  );
  const draggingRef = useRef(false);
  const wasDragRef = useRef(false);

  useEffect(() => {
    draggingRef.current = isDragging;
    if (!isDragging) {
      const trail = trailRef.current;
      for (let i = 0; i < trail.length; i++) trail[i].alive = false;
    }
  }, [isDragging]);

  // Track click-vs-drag for the blob earthquake + constellation picks.
  useEffect(() => {
    let sx = 0, sy = 0, dq = 25, down = false;
    const onDown = (e: globalThis.PointerEvent) => {
      down = true;
      sx = e.clientX;
      sy = e.clientY;
      dq = e.pointerType === "mouse" ? 25 : 196;
      wasDragRef.current = false;
      setIsDragging(true);
    };
    const onMove = (e: globalThis.PointerEvent) => {
      if (!down) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (dx * dx + dy * dy > dq) wasDragRef.current = true;
    };
    const onUp = () => {
      down = false;
      setIsDragging(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const controlsRef = useRef<{ target: Vector3; update: () => void; enabled: boolean } | null>(null);

  const handleNavigate = useCallback(
    (route: string) => {
      // Honour the tab-open preference (same / new window / ask each time).
      resolveOpen(route).then((mode) => {
        if (!mode) return; // user cancelled the prompt
        if (mode === "new") {
          openNewWindow(route); // a real app window, not a tab
          return;
        }
        setTransitioningTo(route);
        window.setTimeout(() => router.push(route), 380);
      });
    },
    [router],
  );

  const activeIndex = Math.max(0, layout.findIndex((b) => b.id === activeId));
  const activeBlob = layout[activeIndex];
  const activeColor = blobColor(activeBlob, activeIndex);
  const tint = activeColor.toLowerCase() === "#8b5cf6" ? undefined : activeColor;

  // Travel: fly the camera TO the clicked blob's position + focus it.
  const enterBlob = useCallback(
    (id: string) => {
      const idx = layout.findIndex((b) => b.id === id);
      const P = (positions[idx] ?? ORIGIN).clone();
      setActiveId(id);
      setMode("focus");
      transitionRef.current = { target: P, cam: P.clone().add(FOCUS_OFFSET) };
    },
    [layout, positions],
  );

  const goOverview = useCallback(() => {
    setMode("overview");
    transitionRef.current = overviewTransition(positions);
  }, [positions]);

  const applyLayout = useCallback((next: BlobLayout) => {
    setLayout(next);
    void saveLayout(next);
    setActiveId((a) => (next.some((b) => b.id === a) ? a : next[0]?.id ?? ""));
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 0, cursor: isDragging ? "grabbing" : "grab" }}>
      <motion.div
        style={{ position: "absolute", inset: 0 }}
        initial={{ opacity: 0, scale: 1 }}
        animate={{ opacity: transitioningTo ? 0.45 : 1, scale: transitioningTo ? 0.78 : 1 }}
        transition={{ duration: transitioningTo ? 0.38 : 0.8, ease: transitioningTo ? "easeIn" : "easeOut" }}
      >
        <Canvas
          camera={{ position: [0, 0, 6.5], fov: 35 }}
          dpr={[1, 2]}
          style={{ position: "absolute", inset: 0 }}
          gl={{ failIfMajorPerformanceCaveat: false, powerPreference: "high-performance", antialias: true }}
          onCreated={({ gl }) => {
            const canvas = gl.domElement;
            canvas.addEventListener(
              "webglcontextlost",
              (e) => {
                e.preventDefault();
                console.warn("[blob] webgl context lost — waiting for restore");
              },
              { passive: false },
            );
          }}
        >
          <ResponsiveCamera />
          <color attach="background" args={["#050507"]} />
          <fog attach="fog" args={["#050507", 14, 40]} />
          <directionalLight position={[4, 6, 5]} intensity={0.7} color="#6366f1" />
          <pointLight position={[-4, -2, -5]} intensity={0.3} color="#ec4899" distance={12} decay={2} />
          <hemisphereLight args={["#7c6ed8", "#0e0c18", 0.32]} />
          <ambientLight color="#3a2854" intensity={0.18} />
          {/* key light follows the focused blob */}
          <pointLight position={positions[activeIndex] ?? ORIGIN} intensity={2.4} color="#a78bfa" distance={12} decay={1} />

          <Suspense fallback={null}>
            {mode === "focus" && (
              <group position={positions[activeIndex] ?? ORIGIN}>
                <Blob
                  audioAmp={0}
                  orbMood={null}
                  tint={tint}
                  impactRef={impactRef}
                  trailRef={trailRef}
                  wasDragRef={wasDragRef}
                />
                {activeBlob && <Nodes moduleIds={activeBlob.slots} onNavigate={handleNavigate} />}
                <CursorShell trailRef={trailRef} draggingRef={draggingRef} />
              </group>
            )}

            {mode === "overview" && (
              <>
                <Strands positions={positions} />
                {layout.map((b, i) => (
                  <ConstellationBlob
                    key={b.id}
                    blob={b}
                    color={blobColor(b, i)}
                    position={positions[i]}
                    interactive
                    wasDragRef={wasDragRef}
                    onSelect={enterBlob}
                  />
                ))}
              </>
            )}

            <Atmosphere />
          </Suspense>

          <Rig mode={mode} controlsRef={controlsRef} transitionRef={transitionRef} onScrollOut={goOverview} />

          {/* TrackballControls: full 360° free rotation (barrel rolls, no polar
              hardstop) like the focused blob; scroll zooms; no pan. */}
          <TrackballControls
            ref={controlsRef as never}
            noPan
            staticMoving={false}
            dynamicDampingFactor={0.12}
            rotateSpeed={2.2}
            zoomSpeed={1.2}
            minDistance={mode === "focus" ? 3.5 : 5}
            maxDistance={mode === "focus" ? 15 : 30}
          />
        </Canvas>
      </motion.div>

      {/* Page-transition curtain — ramps opaque just before router.push. */}
      <div
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          pointerEvents: "none",
          background: "#050507",
          opacity: transitioningTo ? 0.92 : 0,
          transition: "opacity 380ms ease-in",
        }}
      />

      <CustomizeSlots layout={layout} activeId={activeId} onChange={applyLayout} onEnter={enterBlob} />
    </div>
  );
}
