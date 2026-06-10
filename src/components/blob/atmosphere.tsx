"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  Bloom,
  ChromaticAberration,
  EffectComposer,
  Vignette,
} from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  Points,
  ShaderMaterial,
  Vector2,
} from "three";

const PARTICLE_COUNT = 1500;
const PARTICLE_FIELD_RADIUS = 12;
const PARTICLE_RESPAWN_RADIUS = 14;
const PARTICLE_DRIFT_PER_FRAME = 0.0008;
const PARTICLE_GROUP_DRIFT = 0.005;
const BACKDROP_SCALE = 30;

// Same 5-tint palette as the swarm in Blob.tsx so the dust field
// gradient subtly matches the silhouette's colour vocabulary.
const PARTICLE_PALETTE: Array<{ color: string; weight: number }> = [
  { color: "#ffffff", weight: 0.55 },
  { color: "#e7e0ff", weight: 0.20 },
  { color: "#c4b5fd", weight: 0.15 },
  { color: "#a78bfa", weight: 0.10 },
];

function pickPaletteRGB(): [number, number, number] {
  const r = Math.random();
  let acc = 0;
  for (const entry of PARTICLE_PALETTE) {
    acc += entry.weight;
    if (r <= acc) {
      const c = new Color(entry.color);
      return [c.r, c.g, c.b];
    }
  }
  const c = new Color(PARTICLE_PALETTE[0].color);
  return [c.r, c.g, c.b];
}

const DUST_VERTEX = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
varying vec3 vColor;

void main() {
  vColor = aColor;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (300.0 / -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
}
`;

const DUST_FRAGMENT = /* glsl */ `
varying vec3 vColor;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float alpha = smoothstep(0.5, 0.0, d) * 0.55;
  gl_FragColor = vec4(vColor, alpha);
}
`;

function DustField() {
  const pointsRef = useRef<Points>(null);

  // Mutable typed arrays so useFrame can update positions in-place.
  const { geometry, positions, velocities } = useMemo(() => {
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const velocities = new Float32Array(PARTICLE_COUNT * 3);
    const colors = new Float32Array(PARTICLE_COUNT * 3);
    const sizes = new Float32Array(PARTICLE_COUNT);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      // Uniform position inside a sphere via rejection sampling.
      let x = 0;
      let y = 0;
      let z = 0;
      for (;;) {
        x = Math.random() * 2 - 1;
        y = Math.random() * 2 - 1;
        z = Math.random() * 2 - 1;
        if (x * x + y * y + z * z <= 1) break;
      }
      positions[i * 3 + 0] = x * PARTICLE_FIELD_RADIUS;
      positions[i * 3 + 1] = y * PARTICLE_FIELD_RADIUS;
      positions[i * 3 + 2] = z * PARTICLE_FIELD_RADIUS;

      const vx = Math.random() - 0.5;
      const vy = Math.random() - 0.5;
      const vz = Math.random() - 0.5;
      const len = Math.hypot(vx, vy, vz) || 1;
      velocities[i * 3 + 0] = (vx / len) * PARTICLE_DRIFT_PER_FRAME;
      velocities[i * 3 + 1] = (vy / len) * PARTICLE_DRIFT_PER_FRAME;
      velocities[i * 3 + 2] = (vz / len) * PARTICLE_DRIFT_PER_FRAME;

      const [cr, cg, cb] = pickPaletteRGB();
      colors[i * 3 + 0] = cr;
      colors[i * 3 + 1] = cg;
      colors[i * 3 + 2] = cb;

      sizes[i] = 0.006 + Math.random() * 0.012;
    }

    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(positions, 3));
    geo.setAttribute("aColor", new BufferAttribute(colors, 3));
    geo.setAttribute("aSize", new BufferAttribute(sizes, 1));

    return { geometry: geo, positions, velocities };
  }, []);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: DUST_VERTEX,
        fragmentShader: DUST_FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    [],
  );

  useFrame((_, delta) => {
    const points = pointsRef.current;
    if (!points) return;

    // velocities are calibrated per-frame at 60fps; scale by delta*60 for
    // framerate independence without changing the visual feel.
    const step = delta * 60;
    const respawnSq = PARTICLE_RESPAWN_RADIUS * PARTICLE_RESPAWN_RADIUS;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const o = i * 3;
      positions[o + 0] += velocities[o + 0] * step;
      positions[o + 1] += velocities[o + 1] * step;
      positions[o + 2] += velocities[o + 2] * step;

      const x = positions[o + 0];
      const y = positions[o + 1];
      const z = positions[o + 2];
      if (x * x + y * y + z * z > respawnSq) {
        // Respawn on the opposite side so the field stays spherical.
        positions[o + 0] = -x;
        positions[o + 1] = -y;
        positions[o + 2] = -z;
      }
    }
    const posAttr = points.geometry.getAttribute(
      "position",
    ) as BufferAttribute;
    posAttr.needsUpdate = true;

    points.rotation.y += PARTICLE_GROUP_DRIFT * delta;
  });

  return <points ref={pointsRef} geometry={geometry} material={material} />;
}

const BACKDROP_VERTEX = /* glsl */ `
varying vec3 vWorld;

void main() {
  vWorld = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BACKDROP_FRAGMENT = /* glsl */ `
varying vec3 vWorld;
uniform vec3 uColorCore;
uniform vec3 uColorEdge;
uniform vec3 uColorTint;

void main() {
  float r = length(vWorld) / 30.0;
  float glow = smoothstep(0.0, 0.55, 1.0 - r);
  float bandY = abs(vWorld.y) / 30.0;
  float band = smoothstep(0.0, 0.7, 1.0 - bandY) * 0.4;
  vec3 col = mix(uColorEdge, uColorCore, glow);
  col = mix(col, uColorTint, band * glow);
  gl_FragColor = vec4(col, 1.0);
}
`;


const CHROMA_OFFSET = new Vector2(0.0006, 0.0006);


// ---- Backdrop ---------------------------------------------------
// Soft dark-chamber gradient sphere wrapped around the scene at
// BackSide. Reads as "Spectre is in a low-lit interior", not deep
// space. Three colour stops:
//   uColorEdge → near-black far from centre (chamber walls)
//   uColorCore → dim indigo tint near the swarm (ambient warmth)
//   uColorTint → faint magenta on the horizontal band (a soft
//                horizon line for spatial cue)
// Blends additively over the BlobScene background colour, so the
// flat #14101e doesn't kill the gradient.
function Backdrop() {
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: BACKDROP_VERTEX,
        fragmentShader: BACKDROP_FRAGMENT,
        uniforms: {
          uColorCore: { value: new Color("#1a1330") },
          uColorEdge: { value: new Color("#08060f") },
          uColorTint: { value: new Color("#3a1e4a") },
        },
        side: BackSide,
        depthWrite: false,
      }),
    [],
  );
  return (
    <mesh material={material}>
      <sphereGeometry args={[BACKDROP_SCALE, 48, 32]} />
    </mesh>
  );
}

// ---- Containment halo -------------------------------------------
// A single thin holographic ring far behind the swarm (z = -7).
// Suggests architecture: Spectre is bounded by a structure, like a
// holographic UI element circling its core. Slow rotation gives
// gentle ambient motion without competing with the swarm.
//
// Implemented as a circular line geometry with additive HDR colour
// so bloom catches it as a dim glow. Single ring, tasteful.
const HALO_VERTEX = /* glsl */ `
varying float vAngle;
attribute float aAngle;
void main() {
  vAngle = aAngle;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const HALO_FRAGMENT = /* glsl */ `
varying float vAngle;
uniform float uTime;
uniform vec3 uColor;

void main() {
  // A travelling brightness peak around the ring, like a scanline.
  float wave = 0.5 + 0.5 * sin(vAngle * 2.0 - uTime * 0.7);
  float intensity = 0.18 + 0.45 * pow(wave, 4.0);
  gl_FragColor = vec4(uColor * intensity, intensity);
}
`;

function ContainmentHalo() {
  const ref = useRef<Points>(null);
  const SEGMENTS = 220;
  const RADIUS = 4.2;

  const geometry = useMemo(() => {
    const g = new BufferGeometry();
    const positions = new Float32Array(SEGMENTS * 3);
    const angles = new Float32Array(SEGMENTS);
    for (let i = 0; i < SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2;
      positions[i * 3] = Math.cos(a) * RADIUS;
      positions[i * 3 + 1] = Math.sin(a) * 0.8 - 1.2;     // tilted ring
      positions[i * 3 + 2] = Math.sin(a) * RADIUS * 0.92 - 4;
      angles[i] = a;
    }
    g.setAttribute("position", new BufferAttribute(positions, 3));
    g.setAttribute("aAngle", new BufferAttribute(angles, 1));
    return g;
  }, []);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: HALO_VERTEX,
        fragmentShader: HALO_FRAGMENT,
        uniforms: {
          uTime: { value: 0 },
          uColor: { value: new Color(0.55, 0.45, 1.0) },
        },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    [],
  );

  useFrame(({ clock }) => {
    if (!ref.current) return;
    (material.uniforms.uTime.value as number) = clock.elapsedTime;
    // Slow tilt drift so the ring feels alive but not distracting.
    ref.current.rotation.z = Math.sin(clock.elapsedTime * 0.05) * 0.08;
    ref.current.rotation.y = clock.elapsedTime * 0.03;
  });

  return (
    <points
      ref={ref}
      geometry={geometry}
      material={material}
    />
  );
}


export function Atmosphere() {
  return (
    <>
      <fog attach="fog" args={["#0a0816", 18, 40]} />
      <Backdrop />
      <ContainmentHalo />
      <DustField />
      <EffectComposer multisampling={0}>
        <Bloom
          intensity={0.5}
          luminanceThreshold={0.5}
          luminanceSmoothing={0.7}
          radius={0.78}
          mipmapBlur
        />
        <ChromaticAberration
          offset={CHROMA_OFFSET}
          blendFunction={BlendFunction.NORMAL}
          radialModulation={false}
          modulationOffset={0}
        />
        <Vignette offset={0.4} darkness={0.45} eskil={false} />
      </EffectComposer>
    </>
  );
}
