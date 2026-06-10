# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

Use GitHub's private vulnerability reporting: the repository **Security** tab →
**Report a vulnerability**. Reports are typically acknowledged within a few days.

## Scope & threat model

Spectre is designed to run **self-hosted, single-user, behind a loopback core**:

- The public shell (this repo) is the only browser-facing surface. It gates
  access with a PIN and proxies `/api/*` to a private core over loopback,
  injecting a `CORE_TOKEN` that the browser never sees.
- The core can execute code and shell commands on the host on the operator's
  behalf. **Treat the PIN and `CORE_TOKEN` as high-value credentials.**

If you expose the shell beyond `localhost` / your private tailnet, you **must**
front it with HTTPS and a strong PIN. Exposing the host shell route to an
untrusted network is outside the supported configuration.

## Supported versions

The latest `main` is supported. Pin a commit for production and watch releases.
