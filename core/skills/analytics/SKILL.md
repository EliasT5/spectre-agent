---
name: analytics
description: Token usage and cost reporting — how much has been spent, which models were used
trigger: When asked about usage, cost, tokens, spending, or "how much have I used"
autonomy: level-1
---

# Analytics

You can read Spectre's own token usage and cost breakdown at any time. Use it when the user asks how much they've spent, which model they've been using most, or anything about consumption.

The tool is `mcp__spectre__analytics.usage`.

---

## Parameters

| Param | Type | Default | Meaning |
|---|---|---|---|
| `windowHours` | integer 1–168 | 24 | Look-back window. 24 = last 24 h, 168 = last 7 days |

---

## What it returns

A formatted text block:

```
Usage – last 24h
  42 messages · 128,450 tokens · ~$0.3812
  by mode: api=38 subscription=4 local=0

Per model:
  claude-sonnet-4-6 [subscription] — 30 msgs · 95,200 tok · ~$0.0000 avg 4200ms
  gemini-2.5-flash [api] — 8 msgs · 22,100 tok · ~$0.0331 avg 1800ms
  gpt-4o [api] — 4 msgs · 11,150 tok · ~$0.3481 avg 3100ms
```

`subscription` mode costs are $0 (billed to Claude Max, not the API). `api` costs are estimated from known per-token pricing. `local` = Ollama (always $0).

---

## When to use

- The user asks "how much have I spent today / this week?"
- The user asks "which model am I using most?"
- You're finishing a long autonomous task and want to report what it cost — pair with `notify`
- The user asks "is Spectre expensive to run?"

---

## Pairing with notify

After a background task, report cost proactively:

1. Call `analytics.usage` with `windowHours: 1` (or however long the task ran)
2. Pull the relevant model row
3. Call `notify` with a summary: title = task name, body = "Done · 12,400 tok · ~$0.04"

Keep the body under 120 chars.
