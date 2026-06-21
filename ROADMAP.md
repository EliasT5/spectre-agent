# Roadmap

Spectre Agent is built in the open, in stages. It ships when it's good, not on a
date — so the path below is about **order, not deadlines**.

> **You are here:** Stage 1 — early development.

---

### 1 · Early development — *now*

Live and in active bug-testing. The goal of this stage is signal: real usage, real
edge cases, real feedback.

- Shake out bugs across the tabs, modules, installer, and deploy paths
- Gather feedback on what's confusing, missing, or rough
- Keep the surface honest — small, sharp, documented

**How to help:** run it, break it, and [open an issue](https://github.com/EliasT5/spectre-agent/issues) or a pull request.

### 2 · Harden & expand

Turn the feedback into a solid base.

- Fix the *underlying* issues testing surfaces — not just patch the symptoms
- Round out the feature set and smooth the rough edges
- Tighten performance, error handling, and the first-run experience

### 3 · The Workshop

A guided build-along that teaches Spectre Agent from the inside — how the brain,
modules, and tools fit together, and how to make it your own.

- Released at **[elias-teubner.dev/spectre](https://elias-teubner.dev/spectre)**

### 4 · Open the core — *done, brought forward*

Opened ahead of schedule. The core lives in this repo at [`core/`](core/) — MIT,
built from source, no sealed image and nothing to pull. Shell and core are one
open-source project; trust comes from readable code, not a closed binary. The
build paths around it will keep smoothing out, but the core itself is open.

---

_The stages overlap — feedback from stage 1 feeds the fixes in stage 2, and so on.
The order is the commitment; the dates are not._
