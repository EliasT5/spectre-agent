import type { Color, Vector3 } from "three";

export interface PoseFrame {
  /** Pose-relative time in seconds. 0 = pose just started (counted
   *  from enter-start, so includes the 700ms ease-in). */
  t: number;
  /** Total instances in the swarm. */
  count: number;
  /** Per-instance index 0..count-1. */
  i: number;
  /** Voxel's natural rest position (swarm-group local frame). Read-only. */
  rest: Readonly<Vector3>;
  /** Voxel's outward normal. Read-only. */
  normal: Readonly<Vector3>;
}

/** Optional per-frame orb modulation. Returned from a Pose.orb()
 *  hook, blended by envelope so a pose can flex the core's size or
 *  shift its colour in sync with its animation (e.g. heart pulses
 *  red on each beat, lightning shrinks the orb to an electric
 *  pinpoint). The engine lerps each field from its natural value to
 *  the returned value as the envelope ramps.
 *
 *  Allocation-free contract: orb() is called once per frame, not
 *  per voxel, so a fresh object literal is fine here. */
export interface OrbState {
  /** Multiplier on the orb's natural breathing size. 1.0 = default. */
  scale?: number;
  /** Linear-RGB target color. Use HDR values \u003E1 for stronger bloom. */
  color?: { r: number; g: number; b: number };
}

export interface Pose {
  name: string;
  /** Hold seconds at full strength (excludes the 700ms enter + 700ms exit). */
  hold: number;
  /** Default weight for the auto-cycle weighted picker. Higher = more often.
   *  Subtle/reusable poses ~1.5; loud poses ~0.5. The registry can override. */
  weight: number;
  /** Returns the world-space pose target for this voxel. MUST write into
   *  `out` and return it (allocation-free contract — no `new Vector3()`
   *  inside this function!). */
  target(frame: PoseFrame, out: Vector3): Vector3;
  /** Optional: target group-rotation (rotation.y in radians) so the
   *  pose's local +z faces the camera before the animation runs.
   *  The choreographer adds a PREP phase before the enter ramp that
   *  rotates the swarm to this angle so e.g. the eye doesn't blink
   *  sideways. Default 0 (faces camera). */
  facing?: number;
  /** Optional: per-frame orb modulation. Called once per frame; the
   *  engine blends scale + color from natural values to whatever this
   *  returns by envelope. */
  orb?(t: number): OrbState;
  /** Optional per-voxel emission. Mark the voxel as bright by writing
   *  an HDR target color into `out` and returning true. The engine
   *  lerps the voxel's natural color → out by envelope. Allocation-
   *  free contract — no `new Color()` inside this function. */
  emission?(frame: PoseFrame, out: Color): boolean;
}
