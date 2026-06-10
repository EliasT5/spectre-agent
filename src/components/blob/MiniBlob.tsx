"use client";

import { memo, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { Group, InstancedMesh, Matrix4, MeshStandardMaterial, Vector3 } from "three";
import { buildInstances, buildPalette, orbColorFor } from "./Blob";

/**
 * A blob in miniature — literally the SAME blob as zoomed in (same palette, same
 * swarm shape, same glowing orb core), just built with far fewer, bigger voxels
 * and baked static so a skyful of them doesn't kill the device. The swarm uses a
 * self-illuminating material so the constellation blobs read even with no light
 * next to them (they were pitch black otherwise). Hover scales it up a touch.
 */

const MINI_COUNT = 1400; // vs 16000 on the full blob
const SCALE_BOOST = 3.0; // fewer voxels → each bigger so the shell still reads
const MINI_SIZE = 0.42; // overall radius of a constellation blob

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Same look as the full swarm. Pure-dielectric (metalness 0) so the scene's
// directional + hemi + ambient light it as diffuse colour — no nearby light or
// fragile custom shader needed; the voxels read instead of going pitch black.
function createMiniMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 0, roughness: 0.6 });
}

const mtx = new Matrix4();
const scl = new Vector3();

export const MiniBlob = memo(function MiniBlob({
  color,
  hoverRef,
}: {
  color: string;
  hoverRef: MutableRefObject<boolean>;
}) {
  const groupRef = useRef<Group>(null);
  const meshRef = useRef<InstancedMesh>(null);
  const breatheRef = useRef(0);

  // Same tint rule as the full blob: signature violet → the hand-tuned palette.
  const palette = useMemo(
    () => buildPalette(color.toLowerCase() === "#8b5cf6" ? undefined : color),
    [color],
  );
  const orbColor = useMemo(() => orbColorFor(palette), [palette]);
  const instances = useMemo(() => buildInstances(MINI_COUNT, palette), [palette]);
  const material = useMemo(() => createMiniMaterial(), []);
  const seed = useMemo(() => hashStr(color), [color]);
  const spin = useMemo(() => 0.1 + (seed % 100) / 700, [seed]);
  const phase = useMemo(() => (seed % 628) / 100, [seed]);

  // Bake the (static) swarm once per palette.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      scl.setScalar(inst.scale * SCALE_BOOST);
      mtx.compose(inst.rest, inst.quat, scl);
      mesh.setMatrixAt(i, mtx);
      mesh.setColorAt(i, inst.color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [instances]);

  useFrame((state, delta) => {
    const g = groupRef.current;
    if (!g) return;
    const t = state.clock.elapsedTime;
    g.rotation.y += spin * delta;
    breatheRef.current = 1 + 0.04 * Math.sin(t * 1.2 + phase);
    const target = MINI_SIZE * (hoverRef.current ? 1.18 : 1) * breatheRef.current;
    const cur = g.scale.x;
    g.scale.setScalar(cur + (target - cur) * Math.min(1, delta * 8));
  });

  return (
    <group ref={groupRef} scale={MINI_SIZE}>
      <instancedMesh ref={meshRef} args={[undefined, undefined, MINI_COUNT]} material={material} castShadow={false}>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
      {/* glowing core — same as the full blob's orb */}
      <mesh>
        <sphereGeometry args={[0.57, 32, 24]} />
        <meshBasicMaterial color={orbColor} toneMapped={false} />
      </mesh>
    </group>
  );
});
