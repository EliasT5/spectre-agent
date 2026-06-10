# Contributing

Thanks for your interest. This is the **public shell** of Spectre, an open-core
personal AI agent. The private core ("brain") lives in a separate repository.

## Architecture in one line

`spectre-agent` (this repo — the UI shell, port 3000) proxies `/api/*` to
`spectre-core` (the private brain, loopback `:8787`, gated by a `CORE_TOKEN`).
The shell holds **no** AI logic or secrets; it renders the UI and forwards
requests.

## Dev setup

```bash
npm install
npm run dev      # http://localhost:3000
```

You need a running core for the API to respond — see the installer guide.

## Ground rules

- **Keep the boundary.** No model/provider logic, prompts, or secrets in the
  shell — those belong in the core. The shell talks to the core only through
  `@/lib/sdk` (`spectre.*`).
- **Follow the design system** (`DESIGN.md`): assemble the UI kit / tab schema,
  don't hand-roll chrome, and use the `:root` design tokens (never raw hex).
- Run `npm run build` before opening a PR; keep it type-clean.
- Report security issues privately (see `SECURITY.md`), never in a public issue.
