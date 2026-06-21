# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

Use GitHub's private vulnerability reporting: the repository **Security** tab →
**Report a vulnerability**. Reports are typically acknowledged within a few days.

## What's covered

Both halves of the project, which live in this one repo:

- The **shell** — the UI and proxy at the repo root.
- The **core** — the brain at [`core/`](core/), a Bun/Hono backend built from
  source. It's fully open, so the security model below is verifiable line by
  line, not asserted about a sealed binary.

## Scope & threat model

Spectre is designed to run **self-hosted, single-user, behind a loopback core**:

- The shell (repo root) is the only browser-facing surface. It gates access with
  a PIN and proxies `/api/*` to the core over loopback, injecting a `CORE_TOKEN`
  that the browser never sees.
- The core (`core/`) binds loopback only (`127.0.0.1:8787`) and rejects any
  request without the secret `CORE_TOKEN`; `/api/health` is the only
  unauthenticated route. See `core/README.md` for the full model.
- The core can execute code and shell commands on the host on the operator's
  behalf, with every tool call passing the permission broker. **Treat the PIN
  and `CORE_TOKEN` as high-value credentials, and the host as trusted-only.**

If you expose the shell beyond `localhost` / your private tailnet, you **must**
front it with HTTPS and a strong PIN. Exposing the host shell route to an
untrusted network is outside the supported configuration.

## Supported versions

The latest `main` is supported. Pin a commit for production and watch releases.
