"use client";

import { memo, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Chat-grade markdown. ReactMarkdown + remark-gfm (both already shipped deps),
 * styled with TIGHT chat spacing — not the airy `prose` defaults — so a reply
 * reads as one continuous voice in a bubble. The fenced code block is the
 * most-seen element, so it gets the crispest treatment: a hairline-bordered,
 * scrollable mono slab over the void.
 *
 * Tokens come from globals.css (Spectre design system); nothing here is bespoke
 * color. Links open in a new tab. Memoized on `content` because an assistant
 * turn re-renders on every streamed token.
 */

const components: Components = {
  p: (props) => <p className="my-1 first:mt-0 last:mb-0">{props.children}</p>,
  h1: (props) => <h1 className="mb-1 mt-2 text-[17px] font-semibold first:mt-0">{props.children}</h1>,
  h2: (props) => <h2 className="mb-1 mt-2 text-[15px] font-semibold first:mt-0">{props.children}</h2>,
  h3: (props) => <h3 className="mb-1 mt-1.5 text-[14px] font-semibold first:mt-0">{props.children}</h3>,
  ul: (props) => <ul className="my-1 ml-4 list-disc space-y-0.5">{props.children}</ul>,
  ol: (props) => <ol className="my-1 ml-4 list-decimal space-y-0.5">{props.children}</ol>,
  li: (props) => <li className="leading-relaxed">{props.children}</li>,
  a: (props) => (
    <a
      href={props.href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-[var(--color-accent-hover)] underline underline-offset-2"
    >
      {props.children}
    </a>
  ),
  strong: (props) => <strong className="font-semibold text-[var(--color-text)]">{props.children}</strong>,
  em: (props) => <em className="italic text-[var(--color-text-secondary)]">{props.children}</em>,
  hr: () => <hr className="my-2 border-0 border-t border-[var(--color-border)]" />,
  blockquote: (props) => (
    <blockquote className="my-1.5 rounded-r border-l-2 border-[var(--color-accent)]/40 bg-[var(--color-surface)]/40 py-0.5 pl-3 text-[var(--color-text-secondary)]">
      {props.children}
    </blockquote>
  ),
  code: CodeBlock,
  pre: (props) => <>{props.children}</>,
  table: (props) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">{props.children}</table>
    </div>
  ),
  thead: (props) => <thead className="font-mono text-[var(--color-text-muted)]">{props.children}</thead>,
  th: (props) => (
    <th className="border border-[var(--color-border)] px-2.5 py-1 text-left text-[11px] font-semibold uppercase tracking-wider">
      {props.children}
    </th>
  ),
  td: (props) => <td className="border border-[var(--color-border)] px-2.5 py-1 align-top">{props.children}</td>,
};

/**
 * react-markdown 10 routes both inline `code` and fenced blocks through the
 * `code` renderer; the parent `pre` is flattened to a fragment above, so the
 * fenced block draws its own slab here. We distinguish the two by whether the
 * content is multi-line (fenced) vs. a single inline run.
 */
function CodeBlock({ className, children, ...rest }: ComponentPropsWithoutRef<"code">) {
  const text = String(children ?? "");
  const isFenced = /language-/.test(className ?? "") || text.includes("\n");
  if (!isFenced) {
    return (
      <code className="rounded bg-[var(--color-surface)] px-1 py-[1px] text-[13px] text-[var(--color-accent-hover)]" {...rest}>
        {children}
      </code>
    );
  }
  return (
    <pre className="my-1.5 max-h-[28rem] overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-alt)]/80 p-2.5 text-[12px] leading-relaxed">
      <code className={`font-mono ${className ?? ""}`} {...rest}>
        {text.replace(/\n$/, "")}
      </code>
    </pre>
  );
}

export const ChatMarkdown = memo(function ChatMarkdown({ content }: { content: string }) {
  return (
    <div className="chat-md break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
