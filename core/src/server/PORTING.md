# Porting Spectre core routes: Next.js App Router → Hono (bun)

Replace every `src/app/api/**/route.ts` (Next) with a Hono route in
`src/server/routes/<group>.ts`, so the core compiles to a single bun binary.
The business logic in `src/lib/**` is reused **UNCHANGED** — only the HTTP layer moves.

## Structure
- One file per top-level API group: `src/server/routes/<group>.ts`, exporting
  `export const <group> = new Hono()`.
- Register routes RELATIVE to the group base (no `/api/<group>` prefix — the mount adds it).
- Mount it in `src/server/main.ts`: `app.route("/api/<group>", <group>)`.

## Mapping (Next → Hono)
| Next | Hono |
|---|---|
| `export async function GET(req, {params})` | `g.get("/path", async (c) => {…})` |
| `POST` / `PUT` / `DELETE` / `PATCH` | `g.post` / `.put` / `.delete` / `.patch` |
| dynamic `[id]` + `const {id} = await params` | path `:id` + `const id = c.req.param("id")` |
| nested `[threadId]/messages/[messageId]` | `"/:threadId/messages/:messageId"` |
| `request.nextUrl.searchParams.get("x")` | `c.req.query("x")` |
| `await request.json()` | `await c.req.json().catch(() => ({}))` |
| `request.headers.get("x")` | `c.req.header("x")` |
| `NextResponse.json(obj)` | `c.json(obj)` |
| `NextResponse.json(obj, { status: N })` | `c.json(obj, N)` |
| `new NextResponse(text, { status: N })` | `c.text(text, N)` |
| `export const runtime / dynamic / maxDuration / revalidate` | DELETE (no equivalent needed) |
| `new ReadableStream` + SSE | `return streamSSE(c, async (stream) => { await stream.writeSSE({ data }) })` (import from `hono/streaming`) — see routes/threads.ts |

## Rules
- Keep ALL `@/lib/**` imports and logic IDENTICAL. Do not change behavior or status codes.
- **Dynamic status codes:** `c.json(obj, status)` requires a typed status, not a plain
  `number`. If `status` is a variable/expression (e.g. `err.status`, a proxied response
  status), cast it: `c.json(obj, status as ContentfulStatusCode)` and
  `import type { ContentfulStatusCode } from "hono/utils/http-status";`. Literal codes
  (`400`, `500`) need no cast.
- Do NOT re-check CORE_TOKEN in handlers — the global middleware (mw.ts) gates `/api/*`.
- Preserve each route's exact response shape + error codes.
- After porting a group, add its `app.route(...)` line to main.ts.
- Verify: `bun build --compile src/server/main.ts --outfile dist/spectre-core` must stay exit-0.

## Exemplars (copy these patterns)
- simple / lib import: `routes/health.ts`, `routes/models.ts`
- dynamic param + CRUD + Supabase: `routes/app-config.ts`
- SSE streaming + Supabase Realtime: `routes/threads.ts`

## The streaming routes (use the threads SSE pattern; verify each by running the binary)
`pdfs/[id]/file`, `shell`, `workspace/[id]/run-tests`, `workspace/[id]/shell`.
