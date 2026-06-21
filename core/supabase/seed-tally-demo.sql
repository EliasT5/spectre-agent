-- Tally — the per-module-data demo (P2c).
--
-- The first module that ships its OWN backend AS DATA and writes+reads its OWN
-- per-module data. The manifest carries:
--   * backend.routes — two declarative routes dispatched at /api/m/tally/*:
--       POST /tick   → data.append  (write a tick row into the module's namespace)
--       GET  /recent → data.rows    (read this module's recent ticks)
--   * permissions    — { "data": "rw" }  (the ONLY grant; no sdk/network/scopes)
--   * ui.schema      — a UI Schema v2 doc the shell's <SchemaRuntime> renders,
--                      whose `recent` source is a MODULE source (self-scoped to
--                      tally), the form writes state.note, and the "Tally" button
--                      POSTs /tick then refetches recent.
--
-- The capability shim hard-binds module_id='tally' on every store call, so this
-- module physically cannot read another module's data. DO NOT auto-apply with
-- the schema — run by hand. Requires module-data.sql applied first.

insert into module_installs (module_id, version, ui_mode, manifest, status)
values (
  'tally',
  '0.1.0',
  'data',
  '{
    "schemaVersion": 2,
    "id": "tally",
    "label": "Tally",
    "version": "0.1.0",
    "description": "Per-module-data demo — appends + reads its own tick log via a declarative backend.",
    "route": "/m/tally",
    "icon": "ListChecks",
    "hint": "counts its own ticks",
    "uiMode": "data",
    "sdkRange": "^1.0.0",
    "coreRange": "^1.0.0",
    "permissions": { "data": "rw" },
    "backend": {
      "routes": [
        {
          "method": "POST",
          "path": "/tick",
          "binding": "data.append",
          "args": { "collection": "ticks", "doc": { "at": "{date}", "note": "{body.note}" } }
        },
        {
          "method": "GET",
          "path": "/recent",
          "binding": "data.rows",
          "args": { "collection": "ticks", "limit": 50 }
        }
      ]
    },
    "ui": {
      "schema": {
        "version": 2,
        "title": "Tally",
        "eyebrow": "MODULE · TALLY",
        "tone": "ok",
        "state": { "note": "" },
        "data": {
          "recent": { "source": "module", "endpoint": "/recent" }
        },
        "actions": {
          "tick": {
            "steps": [
              { "step": "module", "endpoint": "/tick", "method": "POST", "body": "@form:note" },
              { "step": "setState", "patch": { "note": "" } },
              { "step": "refetch", "names": ["recent"] }
            ]
          }
        },
        "body": [
          {
            "kind": "stats",
            "label": "TALLY",
            "hud": true,
            "stats": [
              { "k": "ticks", "n": "{{data.recent.items.length}}", "counter": true }
            ]
          },
          {
            "kind": "form",
            "fields": [
              { "bind": "note", "label": "Note", "placeholder": "what happened?" }
            ]
          },
          {
            "kind": "actionRow",
            "buttons": [
              { "label": "Tally", "action": "tick", "variant": "primary" }
            ]
          },
          {
            "kind": "list",
            "label": "recent ticks",
            "from": "recent.items",
            "empty": "No ticks yet.",
            "rowHead": "{{item.doc.note}}",
            "rowMeta": "{{item.created_at}}",
            "rowBody": "{{item.id}}"
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
