"use client";

import {
  memo,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent,
} from "react";
import { Html, Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import {
  Activity,
  Box,
  Brain,
  FolderGit2,
  Image as ImageIcon,
  MessageSquare,
  Settings,
  Timer,
  type LucideIcon,
} from "lucide-react";
import { Group, Vector3, Color } from "three";
import type { Line2 } from "three-stdlib";
import type { ModuleManifest } from "@/lib/modules";
import { useModules } from "@/lib/module-registry";

// lucide icons a module manifest may reference by name (string -> component).
const ICONS: Record<string, LucideIcon> = { MessageSquare, Brain, Settings, Activity, Box, FolderGit2, Timer, Image: ImageIcon };

interface NodeDefinition {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  route: string;
}

interface NodesProps {
  audioAmp?: number;
  onNavigate?: (route: string) => void;
  /** module ids this blob's slots should show; defaults to all registered. */
  moduleIds?: string[];
}

const NODE_RADIUS = 1.85;
const GROUP_SPIN = 0.03;
const CLICK_DRAG_THRESHOLD = 6;

// A slot = a registered module. A blob renders the modules assigned to it (its
// blob-layout slots); default = all registered modules.
function toNode(m: ModuleManifest): NodeDefinition {
  return { id: m.id, label: m.label, hint: m.hint, icon: ICONS[m.icon] ?? Box, route: m.route };
}

function fibonacciSphere(count: number, radius: number) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const denom = Math.max(1, count - 1);

  return Array.from({ length: count }, (_, i) => {
    const y = 1 - (i / denom) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;

    return new Vector3(
      Math.cos(theta) * r * radius,
      y * radius,
      Math.sin(theta) * r * radius,
    );
  });
}

const THREAD_BASE_COLOR = new Color("#a78bfa");

const GraphThread = memo(function GraphThread({
  index,
  points,
  audioAmpRef,
}: {
  index: number;
  points: [Vector3, Vector3];
  audioAmpRef: MutableRefObject<number>;
}) {
  const lineRef = useRef<Line2>(null);

  useFrame(({ clock }) => {
    const line = lineRef.current;
    if (!line) return;
    const t = clock.elapsedTime;
    // Brightness pulse — drives both the thread's emitted light
    // (bloom catches when value > 1) and the opacity, so the fade
    // rhythm and the emission rhythm are the same animation.
    const intensity =
      0.55 + 0.55 * Math.sin(t * 1.5 + index) + 0.35 * audioAmpRef.current;
    const clamped = Math.max(0.05, intensity);
    line.material.color.copy(THREAD_BASE_COLOR).multiplyScalar(clamped);
    line.material.opacity = Math.max(0.18, Math.min(1, 0.4 + clamped * 0.55));
  });

  return (
    <Line
      ref={lineRef}
      points={points}
      color={THREAD_BASE_COLOR}
      lineWidth={0.018}
      transparent
      opacity={0}
      toneMapped={false}
      worldUnits
    />
  );
});

const NodeStation = memo(function NodeStation({
  node,
  position,
  onNavigate,
}: {
  node: NodeDefinition;
  position: Vector3;
  onNavigate?: (route: string) => void;
}) {
  const Icon = node.icon;
  const [hovered, setHovered] = useState(false);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!start) return;
    const distance = Math.hypot(
      event.clientX - start.x,
      event.clientY - start.y,
    );
    if (distance <= CLICK_DRAG_THRESHOLD) {
      onNavigate?.(node.route);
    }
  };

  return (
    <Html position={position} center pointerEvents="auto">
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open ${node.label}`}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={(event) => {
          pointerStartRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onNavigate?.(node.route);
          }
        }}
        style={{
          width: 104,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
          userSelect: "none",
          outline: "none",
          WebkitTapHighlightColor: "transparent",
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: "50%",
            display: "grid",
            placeItems: "center",
            border: `1px solid ${hovered ? "#818cf8" : "rgba(99, 102, 241, 0.4)"}`,
            backgroundColor: "rgba(15, 15, 26, 0.85)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            color: "#eeeef0",
            transform: `scale(${hovered ? 1.06 : 1})`,
            boxShadow: hovered ? "0 0 24px rgba(139, 92, 246, 0.6)" : "none",
            transition:
              "transform 180ms ease-out, border-color 180ms ease-out, box-shadow 180ms ease-out",
          }}
        >
          <Icon size={22} strokeWidth={1.7} aria-hidden />
        </div>
        <div
          style={{
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "#a5a5b8",
            textAlign: "center",
            whiteSpace: "nowrap",
            lineHeight: 1.2,
            textShadow: "0 1px 2px rgba(0, 0, 0, 0.6)",
          }}
        >
          {node.label}
        </div>
      </div>
    </Html>
  );
});

export function Nodes({ audioAmp = 0, onNavigate, moduleIds }: NodesProps) {
  const groupRef = useRef<Group>(null);

  // Live module registry — seeds with the static MODULES (identical first
  // paint), then swaps in the live list once it loads.
  const modules = useModules();

  // Live audio amplitude into a ref so the per-frame thread updates can read
  // the latest value without re-rendering the node stations on every audio
  // tick (the parent re-renders frequently while the mic is live).
  const audioAmpRef = useRef(audioAmp);
  audioAmpRef.current = audioAmp;

  const nodes = useMemo(() => {
    const list = moduleIds
      ? moduleIds
          .map((id) => modules.find((m) => m.id === id))
          .filter((m): m is ModuleManifest => !!m)
      : modules;
    return list.map(toNode);
  }, [moduleIds, modules]);

  const positions = useMemo(
    () => fibonacciSphere(nodes.length, NODE_RADIUS),
    [nodes.length],
  );

  const threads = useMemo(
    () =>
      positions.map(
        (point, i) =>
          [point, positions[(i + 1) % positions.length]] as [Vector3, Vector3],
      ),
    [positions],
  );

  useFrame((_, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += GROUP_SPIN * delta;
    }
  });

  return (
    <group ref={groupRef}>
      {threads.map((points, i) => (
        <GraphThread
          key={`thread-${nodes[i].id}`}
          index={i}
          points={points}
          audioAmpRef={audioAmpRef}
        />
      ))}
      {nodes.map((node, i) => (
        <NodeStation
          key={node.id}
          node={node}
          position={positions[i]}
          onNavigate={onNavigate}
        />
      ))}
    </group>
  );
}
