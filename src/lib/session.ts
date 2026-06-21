import { cookies } from "next/headers";
import crypto from "crypto";
import { signSession } from "./session-token";

/**
 * PIN auth lives in the shell (a browser-cookie concern). The private core
 * doesn't do PIN — it trusts the shell's CORE_TOKEN. The session cookie is an
 * HMAC-signed token (see session-token.ts); the middleware verifies the
 * signature, so a forged/bare cookie can't pass the gate.
 */

const SESSION_COOKIE = "spectre_session";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

export function hashPin(pin: string): string {
  return crypto.createHash("sha256").update(pin).digest("hex");
}

export async function verifyPin(pin: string): Promise<boolean> {
  const expectedHash = process.env.PIN_HASH;
  if (!expectedHash) return false;
  // Constant-time compare (runs in the Node PIN route, not Edge). Both sides are
  // fixed-length SHA-256 hex; a plain === would leak hash bytes via timing.
  const a = Buffer.from(hashPin(pin), "utf8");
  const b = Buffer.from(expectedHash, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function createSession(): Promise<void> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  const token = await signSession(secret);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    // Secure only in prod so plain-http localhost dev still keeps the cookie.
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
}
