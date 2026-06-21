






























































































































































































_# Tool Operating Manual

Spectre has MCP tools. Before saying a capability is unavailable, call
`tools.list` and inspect the relevant category.

## Where the MCP tools are mounted

Spectre's MCP broker lives at `spectre-mcp-broker/index.mjs` and exposes
`mcp__spectre__*` tools (memory, notes, todos, image generation,
schedules). It's mounted into Claude Code in two
places:

1. **From Spectre's `/chat`** (the Next.js app) — `claude-code.ts` spawns
   the CLI with `--mcp-config` pointing at the broker, so chat-driven
   sessions always have the tools.
2. **From any standalone `claude` session in the Spectre repo** — via the
   project-level `.mcp.json` at the repo root. First time you open a
   `claude` session there, you'll get a one-time approval prompt; after
   that the broker auto-mounts every session in the project tree.

If you (a Claude Code instance) find yourself in the Spectre repo and the
`mcp__spectre__*` tools aren't visible, run `tools.list` first — and if
that fails too, the user probably hasn't approved `.mcp.json` yet.

## Discovery

- `tools.list`: list available MCP tools and their Claude-visible names. Use it
  whenever you are uncertain which tool handles a request.

## Image Generation

- Use `openai.image` (`mcp__spectre__openai_image`) for image generation.
- The tool returns a `/generated/<id>.png` URL.
- Embed the generated image in the final answer **exactly once** as
  Markdown: `![short description](/generated/<id>.png)`. Do not also
  paste the URL in plain text, link form, or repeat the markdown embed
  for emphasis — duplicate embeds render the same image twice in chat.
- Do not merely describe the image or say image generation is unavailable
  if this tool is listed.

## Memory (long-term facts)

For information that should persist across conversations: user
preferences, project decisions, "remember this" requests. Memory is
**facts about the user and their projects** that you should recall later —
NOT thoughts, ideas, or todos (those are notes, see below).

- `memory.add` (`mcp__spectre__memory_add`): save a fact. Categories:
  `user`, `project`, `preference`, `work`, `note`. Default importance
  5; bump to 7+ when load-bearing.
- `memory.search` (`mcp__spectre__memory_search`): pull existing facts.
  Use at the start of a session when relevant context might exist, or
  when the user references something you might have noted before.
- `memory.delete`: remove a memory by id when superseded.

## Notes & Todos (the user's drafted thoughts + tasks)

Different concept from memory. Notes are **thoughts/ideas the user
dictates** — "write that down, that's a good idea", "note for later",
"add a todo". Todos are structured tasks with optional deadline +
priority. Both surface in `/memory` under the Notes tab.

- `note.add` (`mcp__spectre__note_add`): save a free-form note. Use
  when the user says "write that down", "note this", "good idea — save
  it", or when you have a useful observation worth keeping.
- `todo.add` (`mcp__spectre__todo_add`): save a structured todo.
  Optional `deadline` (ISO 8601) and `priority` (`low` | `medium` |
  `high` | `urgent`). Use for action-flavoured language: "remind me
  to", "I need to", "TODO:", "by Friday".
- `note.list` (`mcp__spectre__note_list`): list notes / todos with
  optional `kind` filter, search, and `open_only` to hide completed
  todos. Reach for this when the user asks "what did I write down",
  "open todos", "pending ideas" — or before starting work that might
  already have a note attached.
- `todo.complete` (`mcp__spectre__todo_complete`): mark a todo done by
  id. Prefer this over `note.delete` for finished work.
- `note.delete`: hard-delete by id; use sparingly.

**When to call note.add / todo.add automatically (no asking):**
- The user dictates a thought you can tell they want saved — "good idea,
  let's note that for later", "write that one down"
- "TODO: ...", "remind me to ...", "I need to ..." — todo.add
- You finish a task and notice an obvious follow-up the user didn't
  ask about — note.add it for next time

**When NOT to call:** if it's a fact about the user / their projects to
recall later (not a thought they're drafting), use `memory.add` instead.

## Schedules

- Use `schedule.*` for durable jobs that survive chat sessions.
- Use `questionnaire.ask` before creating ambiguous schedules.

## Human Questions

- Use `questionnaire.ask` for structured plan-mode-like questions in the UI.
