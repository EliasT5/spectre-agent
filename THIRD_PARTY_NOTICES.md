# Third-Party Notices

Spectre (the `spectre-agent` shell) is distributed under the MIT License (see
`LICENSE`). It bundles/depends on third-party open-source software, and at runtime
it pulls a few third-party container images. Full license texts ship inside each
npm package under `node_modules/<pkg>/LICENSE`. Notable acknowledgements below.

## npm dependencies (permissive: MIT / ISC / BSD)

Used under their respective permissive licenses (copyright © their authors):

- **next** — MIT (Vercel)
- **react**, **react-dom** — MIT (Meta)
- **three**, **@react-three/fiber**, **@react-three/drei**,
  **@react-three/postprocessing**, **postprocessing** — MIT
- **framer-motion** — MIT
- **lucide-react** — ISC
- **react-markdown**, **remark-gfm** — MIT
- **@supabase/supabase-js** — MIT

## Bundled / pulled container images (runtime, not redistributed in this repo)

The `docker-compose.yml` stack pulls these images at runtime; they are not
vendored into this repository. Each retains its own license:

- **LiteLLM** (`ghcr.io/berriai/litellm`) — MIT. The provider-agnostic gateway.
- **Playwright + headless Chromium** (`mcr.microsoft.com/playwright`, behind the
  optional `screenshot` profile) — Playwright: Apache-2.0; Chromium: BSD-3-Clause.
- **Supabase self-host** images for the optional local database — `supabase/postgres`
  (PostgreSQL, PostgreSQL License), `postgrest/postgrest` (PostgREST, MIT),
  `supabase/realtime` (Apache-2.0), `kong` (Apache-2.0).

---

This list covers the primary dependencies; it is not exhaustive. Each installed
package's authoritative license text is in `node_modules/<package>/LICENSE`. If you
redistribute Spectre, retain these notices and the bundled license files.
