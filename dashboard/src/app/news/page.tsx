import type { Metadata } from "next";
import { getEditionBySlug, getLatestEdition, listEditionSummaries } from "@/lib/news/db";
import {
  Archive,
  EditorsNotes,
  LeadStory,
  Masthead,
  SectionBlock,
} from "@/components/news/newsprint";

export const metadata: Metadata = { title: "Time · Vault" };

// DB-backed and republished 3×/day — never statically cache an edition.
export const dynamic = "force-dynamic";

/** The newsroom front page. A server component that reads news_editions
 * directly over Postgres (no MCP round-trip, no client store): the page is a
 * finished broadsheet, not an app view. Access is gated by proxy.ts via
 * PAGE_PERMISSION["/news"] — every signed-in role holds news:read. */
export default async function NewsPage({
  searchParams,
}: {
  searchParams: Promise<{ edition?: string }>;
}) {
  const { edition: requested } = await searchParams;
  const [edition, archive] = await Promise.all([
    requested ? getEditionBySlug(requested) : getLatestEdition(),
    listEditionSummaries(),
  ]);

  if (!edition) {
    return (
      <div className="newsroom mx-auto max-w-3xl py-16 text-center">
        <h1 className="font-headline text-[clamp(4.25rem,7.5vw,7.5rem)] font-black leading-[0.95] tracking-[-0.015em]">Time</h1>
        <p className="mt-3 font-serif text-[15px] italic tracking-wide text-mut">
          All the News That Moves the Market
        </p>
        <div className="np-rule-double mt-4" />
        <p className="mt-10 font-serif text-lg text-mut">
          {requested
            ? "That edition isn’t in the archive."
            : "The presses haven’t run yet — the first edition publishes with the next scheduled run."}
        </p>
      </div>
    );
  }

  const editionNo =
    archive.length - Math.max(archive.findIndex((e) => e.slug === edition.slug), 0);
  const { content } = edition;

  return (
    <div className="newsroom mx-auto max-w-[82rem]">
      <Masthead edition={edition} editionNo={editionNo} />
      <LeadStory lead={content.lead} />
      {content.sections.map((s) => (
        <SectionBlock key={s.id} section={s} />
      ))}
      <Archive editions={archive} currentSlug={edition.slug} />
      <EditorsNotes warnings={content.warnings} />
      <footer className="mt-6 border-t border-line py-4 text-center font-sans text-[10px] uppercase tracking-[0.14em] text-faint">
        Written and published by a scheduled Claude agent · Verify before trading
      </footer>
    </div>
  );
}
