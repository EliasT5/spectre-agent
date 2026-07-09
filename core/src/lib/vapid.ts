import webpush from "web-push";
import { createServiceSupabase } from "@/lib/supabase/server";

/**
 * Web-push VAPID keys — set from Settings (no .env edit), stored in app_config,
 * read at send time so a change takes effect without a restart. Falls back to the
 * VAPID_* env vars. The private key is never echoed back. Mirrors github-token.ts.
 * NOTE: NEXT_PUBLIC_VAPID_PUBLIC_KEY is read server-side only (the browser fetches
 * the public key from /api/push/vapid-public-key), so this needs no frontend rebuild.
 */
export interface Vapid { subject: string; publicKey: string; privateKey: string }

const KEY = "vapid";
let stored: Partial<Vapid> = {};

function resolve(k: keyof Vapid, env: string | undefined): string {
  const s = stored[k];
  if (s && s.trim()) return s.trim();
  return env && env.trim() ? env.trim() : "";
}

export function getVapidSubject(): string { return resolve("subject", process.env.VAPID_SUBJECT); }
export function getVapidPublicKey(): string { return resolve("publicKey", process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY); }
export function getVapidPrivateKey(): string { return resolve("privateKey", process.env.VAPID_PRIVATE_KEY); }
export function hasVapid(): boolean { return !!(getVapidSubject() && getVapidPublicKey() && getVapidPrivateKey()); }

/** Non-secret status for the UI — never returns the private key. */
export function vapidStatus() {
  return { hasKeys: hasVapid(), subject: getVapidSubject(), publicKey: getVapidPublicKey() };
}

export async function setVapid(patch: Partial<Vapid>): Promise<void> {
  const next: Partial<Vapid> = { ...stored };
  const set = (k: keyof Vapid, keepOnEmpty: boolean) => {
    const v = patch[k];
    if (typeof v !== "string") return;
    const t = v.trim();
    if (t) next[k] = t;
    else if (!keepOnEmpty) delete next[k];
  };
  set("subject", false);
  set("publicKey", false);
  set("privateKey", true); // blank = keep the stored private key
  stored = next;
  try {
    const supabase = createServiceSupabase();
    await supabase.from("app_config").upsert(
      { key: KEY, value: JSON.stringify(stored), updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  } catch {
    /* fail-soft */
  }
}

/** Generate a fresh keypair server-side and store it. Returns the public key. */
export async function generateVapid(): Promise<{ publicKey: string }> {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  await setVapid({ publicKey, privateKey });
  return { publicKey };
}

export async function hydrateVapid(): Promise<void> {
  try {
    const supabase = createServiceSupabase();
    const { data } = await supabase.from("app_config").select("value").eq("key", KEY).maybeSingle();
    if (data?.value) {
      const v = JSON.parse(data.value as string);
      if (v && typeof v === "object") stored = v as Partial<Vapid>;
    }
  } catch {
    /* fail-soft */
  }
}

void hydrateVapid();
