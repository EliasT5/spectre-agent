-- demo-sandbox — the Code-mode isolation-pipeline demo (P2d-1).
--
-- The first `uiMode: "code"` module. It ships an UNTRUSTED vanilla-JS ESM
-- (public/sandbox/demo-sandbox.js in the shell) whose default export is
-- mount(root, { jerome }). The shell:
--   * fetches the bundle AS TEXT, SHA-384 SRI-verifies it against ui.code.integrity,
--   * runs it inside an opaque-origin (sandbox="allow-scripts") iframe under a
--     locked CSP, blob:-imported INSIDE the frame (never on the shell origin),
--   * lets it talk to the core ONLY over a permission-gated MessageChannel bridge
--     that reuses the closed read-only SDK_CALLS allowlist.
--
-- permissions.sdk grants exactly the two read calls the demo uses (health,
-- monitor); any other jerome.* call from the frame → permission_denied.
--
-- ui.code.integrity is the sha384 of the BUILT public/sandbox/demo-sandbox.js
-- (UTF-8, no BOM). If you edit that file, recompute and update this hash, or the
-- shell will refuse to run the module (integrity check failed). Compute with:
--   [Convert]::ToBase64String([Security.Cryptography.SHA384]::Create()
--     .ComputeHash([IO.File]::ReadAllBytes("...\public\sandbox\demo-sandbox.js")))
-- prefixed with "sha384-".
--
-- DO NOT auto-apply with the schema — run by hand. Requires modules.sql applied.

insert into module_installs (module_id, version, ui_mode, manifest, status)
values (
  'demo-sandbox',
  '0.1.0',
  'code',
  '{
    "schemaVersion": 2,
    "id": "demo-sandbox",
    "label": "Sandbox",
    "version": "0.1.0",
    "description": "Code-mode isolation-pipeline demo — untrusted vanilla JS in an opaque-origin sandbox, talking to the core over a permission-gated bridge.",
    "route": "/m/demo-sandbox",
    "icon": "Box",
    "hint": "untrusted code, sandboxed",
    "uiMode": "code",
    "sdkRange": "^1.0.0",
    "coreRange": "^1.0.0",
    "permissions": { "sdk": ["health", "monitor"] },
    "ui": {
      "code": {
        "entry": "/sandbox/demo-sandbox.js",
        "integrity": "sha384-j38/m+caMBaWE70WZQoThczNLkfJCxdSQiwgSOzgRPbFdB9wxWqCVHUeUi6wsk/R"
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
