---
name: build-module
description: How to build a Spectre module (a blob slot) — the module types, the @spectre/sdk contract, the permission model, and the verify gate
trigger: When the user asks to build, add, scaffold, or port a Spectre module, tab, or blob slot
autonomy: level-2
---

# Build a Module

A **module** is a slot orbiting the blob: a route on the PUBLIC shell that talks
to the core **only** through the `@spectre/sdk` contract over the `/api`
proxy. The core is the stable foundation; modules are the growable surface. All
module work happens in the **shell repo** (`jerome_prod`) — **never** the core.

## 1. Pick the module type

1. **Built-in native slot** *(default — most reliable, the 90% case)*. A real
   route in the shell repo. Use for first-party features (chat, memory, monitor,
   tempus are these). `uiMode: "native"`.
2. **Data mode** (`uiMode: "data"`). The module ships a **UI Schema v2** (JSON);
   the host renders it via `<SchemaRuntime>` on the shared kit, so it looks
   built-in with **zero module React**. Use for data-driven dashboards/forms,
   especially third-party. *(P2b — working; see `/m/pulse`.)*
3. **Code mode** (`uiMode: "code"`). Real React in a sandboxed opaque iframe
   (`<ModuleFrame>` + the SDK bridge). For rich custom UI. **The sandbox runtime
   is P2d (still a placeholder) — prefer native or data until it lands.**

## 2. Path A — built-in native slot (the common case)

1. **Manifest entry** — add to `MODULES` in `src/lib/modules.ts`:
   ```ts
   { id: "weather", label: "Weather", route: "/weather", icon: "Box", sdk: 1 }
   ```
   The slot appears on the blob automatically (the launcher renders `MODULES`).
2. **Route** — `src/app/weather/page.tsx`, a `"use client"` tab built **only** on
   the `@spectre/ui` kit (`TabShell` + `Panel` + the HUD primitives) and the
   `@/lib/sdk` contract. Copy `src/app/monitor/page.tsx` for shape and the Glass
   HUD look (eyebrow `SYSTEM · <LABEL>`, glass panels, mono telemetry,
   gradient-text numbers).
3. **Resilience** — `src/app/weather/error.tsx` rendering `<ErrorTile scope="weather" />`.
4. **Data** — reach the core **only** through `spectre.*`. Never fetch the core
   directly; never import server/auth/provider code.

## 3. Path B — Data-mode module (declarative / downloadable)

Ship a `spectre.module.json` (`ModuleManifestV2`, see `src/lib/module-manifest.ts`):
```jsonc
{
  "schemaVersion": 2,
  "id": "weather", "label": "Weather", "version": "1.0.0",
  "route": "/m/weather", "icon": "Box",
  "uiMode": "data",
  "permissions": { "sdk": ["monitor", "config"] },   // ← the Data-mode gate
  "ui": { /* UI Schema v2: closed widget set rendered on the host kit */ }
}
```
- The host renders `ui` via `<SchemaRuntime>` — **`custom` UI is forbidden in Data
  mode** (use Code mode for that). Widgets: panel/stats/list/metric/form/table/…
- The schema's data sources may only call `@spectre/sdk` paths listed in
  `permissions.sdk` (default-deny). No `eval`; the DSL is resolved by the runtime.

## 4. The contract — `@spectre/sdk` (`src/lib/sdk.ts`)

Modules call `spectre.*`, which routes through the shell proxy (CORE_TOKEN
injected) to the core's loopback port. Never call the core directly.
- `spectre.memory.search / list / add / forget`
- `spectre.chat.newThread / enqueue / stop`
- `spectre.monitor()` — recent debug/health events
- `spectre.config.get / set(key, value)`
- `spectre.raw(path, init)` — escape hatch for un-typed endpoints

`SDK_VERSION` + the manifest's `sdk` / `sdkRange` / `coreRange` let the shell
reject a module built against an incompatible contract.

## 5. Hard rules (non-negotiable)

- The core is the stable foundation. **Never** edit the core, `src/lib/sdk.ts`
  internals, `globals.css`, or shared kit files.
- Talk to the core **only** through `spectre.*` over `/api`.
- One module = one slot = one route. Self-contained + resilient (`error.tsx`).
- Match the design DNA: near-black void, indigo→violet gradient, frosted glass,
  mono telemetry — don't invent a new look.
- `permissions.sdk` is default-deny: a data/code module can only call the sdk
  paths it lists. (`core` / `network` / `data` / `scopes` are forward-looking —
  the capability shim that enforces them is P2c.)

## 6. How modules ship & grow

- **Built-ins**: `BUILTINS` (core `src/lib/modules/builtins.ts`) + `MODULES`
  (shell). `GET /api/modules` returns installed-merged-over-builtins; the shell
  registry consumes it. Native slots open their real route; `data`/`code` open
  `/m/<id>`.
- **Workshop**: the self-evolution worker scaffolds modules into the **shell**
  repo (never the core), commits to `workshop/<id>`, and on approval the shell
  rebuilds with the new slot live. Use the `create-module` workshop task.
- **Installed (third-party)**: rows with `status: 'installed'` carry their
  manifest. Install / signing / sandbox enforcement are P2c–P2f (forthcoming) —
  until then, prefer native + data modules.

## 7. Verify gate (always, before claiming done)

- `npx tsc --noEmit` clean (in every repo you touched).
- **Open it in a browser.** A slot that 404s or a blank tab is **not done** —
  a passing type-check is not a working feature.
- You did not edit `globals.css`, the shared kit, the core, or the SDK internals.
