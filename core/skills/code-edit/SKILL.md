---
name: code-edit
description: Read, analyze, and modify code in Spectre's codebase or user projects
trigger: When asked to write, review, debug, or modify code
autonomy: level-3
model_preference: claude-sonnet-4-6-20250514
---

# Code Edit

Read, analyze, and modify source code. This is Spectre's primary coding skill.

## Capabilities

- Read and explain code
- Debug errors and suggest fixes
- Write new code (components, routes, utilities)
- Refactor existing code
- Review PRs and diffs

## Rules

- Always read files before modifying them
- Follow existing codebase patterns and conventions
- For Spectre's own codebase: use Workshop system (branch → PR)
- For user projects: apply changes directly as instructed
- Run type checks after modifications when possible
- Prefer editing existing files over creating new ones

## Tech context (Spectre's codebase)

- Next.js 16 with App Router (async params, proxy.ts middleware)
- TypeScript strict mode
- Tailwind CSS v4
- shadcn/ui (Base Nova style)
- Supabase (PostgreSQL + Auth)
- Multi-model AI (OpenAI, Anthropic, Google)
