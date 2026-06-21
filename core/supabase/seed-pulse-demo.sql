-- Pulse — the Data-mode demo module (P2b).
--
-- Ships its ENTIRE UI as data: a UI Schema v2 doc carried in manifest.ui.schema,
-- rendered by the shell's <SchemaRuntime> on the host kit at /m/pulse with ZERO
-- module React. Every value below binds to a REAL @spectre/sdk response shape
-- (health / monitor / usage / models), so /m/pulse shows live numbers.
--
-- DO NOT auto-apply with the rest of the schema — this is a demo seed. Run it by
-- hand when you want the Pulse slot to appear in the blob registry.
--
-- The route reads `manifest` raw, so the object-form `permissions` ({sdk:[...]})
-- passes through untouched; the schema may only call the four sdk reads granted
-- in permissions.sdk, enforced by SchemaRuntime's closed SDK_CALLS table.

insert into module_installs (module_id, version, ui_mode, manifest, status)
values (
  'pulse',
  '0.1.0',
  'data',
  '{
    "schemaVersion": 2,
    "id": "pulse",
    "label": "Pulse",
    "version": "0.1.0",
    "description": "Live core telemetry rendered from a UI Schema v2 doc — the Data-mode reference module.",
    "route": "/m/pulse",
    "icon": "Activity",
    "hint": "core vitals as data",
    "uiMode": "data",
    "sdkRange": "^1.0.0",
    "coreRange": "^1.0.0",
    "permissions": { "sdk": ["health", "monitor", "usage", "models"] },
    "ui": {
      "schema": {
        "version": 2,
        "title": "Pulse",
        "eyebrow": "SYSTEM · PULSE",
        "status": "{{data.health.status}}",
        "tone": "ok",
        "state": { "range": "monitor" },
        "data": {
          "health":  { "source": "sdk", "call": "health" },
          "mon":     { "source": "sdk", "call": "monitor", "pollMs": 10000 },
          "usage":   { "source": "sdk", "call": "usage" },
          "models":  { "source": "sdk", "call": "models" }
        },
        "actions": {
          "refresh": { "steps": [ { "step": "refetch" } ] }
        },
        "body": [
          {
            "kind": "stats",
            "label": "LIVE TELEMETRY",
            "hud": true,
            "stats": [
              { "k": "critical", "n": "{{data.mon.summary.criticals}}", "counter": true, "color": "var(--color-error)" },
              { "k": "warnings", "n": "{{data.mon.summary.warnings}}", "counter": true, "color": "var(--color-warn)" },
              { "k": "messages", "n": "{{data.usage.totals.messages}}", "counter": true }
            ]
          },
          {
            "kind": "panel",
            "icon": "Heart",
            "label": "CORE LINK",
            "title": "{{data.health.name}}",
            "rows": [
              { "label": "status",      "value": "{{data.health.status}}" },
              { "label": "version",     "value": "{{data.health.version}}" },
              { "label": "api version", "value": "{{data.health.coreApiVersion}}" },
              { "label": "cc token",    "value": "{{data.health.claudeCodeToken.status}}" },
              { "label": "providers",   "value": "{{data.models.providers}}" }
            ]
          },
          {
            "kind": "panel",
            "icon": "Cpu",
            "label": "USAGE",
            "title": "Last 24h",
            "rows": [
              { "label": "tokens",        "value": "{{data.usage.totals.tokens}}" },
              { "label": "messages",      "value": "{{data.usage.totals.messages}}" },
              { "label": "estimated usd", "value": "{{data.usage.totals.estimatedUsd}}" },
              { "label": "window (h)",    "value": "{{data.usage.windowHours}}" }
            ]
          },
          {
            "kind": "actionRow",
            "buttons": [
              { "label": "Refresh", "action": "refresh", "variant": "primary" }
            ]
          },
          {
            "kind": "segmented",
            "bind": "range",
            "options": [
              { "value": "monitor", "label": "Events" },
              { "value": "models",  "label": "Models" }
            ]
          },
          {
            "kind": "list",
            "when": { "path": "state.range", "op": "==", "value": "monitor" },
            "label": "event log",
            "from": "mon.events",
            "empty": "No issues logged.",
            "rowHead": "{{item.component}} · {{item.severity}}",
            "rowMeta": "{{item.created_at}}",
            "rowBody": "{{item.description}}"
          },
          {
            "kind": "table",
            "when": { "path": "state.range", "op": "==", "value": "models" },
            "from": "models.models",
            "empty": "No models.",
            "columns": [
              { "key": "displayName", "label": "Model" },
              { "key": "provider",    "label": "Provider" },
              { "key": "costTier",    "label": "Cost" },
              { "key": "speed",       "label": "Speed" }
            ]
          }
        ]
      }
    }
  }'::jsonb,
  'installed'
)
on conflict (module_id) do update
  set version  = excluded.version,
      ui_mode  = excluded.ui_mode,
      manifest = excluded.manifest,
      status   = excluded.status;
