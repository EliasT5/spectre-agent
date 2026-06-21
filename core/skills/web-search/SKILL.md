---
name: web-search
description: Search the web for current information
trigger: When the user asks about recent events, needs current data, or asks to look something up
autonomy: level-1
---

# Web Search

Search the web to find current information that isn't in Spectre's training data.

## When to use

- User asks about recent events or news
- User needs current prices, schedules, or status
- User asks "look up", "search for", "find out about"
- Information is likely to have changed since training cutoff

## How to use

1. Formulate a clear search query from the user's request
2. Call the web search tool
3. Synthesize results into a concise answer
4. Cite sources when relevant
