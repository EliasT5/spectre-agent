"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { Pose } from "./poses/types";
import { POSES, getPose, listPoses } from "./poses";

const PREP = 0.8;     // seconds to rotate the group to pose.facing
const ENTER = 0.7;
const EXIT = 0.7;
const IDLE_MIN = 25;
const IDLE_MAX = 40;
const RECENT_BLOCK = 3;

export interface PlayPoseOptions {
  /** Override the pose's default hold (seconds at full strength). */
  hold?: number;
}

export interface ActivePose {
  pose: Pose;
  /** Seconds since epoch (performance.now() / 1000) when the pose entered. */
  startedAt: number;
  /** PREP + ENTER + hold + EXIT — total seconds the pose runs. */
  durationTotal: number;
  /** Resolved hold (from options or pose default) — convenience. */
  hold: number;
}

export interface ChoreographerSnapshot {
  active: ActivePose | null;
  /** Envelope at the time of the last snapshot emit. Per-frame readers
   *  should call `choreographer.getEnvelope()` directly to avoid the
   *  React re-render path. */
  envelope: number;
  recentNames: readonly string[];
  /** Bumps on each emit so React can detect change without deep equality. */
  rev: number;
}

type Listener = () => void;

const listeners = new Set<Listener>();

let active: ActivePose | null = null;
let queued: string | null = null;
const recentNames: string[] = [];
let lastInteractionAt = nowSeconds();
let nextAutoCycleAt = lastInteractionAt + pickIdleWindow();
let snapshot: ChoreographerSnapshot = {
  active: null,
  envelope: 0,
  recentNames: [],
  rev: 0,
};

function nowSeconds(): number {
  if (typeof performance === "undefined") return 0;
  return performance.now() / 1000;
}

function pickIdleWindow(): number {
  return IDLE_MIN + Math.random() * (IDLE_MAX - IDLE_MIN);
}

function emit(): void {
  snapshot = {
    active,
    envelope: computeEnvelope(nowSeconds()),
    recentNames: recentNames.slice(),
    rev: snapshot.rev + 1,
  };
  for (const l of listeners) l();
}

function computeEnvelope(now: number): number {
  if (!active) return 0;
  const t = now - active.startedAt;
  if (t <= 0) return 0;
  if (t >= active.durationTotal) return 0;
  const enterEnd = ENTER;
  const exitStart = active.durationTotal - EXIT;
  if (t < enterEnd) {
    const r = t / ENTER;
    return smoothstep01(r);
  }
  if (t > exitStart) {
    const r = (active.durationTotal - t) / EXIT;
    return smoothstep01(Math.max(0, Math.min(1, r)));
  }
  return 1;
}

function smoothstep01(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * (3 - 2 * x);
}

function startPose(pose: Pose, opts?: PlayPoseOptions): void {
  const hold = opts?.hold ?? pose.hold;
  const now = nowSeconds();
  const swap = active != null && computeEnvelope(now) > 0;
  // On swap, skip the enter ramp by backdating startedAt by ENTER.
  const startedAt = swap ? now - ENTER : now;
  active = {
    pose,
    startedAt,
    durationTotal: ENTER + hold + EXIT,
    hold,
  };
  pushRecent(pose.name);
  lastInteractionAt = now;
  nextAutoCycleAt = now + pickIdleWindow();
  emit();
}

function pushRecent(name: string): void {
  recentNames.push(name);
  while (recentNames.length > RECENT_BLOCK) recentNames.shift();
}

function pickAutoCyclePose(): Pose | null {
  const names = listPoses();
  if (names.length === 0) return null;
  const eligible: Pose[] = [];
  let totalWeight = 0;
  for (const n of names) {
    if (recentNames.includes(n)) continue;
    const p = POSES[n];
    if (!p) continue;
    eligible.push(p);
    totalWeight += Math.max(0, p.weight);
  }
  // Fallback: if all candidates were blocked or weights were zero, drop
  // the recency filter so we always pick something.
  let pool = eligible;
  let weightSum = totalWeight;
  if (pool.length === 0 || weightSum <= 0) {
    pool = [];
    weightSum = 0;
    for (const n of names) {
      const p = POSES[n];
      if (!p) continue;
      pool.push(p);
      weightSum += Math.max(0, p.weight);
    }
  }
  if (pool.length === 0 || weightSum <= 0) return null;
  let r = Math.random() * weightSum;
  for (const p of pool) {
    r -= Math.max(0, p.weight);
    if (r <= 0) return p;
  }
  return pool[pool.length - 1];
}

export const choreographer = {
  playPose(name: string, opts?: PlayPoseOptions): boolean {
    const pose = getPose(name);
    if (!pose) return false;
    startPose(pose, opts);
    return true;
  },
  stop(): void {
    if (!active) return;
    const now = nowSeconds();
    const t = now - active.startedAt;
    const exitStart = active.durationTotal - EXIT;
    if (t < exitStart) {
      // Jump to start of exit ramp.
      active = {
        ...active,
        startedAt: now - exitStart,
      };
      emit();
    }
  },
  chain(names: string | string[]): void {
    const next = Array.isArray(names) ? names[0] ?? null : names;
    queued = next;
  },
  markInteraction(): void {
    const now = nowSeconds();
    lastInteractionAt = now;
    nextAutoCycleAt = now + pickIdleWindow();
  },
  tick(now: number): void {
    if (active) {
      const t = now - active.startedAt;
      if (t >= active.durationTotal) {
        active = null;
        // Drain queue if anything was chained.
        if (queued) {
          const next = queued;
          queued = null;
          const pose = getPose(next);
          if (pose) {
            startPose(pose);
            return;
          }
        }
        // After a pose ends, defer next auto-cycle.
        lastInteractionAt = now;
        nextAutoCycleAt = now + pickIdleWindow();
        emit();
      }
      return;
    }
    if (now >= nextAutoCycleAt) {
      const pose = pickAutoCyclePose();
      if (pose) {
        startPose(pose);
      } else {
        // Empty registry — recheck shortly.
        nextAutoCycleAt = now + pickIdleWindow();
      }
    }
  },
  getEnvelope(): number {
    return computeEnvelope(nowSeconds());
  },
  getActive(): ActivePose | null {
    return active;
  },
};

declare global {
  interface Window {
    spectreKiosk?: {
      playPose: (name: string, opts?: PlayPoseOptions) => boolean;
      stop: () => void;
      chain: (names: string | string[]) => void;
      listPoses: () => string[];
    };
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ChoreographerSnapshot {
  return snapshot;
}

function getServerSnapshot(): ChoreographerSnapshot {
  return snapshot;
}

let mountCount = 0;

export function useChoreographer(): ChoreographerSnapshot {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    mountCount++;
    if (typeof window !== "undefined") {
      window.spectreKiosk = {
        playPose: (name, opts) => choreographer.playPose(name, opts),
        stop: () => choreographer.stop(),
        chain: (names) => choreographer.chain(names),
        listPoses: () => listPoses(),
      };
    }

    let es: EventSource | null = null;
    if (typeof window !== "undefined" && typeof EventSource !== "undefined") {
      try {
        es = new EventSource("/api/kiosk/pose");
        es.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data) as {
              kind?: string;
              name?: string;
              hold?: number;
              mood?: string;
              color?: { r?: number; g?: number; b?: number };
            };
            if (
              data.kind === "set-orb-mood" &&
              typeof data.mood === "string" &&
              data.color &&
              typeof data.color.r === "number" &&
              typeof data.color.g === "number" &&
              typeof data.color.b === "number"
            ) {
              window.dispatchEvent(
                new CustomEvent("spectre-kiosk-data", { detail: data }),
              );
              return;
            }
            if (typeof data.name === "string") {
              choreographer.playPose(data.name, { hold: data.hold });
            }
          } catch {
            // ignore malformed payloads
          }
        };
        es.onerror = () => {
          // Browser auto-reconnects EventSource; nothing to do.
        };
      } catch {
        es = null;
      }
    }

    return () => {
      mountCount--;
      if (es) es.close();
      if (mountCount === 0 && typeof window !== "undefined") {
        delete window.spectreKiosk;
      }
    };
  }, []);

  return snap;
}


// Snapshot of the current pose's time-axis for renderers that need
// to know if we're in PREP (rotate to facing) vs ENTER/HOLD/EXIT.
// Returns null if no pose is active.
export function getPoseTimes(now: number): {
  age: number;
  prepDone: number;     // 0..1 — how far through the PREP rotation
  envelope: number;     // 0..1 — the regular pose envelope (0 during PREP)
  facing: number;
} | null {
  const active = choreographer.getActive();
  if (!active) return null;
  const age = now - active.startedAt;
  const facing =
    typeof active.pose.facing === "number" ? active.pose.facing : 0;
  if (age < PREP) {
    return { age, prepDone: age / PREP, envelope: 0, facing };
  }
  return {
    age,
    prepDone: 1,
    envelope: choreographer.getEnvelope(),
    facing,
  };
}
