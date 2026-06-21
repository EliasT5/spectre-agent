# Third-Party Notices

Spectre is distributed under the MIT License (see `LICENSE`), which covers both
halves of the project: the **shell** (this repo root) and the **core**
(`core/`), built from source. It bundles/depends on third-party open-source
software, and at runtime it pulls a few third-party container images. Full
license texts ship inside each npm package under `node_modules/<pkg>/LICENSE`.
Notable acknowledgements below.

## Shell npm dependencies (permissive: MIT / ISC / BSD)

Used under their respective permissive licenses (copyright © their authors):

- **next** — MIT (Vercel)
- **react**, **react-dom** — MIT (Meta)
- **three**, **@react-three/fiber**, **@react-three/drei**,
  **@react-three/postprocessing**, **postprocessing** — MIT
- **framer-motion** — MIT
- **lucide-react** — ISC
- **react-markdown**, **remark-gfm** — MIT
- **@supabase/supabase-js** — MIT

## Core npm dependencies (`core/`)

The core is a Bun/Hono backend built from source. Notable dependencies, grouped
by license:

**MIT**

- **hono** — the HTTP framework
- **zod** — schema validation
- **@modelcontextprotocol/sdk** — the MCP broker
- **@anthropic-ai/sdk**, **openai**, **@google/genai** — provider SDKs
- **@supabase/supabase-js**, **@supabase/ssr** — database client
- **pdfjs-dist**, **unpdf** — PDF parsing for the document library
- **@azure/identity**, **@azure/keyvault-secrets** — optional Azure Key Vault
  secret backend

**Apache-2.0**

- **livekit-client**, **livekit-server-sdk** — voice/realtime transport

**MPL-2.0**

- **web-push** — Web Push notifications. Mozilla Public License 2.0 is a weak
  copyleft license at the file level; the package is used unmodified as an npm
  dependency.

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
