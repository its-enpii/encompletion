"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { CodeBlock } from "./Chat/CodeBlock";

type Props = {
  content: string;
  className?: string;
};

/**
 * Renders GitHub-flavored markdown with syntax highlighting.
 * Styling of <h1/h2/h3/p/code/pre/ul/ol/li/blockquote/a/table> is done via the
 * .md-* classes (scoped to the wrapper) so it composes with the dark theme
 * regardless of where the component is dropped.
 */
export default function MarkdownView({ content, className = "" }: Props) {
  return (
    <div className={`md-body ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer" />
          ),
          // Replace the bare <pre> chrome with CodeBlock — it wraps the
          // rendered <code> (with highlight.js spans) inside a soft header
          // bar carrying language badge, filename inference, and a per-block
          // copy button that copies ONLY the raw code text.
          pre: ({ children, ...rest }) => <CodeBlock {...(rest as React.HTMLAttributes<HTMLPreElement>)}>{children}</CodeBlock>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}