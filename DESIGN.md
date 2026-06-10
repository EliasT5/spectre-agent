# Spectre shell — design system ("Living Instrument")

The shell is the cockpit of a voxel intelligence, not a chatbot with a
dashboard. Everything reads as one instrument: a deep void lit by violet
bioluminescence, glass panels with HUD detailing, monospace technical readouts,
and the blob constellation as a star-map you travel through.

This doc is the contract for building consistent UI. **If a module follows it,
it looks first-class for free.**

## Aesthetic direction

- **Tone**: retro-futuristic instrument, refined (not flashy gamer sci-fi).
- **The one unforgettable thing**: pulling back from your blob into a
  depth-mapped constellation of *living, coloured mini-swarms* that halo on
  hover, then travelling into one.
- **Dominant + accent**: a near-black violet void dominates; violet is the
  living accent; magenta is the sharp highlight; each blob carries its own hue.

## Type

Loaded via `next/font` in `app/layout.tsx`, exposed as CSS variables.
Deliberately **not** Inter/Roboto/Space Grotesk.

| Role | Font | Variable | Use |
|---|---|---|---|
| Display / labels | Chakra Petch | `--font-display` | headings, buttons, blob names |
| Body | Sora | `--font-body` | prose, inputs |
| Data / readouts | JetBrains Mono | `--font-mono` | tags, metadata, status, the clock |

## Tokens

All in `:root` in `app/globals.css`. Use these, never raw hex.

- **Depth**: `--void --abyss --glass --glass-2 --glass-bright`
- **Edges**: `--hairline --hairline-2 --edge-hi` (violet-tinted, never flat grey)
- **Ink**: `--ink --ink-2 --ink-3 --ink-faint`
- **Accents**: `--violet --violet-bright --violet-deep --magenta --amber --danger`
- **Glow**: `--glow --glow-soft --glow-ring --inset-hi`
- **Geometry/motion**: `--r-sm --r --r-lg --pill --ease --ease-out`

The page atmosphere (gradient mesh + film grain + faint grid) is painted by
`body::before/::after`; the 3D home paints its own scene over it.

## The UI kit (`@/components/ui`)

Import: `import { TabShell, Panel, Chip, SchemaTab, templates } from "@/components/ui"`.

Imperative primitives (in `kit.tsx`) — assemble these for interactive surfaces:

- `TabShell({ title, status?, back?, children })` — the consistent chrome
  (Spectre mark + title + live status pill + scroll body). Every tab uses it.
- `Panel({ label?, meta?, children })` — a glass instrument panel w/ corner-tick.
- `Row`, `StatGrid`+`Stat`, `Field`, `Toolbar` — layout building blocks.
- `Chip({ on?, color?, onClick? })` — mono pill (filter chips, severities, tags).
- `Button({ variant: primary|ghost|danger })`, `Input`, `Select`, `EmptyState`.

## The tab schema (`SchemaTab` + `templates`)

For read-mostly surfaces (status, feeds, stats), **describe the tab as data** and
the shared renderer draws it — identical to the built-ins, zero markup:

```tsx
const schema: TabSchema = {
  title: "Monitor",
  status,
  sections: [
    templates.stats([{ k: "critical", n: 0 }, { k: "warnings", n: 2 }]),
    templates.feed(items, { label: "event log", empty: "All clear ✓" }),
  ],
};
return <SchemaTab schema={schema} />;
```

Sections: `panel` (label/value rows), `stats`, `list` (a feed), `custom` (drop
to raw nodes / the imperative kit). `templates.*` are ready-made sections — the
"define a template" path. `app/monitor/page.tsx` is the reference example.

**Rule of thumb**: read-mostly → `SchemaTab` + templates. Interactive →
`TabShell` + kit. Either way you inherit the look.

## The blob constellation

- `blob-layout.ts` is the data model: blobs, their `slots` (module ids, ≤10),
  and a `color` (curated 10-hue palette; home keeps the signature violet). A
  module in no blob is **stashed** — it waits in the customize console.
- `Blob.tsx` renders the active blob; `tint` re-colours the whole swarm around
  any hue via `buildPalette()` (same fixed-seed layout, recoloured — no jump).
- `Constellation.tsx` + `MiniBlob.tsx` render the *other* blobs in their actual
  voxel form (a tinted mini-swarm + bright core + a fresnel halo that brightens
  on hover). Scroll out far (camera distance bands in `BlobScene.tsx`) to reach
  them; click one to travel.
- `CustomizeSlots.tsx` is the one console: recolour (swatch), rename (inline),
  travel, **drag-and-drop** chips between blobs, and a **Stash** drop zone.

## Adding a module's UI

1. Register it in `lib/modules.ts` (id, label, route, lucide icon).
2. Create the route at `app/<id>/page.tsx`.
3. Build the UI with the kit / schema above — do **not** hand-roll chrome.
4. Talk to the core only through `@/lib/sdk` (`spectre.*`). The slot appears on a
   blob automatically; drag it where you want in the customize console.
