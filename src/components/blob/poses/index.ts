import type { Pose } from "./types";

/**
 * Intentionally EMPTY in the public shell. The blob's choreographer + Blob.tsx
 * are copied verbatim from the core, but with no registered poses the
 * choreographer can never pick one to play (pickAutoCyclePose returns null),
 * so the blob only ever does its idle motion — no emotes. The pose library is
 * part of the (private, deferred) emote subsystem and is not shipped here.
 */
export const POSES: Record<string, Pose> = {};

export function getPose(_name: string): Pose | undefined {
  return undefined;
}

export function listPoses(): string[] {
  return [];
}
