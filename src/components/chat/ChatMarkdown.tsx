"use client";

import { memo, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Chat-grade markdown. ReactMarkdown + remark-gfm (both already shipped deps),
 * styled with TIGHT chat spacing — not the airy `prose` defaults — so a reply
 * reads as one continuous voice in a bubble. All styling is semantic CSS in
 * src/app/chat/chat.css under the `.chat-md` scope (this shell ships NO
 * Tailwind — utility classes would be dead strings). The fenced code block is
 * the most-seen element, so it gets the crispest treatment: a hairline-bordered
 * mono slab that scrolls inside its own box; likewise a GFM table scrolls in
 * its wrapper — wide content never widens the bubble or the page.
 *
 * Links open in a new tab. Memoized on `content` because an assistant turn
 * re-renders on every streamed token.
 */

const components: Components = {
  a: (props) => (
    <a href={props.href} target="_blank" rel="noreferrer noopener">
      {props.children}
    </a>
  ),
  code: CodeBlock,
  pre: (props) => <>{props.children}</>,
  table: (props) => (
    <div className="chat-md-table-wrap">
      <table>{props.children}</table>
    </div>
  ),
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
      <code className={className} {...rest}>
        {children}
      </code>
    );
  }
  return (
    <pre>
      <code className={className} {...rest}>
        {text.replace(/\n$/, "")}
      </code>
    </pre>
  );
}

export const ChatMarkdown = memo(function ChatMarkdown({ content }: { content: string }) {
  return (
    <div className="chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
