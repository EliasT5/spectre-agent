# Modules (the slot SDK)

A **module** is a slot orbiting the blob: a route in this shell (public,
user-modifiable UI) that talks to the private core **only** through the
`@spectre/sdk` contract (`src/lib/sdk.ts`) over the `/api` proxy. The core stays
the hidden moat; modules are the open, growable surface.

## Add a module (manually, or the workshop does it for you)

1. **Manifest** — add an entry to `MODULES` in `src/lib/modules.ts`:
   ```ts
   { id: "weather", label: "Weather", route: "/weather", icon: "Box", sdk: 1 }
   ```
   A slot appears on the blob automatically (the launcher renders `MODULES`).
2. **Route** — create `src/app/weather/page.tsx`. Use the SDK to reach the core:
   ```tsx
   import { spectre } from "@/lib/sdk";
   const facts = await spectre.memory.search("weather preferences");
   const reply = await spectre.chat.enqueue(threadId, "...");
   ```
   Add `SpectreBackButton` and an `error.tsx` (resilience) like the other tabs.

That's it. In dev the route is picked up immediately; in prod the workshop
commits these files to the shell repo and it rebuilds.

## The contract (`@spectre/sdk`)

Modules never call the core directly — they call `spectre.*`, which routes through
the shell proxy (CORE_TOKEN injected) to the core's loopback port:

- `spectre.memory.search/list/add/forget`
- `spectre.chat.newThread/enqueue/stop`
- `spectre.monitor()` — recent debug/health events
- `spectre.config.get/set(key, value)`
- `spectre.raw(path, init)` — escape hatch for un-typed endpoints

`SDK_VERSION` + a manifest's `sdk` field let the shell detect a module built
against an incompatible contract.

## Signing (trust for modules you didn't write)

By default the core honors any installed manifest — fine while the only ways in
(a service-role DB write, a file in your own data dir) already require owning
the box. Before installing third-party modules, turn on signing:

1. `node scripts/sign-module.mjs keygen` (in the core repo) — prints a base64url
   ed25519 public key and writes the private key file.
2. Set `SPECTRE_MODULE_TRUSTED_KEYS=<pubkey>[,<more>]` in the core's env.
3. Sign each manifest: `node scripts/sign-module.mjs sign path/to/module.json`.

With a keyring set, every non-builtin manifest (DB install or data-dir drop-in)
must carry a valid ed25519 signature from a trusted key — unsigned or tampered
manifests are hidden from `/api/modules` and refused at `/api/m` dispatch
(403 `module_untrusted`). The signature covers the whole manifest (routes,
permissions, UI bundle hash), so a signed code-mode module's SRI hash is also
tamper-proof end to end.

## Reference module

`src/app/monitor/page.tsx` — built entirely on the SDK (`spectre.monitor()`),
no special core access; it's the first non-base module and the debugging
engine's UI. Copy its shape.

## How the workshop grows the product

The self-evolution worker (in the core) targets THIS shell repo (never the
core). A `create-module` task scaffolds the manifest entry + route here, commits
to a branch, and on approval the shell rebuilds with the new slot live.

### `create-module` task template

Drop this into a `workshop_task` (the worker branches off, runs Claude with Edit
tools in the shell repo, commits to `workshop/<id>` for approval). Fill the three
slots; everything else is fixed so every generated module is consistent.

```
[create-module] <id>: <one-line purpose>

Build a new Spectre module in THIS shell repo (public UI only — never touch the
core or src/lib/sdk.ts internals). Follow the existing modules exactly:

1. Manifest: add to MODULES in src/lib/modules.ts —
   { id: "<id>", label: "<Label>", route: "/<id>", icon: "<lucide-name>", sdk: 1 }
2. Route: create src/app/<id>/page.tsx as a "use client" tab built ONLY on the
   @spectre/ui kit (TabShell + Panel + the HUD primitives) and the @/lib/sdk
   contract (spectre.memory/chat/monitor/config/raw). Match src/app/monitor/page.tsx
   for shape and the Glass HUD console look (eyebrow "SYSTEM · <LABEL>", glass
   Panels, mono telemetry, gradient-text numbers).
3. Resilience: add src/app/<id>/error.tsx rendering <ErrorTile scope="<id>" />.
4. Data: reach the core only through spectre.* — never fetch the core directly,
   never import server/auth/provider code.

Verify: `npx tsc --noEmit` is clean. Do NOT edit globals.css or shared kit files.
Commit the new files only.
```

The slot appears on the blob automatically once `MODULES` has the entry.
