import { NextRequest, NextResponse } from "next/server";
import { verifyPin, createSession } from "@/lib/session";

// Handled by the shell itself (sets the session cookie) — takes precedence over
// the /api/[...path] catch-all proxy, so it never reaches the core.

// Brute-force guard. The PIN unlocks a shell that can drive the core's
// code/shell-execution surface, so a guessable PIN is high-value. A per-process
// in-memory counter is sufficient for the single-user self-host model (one shell
// instance); it resets on restart. Locks the bucket for 15 min after 5 wrong tries.
//
// Key strategy: XFF headers are client-spoofable, so we do NOT key the bucket on
// XFF. Instead we use a single global bucket ("__global__") unless the operator
// sets TRUSTED_PROXY_IP_HEADER to the name of a header injected by a trusted
// reverse proxy (e.g. "x-real-ip" set by Caddy). With a global bucket an attacker
// cannot mint a fresh bucket by rotating header values.
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
const PIN_DELAY_MS = 400; // minimum response time (ms) to slow online brute-force
const guard = new Map<string, { fails: number; lockedUntil: number }>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function clientKey(req: NextRequest): string {
  const trustedHeader = process.env.TRUSTED_PROXY_IP_HEADER?.toLowerCase().trim();
  if (trustedHeader) {
    const val = req.headers.get(trustedHeader);
    if (val) return val.split(",")[0].trim() || "__global__";
  }
  return "__global__";
}

export async function POST(request: NextRequest) {
  const key = clientKey(request);
  const now = Date.now();
  const rec = guard.get(key);

  if (rec && rec.lockedUntil > now) {
    await sleep(PIN_DELAY_MS);
    const mins = Math.ceil((rec.lockedUntil - now) / 60000);
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${mins} min.` },
      { status: 429 },
    );
  }

  const { pin } = await request.json();

  if (!pin || typeof pin !== "string") {
    return NextResponse.json({ error: "PIN required" }, { status: 400 });
  }

  const valid = await verifyPin(pin);
  await sleep(PIN_DELAY_MS); // constant delay on every path to flatten timing

  if (!valid) {
    const fails = (rec?.fails ?? 0) + 1;
    const lockedUntil = fails >= MAX_ATTEMPTS ? now + LOCK_MS : 0;
    guard.set(key, { fails, lockedUntil });
    const left = Math.max(0, MAX_ATTEMPTS - fails);
    return NextResponse.json(
      {
        error: lockedUntil
          ? "Too many attempts. Locked for 15 minutes."
          : `Invalid PIN. ${left} attempt(s) left.`,
      },
      { status: lockedUntil ? 429 : 401 },
    );
  }

  guard.delete(key); // success clears the counter
  await createSession();
  return NextResponse.json({ success: true });
}
