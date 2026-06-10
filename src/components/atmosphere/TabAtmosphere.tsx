"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { ScreenQuad } from "@react-three/drei";
import { useMemo, useRef } from "react";
import { ShaderMaterial, Vector2 } from "three";

/**
 * The living atmosphere behind the data tabs — a full-screen GLSL field that
 * bridges the home blob's WebGL aesthetic into the flat surfaces. A slow
 * domain-warped fbm flow tinted in Spectre's palette (near-black → indigo →
 * violet → a breath of magenta), kept dark and vignetted so the glass panels
 * still read, with fine grain so it never bands. Ambient, not loud — depth that
 * drifts. One Canvas for the whole tab session (mounted once, see
 * RouteAtmosphere); pointer-events are off so it never eats clicks.
 */

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uRes;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float a = hash(i), b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; }
    return v;
  }

  void main() {
    float aspect = uRes.x / max(uRes.y, 1.0);
    vec2 p = vUv;
    p.x *= aspect;
    float t = uTime * 0.025;

    // domain warp — two layers of flow feeding a third for organic drift
    vec2 q = vec2(fbm(p * 1.2 + vec2(0.0, t)), fbm(p * 1.2 + vec2(5.2, -t)));
    vec2 r = vec2(
      fbm(p * 1.35 + q * 1.6 + vec2(1.7, 9.2) + t * 0.5),
      fbm(p * 1.35 + q * 1.6 + vec2(8.3, 2.8) - t * 0.5)
    );
    float f = fbm(p * 1.25 + r * 1.7);

    // palette (kept muted — it is a backdrop, not a hero)
    vec3 base    = vec3(0.018, 0.018, 0.026);
    vec3 indigo  = vec3(0.388, 0.400, 0.945);
    vec3 violet  = vec3(0.545, 0.361, 0.965);
    vec3 magenta = vec3(0.925, 0.282, 0.600);

    vec3 col = base;
    col = mix(col, indigo * 0.42, smoothstep(0.35, 0.78, f));
    col = mix(col, violet * 0.50, smoothstep(0.55, 0.98, f + 0.10 * r.x));
    col += magenta * 0.08 * smoothstep(0.72, 1.0, f) * r.y;
    col *= 0.6;

    // vignette so the edges stay dark and panels keep contrast
    float vig = smoothstep(1.25, 0.25, length(vUv - 0.5));
    col *= mix(0.42, 1.0, vig);

    // fine grain — kills banding, adds film texture
    col += hash(vUv * uRes * 0.5 + t) * 0.04 - 0.02;

    // A bare ShaderMaterial gets no colorspace encode (three only encodes when
    // the shader #includes <colorspace_fragment>), and the drawing buffer is
    // tagged sRGB — so these sRGB-authored values are written as-is. Output raw;
    // the near-black base lands at #050507.
    gl_FragColor = vec4(max(col, 0.0), 1.0);
  }
`;

function Field() {
  const mat = useRef<ShaderMaterial>(null);
  const uniforms = useMemo(
    () => ({ uTime: { value: 0 }, uRes: { value: new Vector2(1, 1) } }),
    [],
  );
  useFrame((state) => {
    const m = mat.current;
    if (!m) return;
    m.uniforms.uTime.value = state.clock.elapsedTime;
    m.uniforms.uRes.value.set(state.size.width, state.size.height);
  });
  return (
    <ScreenQuad>
      <shaderMaterial
        ref={mat}
        uniforms={uniforms}
        vertexShader={VERT}
        fragmentShader={FRAG}
        depthTest={false}
        depthWrite={false}
      />
    </ScreenQuad>
  );
}

export function TabAtmosphere() {
  return (
    <Canvas
      dpr={[1, 1.5]}
      gl={{ antialias: false, powerPreference: "low-power", failIfMajorPerformanceCaveat: false }}
      style={{ position: "absolute", inset: 0 }}
    >
      <Field />
    </Canvas>
  );
}
