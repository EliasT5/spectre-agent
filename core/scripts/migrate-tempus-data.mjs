#!/usr/bin/env node
/**
 * One-time Tempus sqlite -> Supabase migration.
 *
 * Run this only after the `tempus_*` Supabase schema has been applied:
 *
 *   NODE_PATH=<tempus-server>/node_modules node scripts/migrate-tempus-data.mjs
 *
 * Optional source DB override:
 *
 *   NODE_PATH=<tempus-server>/node_modules node scripts/migrate-tempus-data.mjs --db /path/to/tempus.db
 *
 * The script reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the
 * environment, falling back to TEMPUS_ENV_FILE (or ./.env) when either value is
 * missing. It opens the sqlite DB read-only and upserts by `id`, so rerunning
 * the script is safe. Empty/deferred Tempus tables such as settings,
 * calendar_cache, and chat_messages are intentionally not migrated here.
 */
import { createClient } from "@supabase/supabase-js";
import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { argv, env, exit } from "node:process";

const DEFAULT_DB_PATH = env.TEMPUS_DB_PATH || "./tempus.db";
const FALLBACK_ENV_PATH = env.TEMPUS_ENV_FILE || "./.env";

function loadEnv() {
  let url = env.SUPABASE_URL;
  let key = env.SUPABASE_SERVICE_ROLE_KEY;

  if ((!url || !key) && existsSync(FALLBACK_ENV_PATH)) {
    const text = readFileSync(FALLBACK_ENV_PATH, "utf8");

    for (const line of text.split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (!match) continue;

      const [, name, rawValue] = match;
      const value = rawValue.replace(/^"|"$/g, "");

      if (name === "SUPABASE_URL" && !url) url = value;
      if (name === "SUPABASE_SERVICE_ROLE_KEY" && !key) key = value;
    }
  }

  if (!url || !key) {
    console.error("missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    exit(1);
  }

  return { url, key };
}

function parseDbPath() {
  const dbArgIndex = argv.indexOf("--db");
  if (dbArgIndex === -1) return DEFAULT_DB_PATH;

  const dbPath = argv[dbArgIndex + 1];
  if (!dbPath || dbPath.startsWith("--")) {
    console.error("missing value for --db");
    exit(1);
  }

  return dbPath;
}

function tsToIso(value) {
  if (value == null) return null;

  const text = String(value);
  if (/T.*Z$/.test(text)) return text;

  // Tempus sqlite timestamps are stored as UTC: 'YYYY-MM-DD HH:MM:SS'.
  return new Date(text.replace(" ", "T") + "Z").toISOString();
}

function parseTags(value) {
  if (typeof value !== "string") return value ?? [];
  return JSON.parse(value || "[]");
}

const dbPath = parseDbPath();

if (!existsSync(dbPath)) {
  console.error("sqlite db not found:", dbPath);
  exit(1);
}

const db = new Database(dbPath, { readonly: true });
const { url, key } = loadEnv();
const supa = createClient(url, key, { auth: { persistSession: false } });

async function migrateProjects() {
  const projects = db
    .prepare("SELECT * FROM projects")
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color,
      icon: row.icon,
      description: row.description ?? "",
      is_archived: row.is_archived === 1,
      created_at: tsToIso(row.created_at),
      updated_at: tsToIso(row.updated_at),
    }));

  if (projects.length) {
    const { error } = await supa
      .from("tempus_projects")
      .upsert(projects, { onConflict: "id" });
    if (error) throw error;
  }

  console.log(`projects: ${projects.length} upserted`);
}

async function migrateTimeEntries() {
  const entries = db
    .prepare("SELECT * FROM time_entries")
    .all()
    .map((row) => ({
      id: row.id,
      project_id: row.project_id,
      description: row.description ?? "",
      start_time: tsToIso(row.start_time),
      end_time: row.end_time ? tsToIso(row.end_time) : null,
      duration_ms: row.duration_ms,
      source: row.source,
      tags: parseTags(row.tags),
      created_at: tsToIso(row.created_at),
      updated_at: tsToIso(row.updated_at),
    }));

  if (entries.length) {
    const { error } = await supa
      .from("tempus_time_entries")
      .upsert(entries, { onConflict: "id" });
    if (error) throw error;
  }

  console.log(`time_entries: ${entries.length} upserted`);
}

async function migrateActiveTimer() {
  const activeRows = db.prepare("SELECT * FROM active_timer").all();

  if (!activeRows.length) {
    console.log("active_timer: empty source - skipped");
    return;
  }

  const row = activeRows[0];
  const { error } = await supa.from("tempus_active_timer").upsert(
    {
      id: 1,
      project_id: row.project_id,
      start_time: tsToIso(row.start_time),
      pause_start: row.pause_start ? tsToIso(row.pause_start) : null,
      paused_ms: row.paused_ms,
      description: row.description ?? "",
    },
    { onConflict: "id" },
  );

  if (error) throw error;

  console.log("active_timer: 1 upserted");
}

async function main() {
  await migrateProjects();
  await migrateTimeEntries();
  await migrateActiveTimer();
}

main()
  .catch((error) => {
    console.error(error);
    exit(1);
  })
  .finally(() => {
    db.close();
  });
