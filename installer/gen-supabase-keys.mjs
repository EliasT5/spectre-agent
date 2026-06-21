#!/usr/bin/env node
/**
 * Generate the LOCAL self-hosted Supabase secrets + the HS256 anon/service JWT keys
 * (signed from JWT_SECRET, exactly as Supabase's generate-keys does), writing
 * local-db/.env. Re-run-safe: keeps any existing values so the keys stay in sync
 * with the already-initialised DB. Dependency-free (Node built-ins).
 *
 *   node installer/gen-supabase-keys.mjs        # writes local-db/.env, prints the keys
 * Exports genLocalDbEnv() for the installer (Local DB choice).
 *
 * KEY ROTATION
 * -----------
 * The anon/service JWTs are signed with JWT_SECRET and have a 10-year expiry.
 * The long expiry is intentional for a loopback-only local stack (no browser
 * session refresh plumbing). The gateway (Kong) and PostgREST both derive trust
 * from JWT_SECRET — rotating the secret is the effective revocation mechanism.
 *
 * To rotate:
 *   1. Delete (or rename) local-db/.env so the seed is cleared.
 *   2. Run:  node installer/gen-supabase-keys.mjs
 *      → new JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY written to local-db/.env.
 *   3. Re-set the DB's app.settings.jwt_secret to match the new JWT_SECRET:
 *        docker exec spectre-db psql -U supabase_admin -d postgres \
 *          -c "ALTER DATABASE postgres SET \"app.settings.jwt_secret\" TO '<new-JWT_SECRET>';"
 *   4. Restart the stack:  docker compose -f local-db/docker-compose.yml restart
 *   5. Update any clients/services that carry the old ANON_KEY or SERVICE_ROLE_KEY.
 *
 * NOTE: if this stack is exposed beyond loopback for any reason, rotate immediately
 * and consider shortening JWT_EXPIRY (env var, passed to PostgREST as PGRST_APP_SETTINGS_JWT_EXP).
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(HERE, "..", "local-db", ".env");

const b64url = (s) => Buffer.from(s).toString("base64url");
function signJwt(payload, secret) {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
function parseEnv(s) {
  const o = {};
  for (const l of s.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) o[m[1]] = m[2];
  }
  return o;
}

export function genLocalDbEnv() {
  const seed = existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH, "utf8")) : {};
  const JWT_SECRET = seed.JWT_SECRET || randomBytes(32).toString("hex");
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 60 * 60 * 24 * 365 * 10; // 10-year expiry — loopback-only local stack; see KEY ROTATION above to rotate
  const ANON_KEY = seed.ANON_KEY || signJwt({ role: "anon", iss: "supabase", iat, exp }, JWT_SECRET);
  const SERVICE_ROLE_KEY =
    seed.SERVICE_ROLE_KEY || signJwt({ role: "service_role", iss: "supabase", iat, exp }, JWT_SECRET);

  const env = {
    POSTGRES_PASSWORD: seed.POSTGRES_PASSWORD || randomBytes(16).toString("hex"),
    POSTGRES_DB: "postgres",
    POSTGRES_PORT: "5432",
    JWT_SECRET,
    JWT_EXPIRY: "3600",
    ANON_KEY,
    SERVICE_ROLE_KEY,
    SECRET_KEY_BASE: seed.SECRET_KEY_BASE || randomBytes(32).toString("hex"), // 64 chars (Phoenix)
    KONG_HTTP_PORT: seed.KONG_HTTP_PORT || "8000",
    DASHBOARD_USERNAME: "supabase",
    DASHBOARD_PASSWORD: seed.DASHBOARD_PASSWORD || randomBytes(8).toString("hex"),
    PGRST_DB_SCHEMAS: "public",
  };
  writeFileSync(ENV_PATH, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  return env;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const e = genLocalDbEnv();
  console.log("wrote local-db/.env (gitignored)");
  console.log("ANON_KEY=" + e.ANON_KEY);
  console.log("SERVICE_ROLE_KEY=" + e.SERVICE_ROLE_KEY);
}
