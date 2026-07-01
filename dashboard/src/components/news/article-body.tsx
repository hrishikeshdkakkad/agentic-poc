import React from "react";

/** Markdown-subset renderer for agent-written article bodies.
 *
 * Deliberately hand-rolled instead of a markdown dependency: bodies are
 * written by our own scheduled agent to the NEWSROOM.md spec (paragraphs,
 * bold/italic, links, blockquotes, lists, ## subheads — nothing else), and
 * building React nodes directly means there is no HTML parsing and no
 * dangerouslySetInnerHTML anywhere — raw HTML in a body renders as text.
 */

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string): React.ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      return (
        <a key={i} href={link[2]} target="_blank" rel="noreferrer"
           className="underline decoration-line-strong underline-offset-2 hover:decoration-current">
          {link[1]}
        </a>
      );
    }
    return part;
  });
}

const strip = (line: string, marker: RegExp) => line.replace(marker, "");

function block(chunk: string, key: number): React.ReactNode {
  const lines = chunk.split("\n");
  if (chunk.startsWith("## ")) {
    return (
      <h4 key={key} className="mt-5 mb-2 font-headline text-[1.05rem] font-bold">
        {inline(strip(chunk, /^## /))}
      </h4>
    );
  }
  if (lines.every((l) => l.startsWith(">"))) {
    return (
      <blockquote key={key} className="my-3 border-l-2 border-line-strong pl-4 italic text-mut">
        {inline(lines.map((l) => strip(l, /^>\s?/)).join(" "))}
      </blockquote>
    );
  }
  if (lines.every((l) => /^[-*]\s/.test(l))) {
    return (
      <ul key={key} className="my-3 list-disc space-y-1 pl-5">
        {lines.map((l, i) => <li key={i}>{inline(strip(l, /^[-*]\s/))}</li>)}
      </ul>
    );
  }
  if (lines.every((l) => /^\d+\.\s/.test(l))) {
    return (
      <ol key={key} className="my-3 list-decimal space-y-1 pl-5">
        {lines.map((l, i) => <li key={i}>{inline(strip(l, /^\d+\.\s/))}</li>)}
      </ol>
    );
  }
  return (
    <p key={key} className="my-3 leading-relaxed first:mt-0 last:mb-0">
      {inline(lines.join(" "))}
    </p>
  );
}

export function ArticleBody({ body, className }: { body?: string; className?: string }) {
  const chunks = (body ?? "").split(/\n\s*\n/).map((c) => c.trim()).filter(Boolean);
  if (!chunks.length) return null;
  return <div className={className}>{chunks.map(block)}</div>;
}
