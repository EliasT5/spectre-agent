// Constant-time secret comparison (node:crypto). Used to validate an
// attacker-supplied token / PIN-hash against a server secret WITHOUT leaking,
// via response timing, how many leading bytes matched.
//
// Both inputs are hashed to a fixed 32-byte SHA-256 digest BEFORE comparison so
// that (a) timingSafeEqual never sees unequal-length buffers (it throws on a
// length mismatch) and (b) the secret's own length is never revealed by the
// compare. An empty/missing operand never matches — callers should still
// fail-closed on an unconfigured secret before reaching here.
import { createHash, timingSafeEqual } from "node:crypto";

export function safeEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
