/**
 * Report-mode instructions for scheduled "Routine" jobs.
 *
 * When a routine is created with `report: true`, this text is appended to the
 * user's task prompt before it is stored on the scheduled_job. At run time the
 * scheduler posts the prompt into a chat thread; the claude-code provider runs
 * it with WebSearch/WebFetch enabled (see src/lib/ai/providers/claude-code.ts)
 * and the assistant's reply is persisted as a message. A reply that ends in a
 * single ```html block renders as a sandboxed embed in the thread via
 * src/components/chat/html-sandbox.tsx.
 *
 * The schema below is deliberately strict so every routine produces a
 * consistent, self-contained report: TL;DR, ranked findings each with a
 * "why it matters" line and a real source link, and a Sources footer. The
 * embed iframe is `sandbox=""` (no scripts, no external network), so the HTML
 * must be self-contained with INLINE styles only.
 */
export const REPORT_INSTRUCTIONS = `
---

DELIVERY FORMAT — produce a report, not a chat reply.

1. Use your web search tool to gather CURRENT, real information for the task
   above. Every factual claim and every item must trace to a real source you
   actually opened — never invent links, titles, dates, or numbers.
2. Write a short framing sentence, then output EXACTLY ONE fenced code block
   tagged \`html\` containing the full report. The only thing that may follow
   the report block is a \`routine-ops\` block (if this routine keeps a list,
   you'll be asked for one below); otherwise nothing.
3. The HTML must be self-contained: INLINE styles only (style="..."), no
   <script>, no <link>, no external CSS or fonts, no remote images. It renders
   in a sandboxed iframe with scripts and network disabled.
4. Follow this structure exactly (fill the placeholders, keep the tags):

\`\`\`html
<article style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;max-width:680px;margin:0 auto">
  <header style="border-bottom:2px solid #6366f1;padding-bottom:10px;margin-bottom:16px">
    <h1 style="margin:0;font-size:20px;color:#111">{REPORT TITLE}</h1>
    <p style="margin:4px 0 0;font-size:12px;color:#666">{TODAY'S DATE} · {ONE-LINE SCOPE}</p>
  </header>

  <section style="background:#f5f5fb;border-radius:10px;padding:12px 14px;margin-bottom:18px">
    <h2 style="margin:0 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#6366f1">TL;DR</h2>
    <p style="margin:0;font-size:14px;line-height:1.55">{2–4 sentence executive summary}</p>
  </section>

  <ol style="list-style:none;counter-reset:item;padding:0;margin:0">
    <!-- Repeat one <li> per finding (aim for the count the task asked for) -->
    <li style="counter-increment:item;border:1px solid #e5e5ef;border-radius:10px;padding:12px 14px;margin-bottom:10px">
      <h3 style="margin:0 0 4px;font-size:15px;color:#111">{ITEM TITLE}</h3>
      <p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:#333">{WHY IT MATTERS — 1–2 sentences}</p>
      <a href="{SOURCE URL}" style="font-size:12px;color:#6366f1;text-decoration:none">↗ {SOURCE NAME}</a>
    </li>
  </ol>

  <footer style="border-top:1px solid #e5e5ef;margin-top:16px;padding-top:10px">
    <h2 style="margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#666">Sources</h2>
    <ol style="margin:0;padding-left:18px;font-size:12px;line-height:1.6;color:#555">
      <li><a href="{URL}" style="color:#6366f1">{SOURCE TITLE}</a></li>
    </ol>
  </footer>
</article>
\`\`\`

If web search returns nothing usable, say so plainly in one sentence instead of
emitting an empty or fabricated report.
`;
