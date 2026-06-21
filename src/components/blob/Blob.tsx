"use client";

import {
  useEffect,
  useMemo,
  useRef,
  type MutableRefObject,
} from "react";
import { useFrame } from "@react-three/fiber";
import {
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  MeshBasicMaterial,
} from "three";

import type { TrailRipple } from "./BlobScene";
import { choreographer, getPoseTimes } from "./useChoreographer";
import type { PoseFrame } from "./poses/types";

interface BlobProps {
  audioAmp?: number;
  audioBands?: number[];
  orbMood?: { mood: string; color: { r: number; g: number; b: number } } | null;
  /** hex hue to re-tint the whole swarm; undefined keeps the signature violet. */
  tint?: string;
  impactRef?: MutableRefObject<{ origin: Vector3; born: number } | null>;
  trailRef?: MutableRefObject<TrailRipple[]>;
  wasDragRef?: MutableRefObject<boolean>;
}

const TOTAL_COUNT = 16000;
const SPHERE_RADIUS = 1.0;
const JITTER = 0.022;
const IDLE_BOB_BASE = 0.03;
const IDLE_BOB_AMP = 0.04;
const IDLE_BOB_FREQ = 0.6;
const VOICE_PUSH = 0.18;
const BAND_PUSH = 0.42;  // per-voxel push from this voxel's frequency band
const GROUP_SPIN = 0.06;
const SWAY_AMP = 0.025;

// Orb-aware pose constants. The core sphere sits at origin with
// radius 0.57 (set in the JSX below). When a pose's target lands
// inside, we redirect to ORB_PUSH_RADIUS so voxels glide along
// the surface instead of clipping.
const ORB_PUSH_RADIUS = 0.61;
const ORB_PUSH_RADIUS_SQ = ORB_PUSH_RADIUS * ORB_PUSH_RADIUS;

// Scratch colours for per-frame orb pose/mood modulation (no per-frame alloc).
const orbColorScratch = new Color();
const moodColorScratch = new Color();

// Rough-ball geometry tunables.
// Surface noise: amplitude of the multi-octave directional bumps that
//   make the shell organic instead of geometrically smooth.
// Shell thickness: how far inward voxels can sit from the noisy
//   surface. Most voxels cluster at/near the surface; the long tail
//   penetrates inward to give the shape depth.
const SURFACE_NOISE_AMP = 0.11;
const SHELL_THICKNESS = 0.32;

// Cursor-wake tunables. The wake is a buffer of small smooth
// depressions stamped along the cursor's path — NOT expanding
// rings. Each ripple is a gaussian bump weighted by age decay,
// so every voxel sees a monotonic rise + fall (no oscillation,
// no wave-front jitter on slow movement). Click ripple keeps
// the dramatic sin-wave earthquake — that's the loud effect.
const TRAIL_LIFETIME = 1.6;
const TRAIL_AMP = 0.025;          // per-ripple peak displacement (main swarm)
const TRAIL_AGE_DAMP = 1.6;       // exp(-age * this)
const TRAIL_INFLUENCE_R_SQ = 0.18; // skip voxels past sqrt(0.18) ≈ 0.42 from a ripple
const TRAIL_GAUSS_K = 22;         // exp(-distSq * this) — sigma ≈ 0.15

// Outer voxels (arc bands at r=1.45 / r=1.75 and satellites at
// r≈1.55–2.10) live further from the cursor (which projects to
// r≈1.2 on the CursorShell). They get a wider gaussian + a
// slightly higher per-ripple amplitude so they actually feel
// the wake — without that the cursor would only stir the inner
// shell. Same age decay so their reaction fades on the same
// rhythm as the main swarm.
const TRAIL_OUTER_AMP = 0.045;
const TRAIL_OUTER_INFLUENCE_R_SQ = 1.1;
const TRAIL_OUTER_GAUSS_K = 4;
const TRAIL_OUTER_AGE_DAMP = 1.6;


interface Instance {
  rest: Vector3;
  /** 0..7 band index based on the voxel's longitude. Used for
   *  audio-reactive per-voxel push (equaliser on the swarm). */
  bandIdx: number;
  normal: Vector3;
  swayU: Vector3;
  swayV: Vector3;
  swayPhaseU: number;
  swayPhaseV: number;
  swayFreqU: number;
  swayFreqV: number;
  scale: number;
  quat: Quaternion;
  rotAxis: Vector3;
  rotSpeed: number;
  phase: number;
  color: Color;
}

// A 5-shade palette, weighted to a medium bulk with sparser pale + deep
// highlights — shared across the swarm, arcs, and satellites so the whole
// structure reads as one translucent cloud. The default is Spectre's signature
// violet; buildPalette(tint) regenerates the same ramp around any other hue so
// a blob can be re-coloured wholesale.
export type Palette = Array<{ color: Color; weight: number }>;

const DEFAULT_PALETTE: Palette = [
  { color: new Color("#d4c4ff"), weight: 0.12 },
  { color: new Color("#c4b5fd"), weight: 0.18 },
  { color: new Color("#a78bfa"), weight: 0.28 },
  { color: new Color("#8b5cf6"), weight: 0.28 },
  { color: new Color("#6d4ed8"), weight: 0.14 },
];

const PALETTE_WEIGHTS = [0.12, 0.18, 0.28, 0.28, 0.14];
// Lightness + saturation fan-out around the PICKED colour, lightest → darkest.
// These offsets are measured from DEFAULT_PALETTE (the hand-tuned violet) taken
// relative to its dominant 4th shade (#8b5cf6): the swarm's highlights run a bit
// lighter & more saturated, the deep shade darkens AND desaturates. Index 3 sits
// at offset 0 — the user's EXACT colour — so a re-tinted blob both reads as the
// colour they chose AND carries the same tonal variance the violet has, rather
// than a flat one-tone fill. Plug #8b5cf6 back in and it reproduces the violet.
const PALETTE_L_OFFSETS = [0.22, 0.19, 0.1, 0.0, -0.09];
const PALETTE_S_OFFSETS = [0.1, 0.05, 0.02, 0.0, -0.26];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function buildPalette(tint?: string): Palette {
  if (!tint) return DEFAULT_PALETTE;
  const base = new Color(tint);
  const hsl = { h: 0, s: 0, l: 0 };
  // r3f runs with ColorManagement on (working space = LinearSRGB), so a bare
  // getHSL/setHSL would read/write LINEAR HSL — but the offsets above are
  // measured from DEFAULT_PALETTE in sRGB. Pin both ends to sRGB so the ramp
  // matches its calibration (and plugging #8b5cf6 back in reproduces the violet).
  base.getHSL(hsl, SRGBColorSpace);
  // A grey/black pick has an arbitrary hue at s≈0; adding the saturation
  // fan-out would tint it red. Keep the ramp neutral in that case.
  const neutral = hsl.s < 0.06;
  return PALETTE_L_OFFSETS.map((dl, i) => ({
    color: new Color().setHSL(
      hsl.h,
      neutral ? hsl.s : clamp01(hsl.s + PALETTE_S_OFFSETS[i]),
      clamp01(hsl.l + dl),
      SRGBColorSpace,
    ),
    weight: PALETTE_WEIGHTS[i],
  }));
}

function pickPaletteColor(rng: () => number, palette: Palette): Color {
  const r = rng();
  let acc = 0;
  for (const entry of palette) {
    acc += entry.weight;
    if (r <= acc) return entry.color.clone();
  }
  return palette[0].color.clone();
}

// The inner orb sits a touch paler than the lightest swarm shade.
export function orbColorFor(palette: Palette): Color {
  return palette[0].color.clone().lerp(new Color("#ffffff"), 0.45);
}

// Deterministic PRNG so the swarm layout is stable across renders.
function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const STABLE_AXIS = new Vector3(0, 1, 0);
const FALLBACK_AXIS = new Vector3(1, 0, 0);

// Multi-octave directional noise — gives every direction on the
// sphere an organic bump that varies smoothly. Three sin/cos lobes
// at different frequencies sum to a roughly [-1, +1] field. Shapes
// the surface so voxels cluster into uneven hills + valleys rather
// than a clean spherical shell.
function surfaceNoise(x: number, y: number, z: number): number {
  return (
    0.55 * Math.sin(x * 3.7 + y * 2.1) * Math.cos(z * 4.5) +
    0.30 * Math.sin(x * 8.0 + z * 7.0) * Math.cos(y * 9.0) +
    0.15 * Math.sin(y * 18.0 + z * 13.5)
  );
}

export function buildInstances(count: number, palette: Palette): Instance[] {
  const rng = mulberry32(0xc0ffee);
  const out: Instance[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const denom = Math.max(1, count - 1);

  for (let i = 0; i < count; i++) {
    // Direction: Fibonacci sphere — uniform angular density.
    const y = 1 - (i / denom) * 2;
    const ringR = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const dirX = Math.cos(theta) * ringR;
    const dirY = y;
    const dirZ = Math.sin(theta) * ringR;

    // Surface bump — same noise field for every voxel along a given
    // direction, so the bumps are coherent on the surface (a bulge in
    // direction D affects all voxels stacked along D).
    const bump = SURFACE_NOISE_AMP * surfaceNoise(dirX, dirY, dirZ);
    const surfaceR = SPHERE_RADIUS + bump;

    // Per-voxel radial offset. Most voxels sit at or just below the
    // surface (power curve biases towards 0); a long tail penetrates
    // up to SHELL_THICKNESS inward, giving the ball real depth so
    // you see voxels under voxels through the surface gaps.
    const t = Math.pow(rng(), 1.6);
    const radialOffset = t * SHELL_THICKNESS;
    const radius = surfaceR - radialOffset;

    const base = new Vector3(dirX, dirY, dirZ).multiplyScalar(radius);
    const normal = new Vector3(dirX, dirY, dirZ);

    // Small tangential jitter so voxels at adjacent Fibonacci indices
    // don't sit on perfect rings; the radial spread does the heavy
    // lifting for the rough texture.
    const jitter = new Vector3(
      (rng() - 0.5) * 2 * JITTER,
      (rng() - 0.5) * 2 * JITTER,
      (rng() - 0.5) * 2 * JITTER,
    );
    const rest = base.add(jitter);

    // Wider scale spread than before — mixing in some chunkier voxels
    // breaks up the "all one size" smoothness and reads as more
    // variegated texture.
    const scale = 0.018 + Math.pow(rng(), 1.8) * 0.030;

    const initialAxis = new Vector3(
      rng() - 0.5,
      rng() - 0.5,
      rng() - 0.5,
    ).normalize();
    const quat = new Quaternion().setFromAxisAngle(
      initialAxis,
      rng() * Math.PI * 2,
    );

    const rotAxis = new Vector3(
      rng() - 0.5,
      rng() - 0.5,
      rng() - 0.5,
    ).normalize();
    const rotSpeed = (rng() - 0.5) * 0.8;

    const phase = rng() * Math.PI * 2;

    const ref =
      Math.abs(normal.dot(STABLE_AXIS)) > 0.95 ? FALLBACK_AXIS : STABLE_AXIS;
    const swayU = new Vector3().crossVectors(normal, ref).normalize();
    const swayV = new Vector3().crossVectors(normal, swayU).normalize();
    const swayPhaseU = rng() * Math.PI * 2;
    const swayPhaseV = rng() * Math.PI * 2;
    const swayFreqU = 0.4 + rng() * 0.6;
    const swayFreqV = 0.4 + rng() * 0.6;

    const color = pickPaletteColor(rng, palette);

    // Map the voxel to one of 8 frequency bands by its longitude
    // angle. Two voxels at adjacent longitudes share neighbouring
    // bands, so the swarm reads as a wrap-around equaliser.
    const longitude = Math.atan2(dirZ, dirX);
    const bandFloat =
      ((longitude + Math.PI) / (2 * Math.PI)) * 8;
    const bandIdx = Math.max(0, Math.min(7, Math.floor(bandFloat))) | 0;

    out.push({
      rest,
      bandIdx,
      normal,
      swayU,
      swayV,
      swayPhaseU,
      swayPhaseV,
      swayFreqU,
      swayFreqV,
      scale,
      quat,
      rotAxis,
      rotSpeed,
      phase,
      color,
    });
  }
  return out;
}

const tempMatrix = new Matrix4();
const tempPos = new Vector3();
const tempScale = new Vector3();
const deltaQuat = new Quaternion();
const tempImpactLocal = new Vector3();
const tempDir = new Vector3();
const tempPoseTarget = new Vector3();
const tempEmissionColor = new Color();
const tempColorOut = new Color();
let lastEmissionState = false;
const POSE_REST_PLACEHOLDER = new Vector3();
const POSE_NORMAL_PLACEHOLDER = new Vector3();
const poseFrame: { t: number; count: number; i: number; rest: Vector3; normal: Vector3 } = {
  t: 0,
  count: 0,
  i: 0,
  rest: POSE_REST_PLACEHOLDER,
  normal: POSE_NORMAL_PLACEHOLDER,
};

interface ArcInstance {
  angle: number;
  baseOffset: number;
  scale: number;
  quat: Quaternion;
  color: Color;
}

function buildArcInstances(count: number, seed: number, palette: Palette): ArcInstance[] {
  const rng = mulberry32(seed);
  const out: ArcInstance[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const baseOffset = (rng() - 0.5) * 2 * 0.04;
    const scale = 0.025 + rng() * 0.015;
    const initialAxis = new Vector3(
      rng() - 0.5,
      rng() - 0.5,
      rng() - 0.5,
    ).normalize();
    const quat = new Quaternion().setFromAxisAngle(
      initialAxis,
      rng() * Math.PI * 2,
    );
    const color = pickPaletteColor(rng, palette);
    out.push({ angle, baseOffset, scale, quat, color });
  }
  return out;
}

interface ArcBandProps {
  ringRadius: number;
  count: number;
  axisTilt: number;
  spinSpeed: number;
  audioAmp: number;
  phaseOffset?: number;
  material: MeshPhysicalMaterial;
  seed: number;
  palette: Palette;
  trailRef?: MutableRefObject<TrailRipple[]>;
}

function ArcBand({
  ringRadius,
  count,
  axisTilt,
  spinSpeed,
  audioAmp,
  phaseOffset = 0,
  material,
  seed,
  palette,
  trailRef,
}: ArcBandProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const spinRef = useRef<Group>(null);
  const ampRef = useRef(0);

  const instances = useMemo(
    () => buildArcInstances(count, seed, palette),
    [count, seed, palette],
  );

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < instances.length; i++) {
      mesh.setColorAt(i, instances[i].color);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [instances]);

  const trailLocal = useMemo(
    () => Array.from({ length: 24 }, () => new Vector3()),
    [],
  );

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;

    ampRef.current += (audioAmp - ampRef.current) * Math.min(1, delta * 6);
    const amp = ampRef.current;

    if (spinRef.current) {
      spinRef.current.rotation.y += spinSpeed * delta;
    }

    const mesh = meshRef.current;
    if (!mesh) return;

    const trail = trailRef?.current;
    const nowSec = performance.now() / 1000;
    let aliveCount = 0;
    if (trail) {
      for (let r = 0; r < trail.length; r++) {
        const ent = trail[r];
        if (!ent.alive) continue;
        if (nowSec - ent.born > TRAIL_LIFETIME) {
          ent.alive = false;
          continue;
        }
        trailLocal[r].copy(ent.origin);
        mesh.worldToLocal(trailLocal[r]);
        aliveCount++;
      }
    }

    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      const thicknessFactor = 1 + 0.6 * amp + 0.2 * Math.sin(t * 2 + i);
      const r = ringRadius + inst.baseOffset * thicknessFactor;
      tempPos.set(Math.cos(inst.angle) * r, 0, Math.sin(inst.angle) * r);

      if (aliveCount > 0 && trail) {
        for (let q = 0; q < trail.length; q++) {
          const ent = trail[q];
          if (!ent.alive) continue;
          const localR = trailLocal[q];
          const dx = tempPos.x - localR.x;
          const dy = tempPos.y - localR.y;
          const dz = tempPos.z - localR.z;
          const distSq = dx * dx + dy * dy + dz * dz;
          if (distSq > TRAIL_OUTER_INFLUENCE_R_SQ) continue;
          const age = nowSec - ent.born;
          const disp =
            TRAIL_OUTER_AMP *
            Math.exp(-distSq * TRAIL_OUTER_GAUSS_K) *
            Math.exp(-age * TRAIL_OUTER_AGE_DAMP);
          const len = Math.sqrt(distSq);
          if (len > 1e-5) {
            const k = disp / len;
            tempPos.x += dx * k;
            tempPos.y += dy * k;
            tempPos.z += dz * k;
          }
        }
      }

      tempScale.setScalar(inst.scale);
      tempMatrix.compose(tempPos, inst.quat, tempScale);
      mesh.setMatrixAt(i, tempMatrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <group rotation-x={axisTilt}>
      <group ref={spinRef} rotation-y={phaseOffset}>
        <instancedMesh
          ref={meshRef}
          args={[undefined, undefined, count]}
          material={material}
          castShadow={false}
          receiveShadow={true}
        >
          <boxGeometry args={[1, 1, 1]} />
        </instancedMesh>
      </group>
    </group>
  );
}

interface SatelliteInstance {
  radius: number;
  period: number;
  e1: Vector3;
  e2: Vector3;
  phase: number;
  scale: number;
  color: Color;
  quat: Quaternion;
  rotAxis: Vector3;
  rotSpeed: number;
}

function buildSatelliteInstances(
  count: number,
  seed: number,
  palette: Palette,
): SatelliteInstance[] {
  const rng = mulberry32(seed);
  const out: SatelliteInstance[] = [];
  for (let i = 0; i < count; i++) {
    const radius = 1.55 + rng() * (2.1 - 1.55);
    const period = 10 + rng() * 18;
    const axis = new Vector3(
      rng() - 0.5,
      rng() - 0.5,
      rng() - 0.5,
    ).normalize();
    const ref =
      Math.abs(axis.dot(STABLE_AXIS)) > 0.95 ? FALLBACK_AXIS : STABLE_AXIS;
    const e1 = new Vector3().crossVectors(axis, ref).normalize();
    const e2 = new Vector3().crossVectors(axis, e1).normalize();
    const phase = rng() * Math.PI * 2;
    const scale = 0.03 + rng() * 0.025;
    const color = pickPaletteColor(rng, palette);
    const initialAxis = new Vector3(
      rng() - 0.5,
      rng() - 0.5,
      rng() - 0.5,
    ).normalize();
    const quat = new Quaternion().setFromAxisAngle(
      initialAxis,
      rng() * Math.PI * 2,
    );
    const rotAxis = new Vector3(
      rng() - 0.5,
      rng() - 0.5,
      rng() - 0.5,
    ).normalize();
    const rotSpeed = (rng() - 0.5) * 1.0;
    out.push({
      radius,
      period,
      e1,
      e2,
      phase,
      scale,
      color,
      quat,
      rotAxis,
      rotSpeed,
    });
  }
  return out;
}

interface SatellitesProps {
  count: number;
  audioAmp: number;
  material: MeshPhysicalMaterial;
  seed: number;
  palette: Palette;
  trailRef?: MutableRefObject<TrailRipple[]>;
}

function Satellites({ count, audioAmp, material, seed, palette, trailRef }: SatellitesProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const ampRef = useRef(0);

  const instances = useMemo(
    () => buildSatelliteInstances(count, seed, palette),
    [count, seed, palette],
  );

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < instances.length; i++) {
      mesh.setColorAt(i, instances[i].color);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [instances]);

  const trailLocal = useMemo(
    () => Array.from({ length: 24 }, () => new Vector3()),
    [],
  );

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    ampRef.current += (audioAmp - ampRef.current) * Math.min(1, delta * 6);
    const amp = ampRef.current;

    const mesh = meshRef.current;
    if (!mesh) return;

    const trail = trailRef?.current;
    const nowSec = performance.now() / 1000;
    let aliveCount = 0;
    if (trail) {
      for (let r = 0; r < trail.length; r++) {
        const ent = trail[r];
        if (!ent.alive) continue;
        if (nowSec - ent.born > TRAIL_LIFETIME) {
          ent.alive = false;
          continue;
        }
        trailLocal[r].copy(ent.origin);
        mesh.worldToLocal(trailLocal[r]);
        aliveCount++;
      }
    }

    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      const angle = inst.phase + (t / inst.period) * Math.PI * 2;
      const r = inst.radius + 0.1 * amp;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      tempPos.set(
        inst.e1.x * c * r + inst.e2.x * s * r,
        inst.e1.y * c * r + inst.e2.y * s * r,
        inst.e1.z * c * r + inst.e2.z * s * r,
      );

      if (aliveCount > 0 && trail) {
        for (let q = 0; q < trail.length; q++) {
          const ent = trail[q];
          if (!ent.alive) continue;
          const localR = trailLocal[q];
          const dx = tempPos.x - localR.x;
          const dy = tempPos.y - localR.y;
          const dz = tempPos.z - localR.z;
          const distSq = dx * dx + dy * dy + dz * dz;
          if (distSq > TRAIL_OUTER_INFLUENCE_R_SQ) continue;
          const age = nowSec - ent.born;
          const disp =
            TRAIL_OUTER_AMP *
            Math.exp(-distSq * TRAIL_OUTER_GAUSS_K) *
            Math.exp(-age * TRAIL_OUTER_AGE_DAMP);
          const len = Math.sqrt(distSq);
          if (len > 1e-5) {
            const k = disp / len;
            tempPos.x += dx * k;
            tempPos.y += dy * k;
            tempPos.z += dz * k;
          }
        }
      }

      deltaQuat.setFromAxisAngle(inst.rotAxis, inst.rotSpeed * delta);
      inst.quat.multiplyQuaternions(deltaQuat, inst.quat);

      tempScale.setScalar(inst.scale);
      tempMatrix.compose(tempPos, inst.quat, tempScale);
      mesh.setMatrixAt(i, tempMatrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, count]}
      material={material}
      castShadow={false}
    >
      <boxGeometry args={[1, 1, 1]} />
    </instancedMesh>
  );
}

export function Blob({ audioAmp = 0, audioBands, orbMood, tint, impactRef, trailRef, wasDragRef }: BlobProps) {
  const groupRef = useRef<Group>(null);
  const meshRef = useRef<InstancedMesh>(null);
  const orbRef = useRef<Mesh>(null);
  const ampRef = useRef(0);

  // The swarm's colour vocabulary. Rebuilds (same fixed-seed layout, new
  // colours) when the active blob's tint changes — positions are stable, only
  // the per-instance colours shift, so re-tinting reads as a recolour not a jump.
  const palette = useMemo(() => buildPalette(tint), [tint]);
  const orbBase = useMemo(() => orbColorFor(palette), [palette]);

  const instances = useMemo(() => buildInstances(TOTAL_COUNT, palette), [palette]);

  const material = useMemo(
    () =>
      new MeshPhysicalMaterial({
        // White base lets the per-instance vertex colour drive the violet hue.
        color: new Color("#ffffff"),
        vertexColors: true,
        // Skip writing depth so 10K translucent voxels don't z-fight each
        // other; the opaque inner orb still occludes voxels behind it.
        metalness: 0.3,
        roughness: 0.5,
        clearcoat: 0.25,
        clearcoatRoughness: 0.3,
        iridescence: 0.2,
        iridescenceIOR: 1.4,
        iridescenceThicknessRange: [100, 400],
      }),
    [],
  );

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < instances.length; i++) {
      mesh.setColorAt(i, instances[i].color);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [instances]);

  // Per-component scratch for the trail's local-frame transforms.
  const trailLocal = useMemo(
    () => Array.from({ length: 24 }, () => new Vector3()),
    [],
  );

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const nowSec = performance.now() / 1000;

    // Advance the pose envelope + auto-cycle scheduler once per frame.
    choreographer.tick(nowSec);
    const poseEnv = choreographer.getEnvelope();
    const activePose = poseEnv > 0 ? choreographer.getActive() : null;

    ampRef.current += (audioAmp - ampRef.current) * Math.min(1, delta * 6);
    const amp = ampRef.current;

    const mesh = meshRef.current;
    if (mesh) {
      // Earthquake wave: convert world-space click point into the
      // group's local frame so the wave travels with the spinning swarm.
      let impactActive = false;
      let impactAge = 0;
      let impactDecay = 0;
      const impact = impactRef?.current;
      if (impact) {
        const nowSec = performance.now() / 1000;
        impactAge = nowSec - impact.born;
        if (impactAge >= 1.6) {
          impactRef!.current = null;
        } else {
          impactActive = true;
          impactDecay = Math.exp(-impactAge * 3.5);
          tempImpactLocal.copy(impact.origin);
          if (groupRef.current) groupRef.current.worldToLocal(tempImpactLocal);
        }
      }

      // Trail wake: pre-transform each alive ripple's world origin
      // into the swarm's local frame into a component-scoped scratch
      // buffer (allocation-free per frame; the buffer is built once
      // via useMemo).
      const trail = trailRef?.current;
      const nowSec2 = performance.now() / 1000;
      let trailAliveCount = 0;
      if (trail) {
        for (let r = 0; r < trail.length; r++) {
          const ent = trail[r];
          if (!ent.alive) continue;
          if (nowSec2 - ent.born > TRAIL_LIFETIME) {
            ent.alive = false;
            continue;
          }
          trailLocal[r].copy(ent.origin);
          if (groupRef.current) groupRef.current.worldToLocal(trailLocal[r]);
          trailAliveCount++;
        }
      }

      for (let i = 0; i < instances.length; i++) {
        const inst = instances[i];
        const bob =
          IDLE_BOB_BASE +
          IDLE_BOB_AMP * Math.sin(t * IDLE_BOB_FREQ + inst.phase);
        const bandAmp =
          audioBands && audioBands.length === 8
            ? audioBands[inst.bandIdx]
            : 0;
        // Equaliser-on-swarm: each voxel pulses outward by its
        // own band's amplitude, on top of the natural bob and the
        // global amp. BAND_PUSH dominates VOICE_PUSH so loud bands
        // really pop.
        const disp = bob + VOICE_PUSH * amp + BAND_PUSH * bandAmp;
        tempPos.copy(inst.normal).multiplyScalar(disp).add(inst.rest);

        const su = SWAY_AMP * Math.sin(t * inst.swayFreqU + inst.swayPhaseU);
        const sv = SWAY_AMP * Math.sin(t * inst.swayFreqV + inst.swayPhaseV);
        tempPos.x += inst.swayU.x * su + inst.swayV.x * sv;
        tempPos.y += inst.swayU.y * su + inst.swayV.y * sv;
        tempPos.z += inst.swayU.z * su + inst.swayV.z * sv;

        if (impactActive) {
          const distFromImpact = inst.rest.distanceTo(tempImpactLocal);
          const waveTime = impactAge - distFromImpact * 0.4;
          if (waveTime > 0 && waveTime < 0.9) {
            const waveDisp =
              Math.sin(waveTime * 10) *
              impactDecay *
              0.45 *
              Math.exp(-waveTime * 3);
            tempDir.copy(inst.rest).sub(tempImpactLocal);
            const len = tempDir.length();
            if (len > 1e-5) {
              const k = waveDisp / len;
              tempPos.x += tempDir.x * k;
              tempPos.y += tempDir.y * k;
              tempPos.z += tempDir.z * k;
            }
          }
        }

        if (trailAliveCount > 0 && trail) {
          for (let r = 0; r < trail.length; r++) {
            const ent = trail[r];
            if (!ent.alive) continue;
            const localR = trailLocal[r];
            const dx = inst.rest.x - localR.x;
            const dy = inst.rest.y - localR.y;
            const dz = inst.rest.z - localR.z;
            const distSq = dx * dx + dy * dy + dz * dz;
            if (distSq > TRAIL_INFLUENCE_R_SQ) continue;
            const age = nowSec2 - ent.born;
            // Pure gaussian dent: amp * spatial_falloff * age_decay.
            // No sin oscillation — voxels rise and fall monotonically.
            const disp =
              TRAIL_AMP *
              Math.exp(-distSq * TRAIL_GAUSS_K) *
              Math.exp(-age * TRAIL_AGE_DAMP);
            const len = Math.sqrt(distSq);
            if (len > 1e-5) {
              const k = disp / len;
              tempPos.x += dx * k;
              tempPos.y += dy * k;
              tempPos.z += dz * k;
            }
          }
        }

        // Pose blend: attenuate the natural displacement (bob/voice/sway/
        // impact/trail) at peak pose strength to ~30%, then lerp the
        // remaining position toward the pose's per-voxel target.
        if (poseEnv > 0 && activePose) {
          const attn = 1 - 0.7 * poseEnv;
          tempPos.sub(inst.rest).multiplyScalar(attn).add(inst.rest);

          poseFrame.t = nowSec - activePose.startedAt;
          poseFrame.count = TOTAL_COUNT;
          poseFrame.i = i;
          poseFrame.rest = inst.rest;
          poseFrame.normal = inst.normal;
          activePose.pose.target(poseFrame as PoseFrame, tempPoseTarget);

          tempPos.lerp(tempPoseTarget, poseEnv);

          // Orb-aware: project any voxel that's been pushed inside
          // the core out to its surface, scaled by envelope so the
          // effect ramps in/out with the pose. The core sits at
          // origin with radius ORB_RADIUS; ORB_PUSH_RADIUS is just
          // outside so voxels glide along the surface instead of
          // embedding. Without this, eye/heart/vortex/lightning all
          // tried to migrate voxels through the orb.
          const r2 =
            tempPos.x * tempPos.x +
            tempPos.y * tempPos.y +
            tempPos.z * tempPos.z;
          if (r2 < ORB_PUSH_RADIUS_SQ && r2 > 1e-9) {
            const r = Math.sqrt(r2);
            // Lerp from the original (potentially inside) position
            // out to the orb surface, by envelope. At env=0 there's
            // no push (no pose); at env=1 voxels sit just outside.
            const targetR = ORB_PUSH_RADIUS;
            const k = 1 + (targetR / r - 1) * poseEnv;
            tempPos.x *= k;
            tempPos.y *= k;
            tempPos.z *= k;
          }
        }

        deltaQuat.setFromAxisAngle(inst.rotAxis, inst.rotSpeed * delta);
        inst.quat.multiplyQuaternions(deltaQuat, inst.quat);

        tempScale.setScalar(inst.scale);
        tempMatrix.compose(tempPos, inst.quat, tempScale);
        mesh.setMatrixAt(i, tempMatrix);
      }

      // Emission write/restore. Only loops cost when we actually have
      // an active pose with an emission method, or just left one
      // (one-frame transition to restore natural colors).
      const isEmittingNow =
        poseEnv > 0 && activePose !== null && activePose.pose.emission !== undefined;
      if (isEmittingNow || lastEmissionState) {
        for (let i = 0; i < instances.length; i++) {
          const inst = instances[i];
          if (isEmittingNow) {
            poseFrame.t = nowSec - activePose!.startedAt;
            poseFrame.count = TOTAL_COUNT;
            poseFrame.i = i;
            poseFrame.rest = inst.rest;
            poseFrame.normal = inst.normal;
            const emissive = activePose!.pose.emission!(
              poseFrame as PoseFrame,
              tempEmissionColor,
            );
            if (emissive) {
              tempColorOut.copy(inst.color).lerp(tempEmissionColor, poseEnv);
              mesh.setColorAt(i, tempColorOut);
            } else if (lastEmissionState) {
              // Only restore on the frame after emission ended; skipping
              // here while emission was already off keeps idle pose frames
              // free at 16K voxels.
              mesh.setColorAt(i, inst.color);
            }
          } else {
            mesh.setColorAt(i, inst.color);
          }
        }
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      lastEmissionState = isEmittingNow;

      mesh.instanceMatrix.needsUpdate = true;
    }

    if (orbRef.current) {
      const naturalScale = 1 + 0.05 * Math.sin(t * 1.4);
      let finalScale = naturalScale;
      // Orb pose modulation: lerp scale + color toward the pose's
      // returned OrbState by envelope. At env=0 the orb breathes
      // normally; at env=1 it's whatever the pose asked for.
      if (poseEnv > 0 && activePose && activePose.pose.orb) {
        const orbState = activePose.pose.orb(
          nowSec - activePose.startedAt,
        );
        if (orbState.scale !== undefined) {
          finalScale = naturalScale * (1 - poseEnv) + orbState.scale * poseEnv;
        }
        if (orbState.color) {
          orbColorScratch.setRGB(
            orbState.color.r,
            orbState.color.g,
            orbState.color.b,
          );
          const mat = orbRef.current.material as MeshBasicMaterial;
          mat.color.copy(orbBase).lerp(orbColorScratch, poseEnv);
        }
      } else if (orbRef.current.material) {
        // No pose active — orb shows the mood colour if Spectre has
        // emitted one via set-orb-mood; otherwise pinned to base.
        const mat = orbRef.current.material as MeshBasicMaterial;
        if (orbMood && orbMood.color) {
          moodColorScratch.setRGB(
            orbMood.color.r,
            orbMood.color.g,
            orbMood.color.b,
          );
          // 70% mood, 30% base — readable mood colour without going pure
          // red/green and losing Spectre's lilac character.
          mat.color.copy(orbBase).lerp(moodColorScratch, 0.7);
        } else {
          mat.color.copy(orbBase);
        }
      }
      orbRef.current.scale.setScalar(finalScale);
    }

    if (groupRef.current) {
      // Natural spin pauses while a pose is in PREP/ENTER/HOLD/EXIT.
      // During PREP the group eases toward pose.facing so the pose's
      // local +z aligns with the camera before the animation begins.
      // After EXIT we just resume the natural spin from wherever we are.
      const poseTimes = getPoseTimes(nowSec);
      if (poseTimes) {
        const target = poseTimes.facing;
        const current = groupRef.current.rotation.y;
        // Wrap target so we take the shortest angular path from
        // current. Both are unbounded; reduce delta to (-pi, pi].
        const TWO_PI = Math.PI * 2;
        let diff = target - current;
        diff -= TWO_PI * Math.floor((diff + Math.PI) / TWO_PI);
        if (poseTimes.prepDone < 1) {
          // PREP: cubic-ease toward target.
          const k = poseTimes.prepDone;
          const ease = k * k * (3 - 2 * k);
          groupRef.current.rotation.y = current + diff * ease * 0.18;
        } else {
          // ENTER/HOLD/EXIT: hold target tightly.
          groupRef.current.rotation.y = current + diff * 0.18;
        }
      } else {
        groupRef.current.rotation.y += GROUP_SPIN * delta;
      }
    }
  });

  return (
    <group ref={groupRef}>
      <instancedMesh
        ref={meshRef}
        args={[undefined, undefined, TOTAL_COUNT]}
        material={material}
        castShadow={false}
        onClick={(event) => {
          if (!impactRef) return;
          // Bail if the click was actually a camera rotation —
          // browser fires 'click' on the canvas no matter how far
          // the cursor travelled between down and up.
          if (wasDragRef?.current) return;
          event.stopPropagation();
          impactRef.current = {
            origin: event.point.clone(),
            born: performance.now() / 1000,
          };
          if (trailRef) {
            const trail = trailRef.current;
            for (let i = 0; i < trail.length; i++) {
              trail[i].alive = false;
            }
          }
        }}
      >
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
      <ArcBand
        ringRadius={1.45}
        count={140}
        axisTilt={0.65}
        spinSpeed={0.18}
        audioAmp={audioAmp}
        material={material}
        seed={0xa1c0ff}
        palette={palette}
        trailRef={trailRef}
      />
      <ArcBand
        ringRadius={1.75}
        count={120}
        axisTilt={-1.05}
        spinSpeed={-0.12}
        audioAmp={audioAmp}
        phaseOffset={Math.PI / 3}
        material={material}
        seed={0xa2c0ff}
        palette={palette}
        trailRef={trailRef}
      />
      <Satellites
        count={40}
        audioAmp={audioAmp}
        material={material}
        seed={0x5a7e11}
        palette={palette}
        trailRef={trailRef}
      />
      <mesh ref={orbRef}>
        <sphereGeometry args={[0.57, 48, 32]} />
        <meshBasicMaterial color={orbBase} toneMapped={false} />
      </mesh>
    </group>
  );
}
