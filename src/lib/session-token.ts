/**
 * HMAC-signed session token — shared by the Edge middleware (proxy.ts) and Node
 * route handlers (session.ts). Uses Web Crypto only (no node:crypto, no
 * next/headers) so it runs unchanged in BOTH runtimes.
 *
 * A session cookie is `<randomId>.<issuedAtMs>.<base64url(HMAC-SHA256)>`. The
 * gate verifies the signature with SESSION_SECRET — a bare or forged cookie no
 * longer passes (the previous scheme only checked the cookie existed).
 */

const enc = new TextEncoder();

function b64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return b64url(sig);
}

/** Constant-time string compare (avoids leaking the signature via timing). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Mint a fresh signed session token. Requires SESSION_SECRET. */
export async function signSession(secret: string): Promise<string> {
  if (!secret) throw new Error("SESSION_SECRET is not set");
  const id = b64url(crypto.getRandomValues(new Uint8Array(18)).buffer);
  const payload = `${id}.${Date.now()}`;
  const sig = await hmac(secret, payload);
  return `${payload}.${sig}`;
}

/** True only if `token` carries a valid signature for `secret`. */
export async function verifySession(
  token: string | undefined,
  secret: string,
): Promise<boolean> {
  if (!token || !secret) return false;
  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0) return false;
  const payload = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  if (!sig) return false;
  const expected = await hmac(secret, payload);
  return timingSafeEqual(sig, expected);
}
