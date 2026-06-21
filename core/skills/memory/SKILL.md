---
name: memory
description: Long-term memory — save and recall facts across conversations
trigger: When learning something worth keeping, or when past context would help answer something better
autonomy: level-2
---

# Memory

You have a persistent memory store backed by a database. Use it. Without it, every conversation starts blind — you won't know the user's preferences, project history, or anything from a previous session unless you saved it.

The tools are `mcp__spectre__memory.add`, `mcp__spectre__memory.search`, and `mcp__spectre__memory.delete`.

---

## When to search

Do a quick search at the start of conversations where context might exist:

- User mentions a project, client, or tool by name — search it
- User says "like we discussed", "you know I...", "remember..." — search it
- You're about to give advice on something personal (workflow, preferences, tools) — search first
- User asks something you might have noted before — search first, then answer

A targeted `memory.search` takes a second and can save you from giving advice that contradicts what you already know about how the user works.

---

## When to save

Save whenever you learn something that will genuinely help in a future conversation. Ask yourself: *if I forgot this, would my next response to the user be worse?* If yes — save it.

**Save:**
- Preferences and opinions the user expresses ("prefers X over Y", "dislikes Z")
- Project decisions and why they were made — especially tradeoffs
- Anything the user explicitly asks you to remember
- Context about ongoing work: current clients, active projects, blockers
- Things you learned that surprised you about how the user works

**Don't save:**
- Things already in `soul/USER.md` or `soul/SOUL.md` — those are always loaded
- Temporary in-conversation context that won't matter tomorrow
- Obvious or generic facts
- Intermediate steps, drafts, half-formed thoughts

---

## Categories

| Category | Use for |
|---|---|
| `user` | Who the user is — habits, personality, goals, constraints |
| `project` | Per-project decisions, status, architecture choices, why something exists |
| `preference` | Specific likes/dislikes: tools, formats, communication style |
| `work` | Professional context: clients, colleagues, deadlines, roles |
| `note` | Everything else |

---

## Importance scale

| Range | Meaning |
|---|---|
| 1–3 | Nice to have — low cost if forgotten |
| 4–6 | Useful context — will improve future responses |
| 7–9 | Important — forgetting this would noticeably degrade your usefulness |
| 10 | Critical — must not lose this |

Default to 5 when unsure. Reserve 8–10 for things like explicit strong preferences, critical project constraints, or things the user has corrected you on.

---

## Behaviour rules

- **Silent by default**: Don't announce routine saves or searches mid-conversation. Just do them. Exception: if the user explicitly asks you to remember something, confirm briefly.
- **Recall out loud when relevant**: If a memory informs your answer, mention it naturally — "I remember you mentioned you prefer..." or "Based on what you told me about that project..."
- **Correct, don't accumulate**: If you learn something that contradicts an existing memory, delete the old one and add the corrected version. Don't let stale memories pile up.
- **Quality over quantity**: One precise memory is worth more than five vague ones. Write content as a clear, standalone sentence — it needs to make sense without this conversation as context.
