import { createServiceSupabase } from "@/lib/supabase/server";

/**
 * Runtime GitHub token — set entirely from Settings (no .env edit), stored in
 * `app_config`, hydrated at startup. Used by the Workspace clone/push flow: the
 * value is injected into the isolated workspace-service per-request by the trusted
 * shell proxy (as x-gh-token), never handed to the sidecar's env. Mirrors the CLI
 * token pattern in core/src/lib/ai/cli-gate.ts. The value is never echoed to the
 * UI — only `hasGithubToken()`.
 */
const KEY = "github_token";
let token: string | null = null;

export function getGithubToken(): string | null {
  return token && token.length > 0 ? token : null;
}

export function hasGithubToken(): boolean {
  return !!(token && token.length > 0);
}

export async function setGithubToken(next: string): Promise<void> {
  token = next && next.trim() ? next.trim() : null;
  try {
    const supabase = createServiceSupabase();
    await supabase.from("app_config").upsert(
      { key: KEY, value: JSON.stringify(token), updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  } catch {
    /* fail-soft: the in-memory value still works for this process */
  }
}

/** Seed from app_config at startup. Idempotent; fail-soft. */
export async function hydrateGithubToken(): Promise<void> {
  try {
    const supabase = createServiceSupabase();
    const { data } = await supabase.from("app_config").select("value").eq("key", KEY).maybeSingle();
    if (data?.value) {
      const v = JSON.parse(data.value as string);
      token = typeof v === "string" && v.length > 0 ? v : null;
    }
  } catch {
    /* fail-soft: no token until set from the UI */
  }
}

void hydrateGithubToken();
