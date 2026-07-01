import Link from "next/link";
import type {
  Article,
  EditionSummary,
  NewsEdition,
  NewsEvent,
  Section,
  Source,
} from "@/lib/news/types";
import { ArticleBody } from "./article-body";

/** NYT-anatomy building blocks for /news. All server-safe (no hooks): the
 * page is a fully server-rendered broadsheet. Colors come from the runtime
 * theme tokens, so the paper is white in light mode and newsprint-dark in
 * dark mode without special cases. */

const CHICAGO = "America/Chicago";

export function formatDateline(edition: NewsEdition): string {
  const provided = edition.content.masthead?.dateline;
  if (provided) return provided;
  return new Date(`${edition.edition_date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: CHICAGO,
  });
}

function updatedAt(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    timeZone: CHICAGO,
  });
}

function Kicker({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <div className="mb-1 font-sans text-[11px] font-semibold uppercase tracking-[0.16em] text-mut">
      {children}
    </div>
  );
}

function Tickers({ tickers }: { tickers?: string[] }) {
  if (!tickers?.length) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {tickers.map((t) => (
        <span key={t}
          className="rounded-sm border border-line px-1 py-px font-mono text-[10px] tracking-wide text-mut">
          {t}
        </span>
      ))}
    </span>
  );
}

function SourceList({ sources }: { sources?: Source[] }) {
  if (!sources?.length) return null;
  return (
    <p className="mt-2 text-[11px] leading-relaxed text-faint">
      Sources:{" "}
      {sources.map((s, i) => (
        <span key={i}>
          {i > 0 && "; "}
          <a href={s.url} target="_blank" rel="noreferrer"
             className="underline decoration-line underline-offset-2 hover:text-mut">
            {s.title || s.publisher || new URL(s.url).hostname}
          </a>
          {s.publisher && s.title ? ` (${s.publisher})` : null}
        </span>
      ))}
    </p>
  );
}

export function Masthead({ edition, editionNo }: { edition: NewsEdition; editionNo: number }) {
  return (
    <header className="text-center">
      {/* Folio line — the row of small print above the nameplate. */}
      <div className="flex items-baseline justify-between border-b border-line pb-1.5 font-sans text-[11px] uppercase tracking-[0.08em] text-mut">
        <span>{formatDateline(edition)}</span>
        <span className="hidden sm:inline">Vol. I · No. {editionNo}</span>
        <span>
          {edition.title ?? "Edition"} · Updated {updatedAt(edition.published_at)} CT
        </span>
      </div>
      <h1 className="mt-4 font-headline text-6xl font-black tracking-tight sm:text-7xl">
        Time
      </h1>
      <p className="mt-2 font-serif text-[13px] italic text-mut">
        All the News That Moves the Market
      </p>
      <div className="np-rule-double mt-4" />
    </header>
  );
}

export function LeadStory({ lead }: { lead: Article }) {
  return (
    <article className="mx-auto max-w-3xl py-8 text-center">
      <Kicker>{lead.kicker}</Kicker>
      <h2 className="font-headline text-4xl font-bold leading-[1.08] tracking-tight sm:text-5xl">
        {lead.headline}
      </h2>
      {lead.dek && (
        <p className="mx-auto mt-3 max-w-2xl font-serif text-lg italic leading-snug text-mut">
          {lead.dek}
        </p>
      )}
      <div className="mt-3 font-sans text-[11px] uppercase tracking-[0.14em] text-faint">
        {lead.byline ?? "By the Newsroom"}
        <Tickers tickers={lead.tickers} />
      </div>
      <ArticleBody
        body={lead.body}
        className="np-columns np-dropcap mt-6 text-left text-[15px] md:columns-2"
      />
      <div className="text-left">
        <SourceList sources={lead.sources} />
      </div>
    </article>
  );
}

export function ArticleCard({ article }: { article: Article }) {
  return (
    <article className="mb-6 break-inside-avoid">
      <Kicker>{article.kicker}</Kicker>
      <h3 className="font-headline text-xl font-bold leading-snug">{article.headline}</h3>
      {article.dek && (
        <p className="mt-1 font-serif text-[14px] italic leading-snug text-mut">{article.dek}</p>
      )}
      <div className="mt-1.5 font-sans text-[10px] uppercase tracking-[0.14em] text-faint">
        {article.byline ?? "By the Newsroom"}
        <Tickers tickers={article.tickers} />
      </div>
      <ArticleBody body={article.body} className="mt-2 text-[14px]" />
      <SourceList sources={article.sources} />
    </article>
  );
}

export function EventsTable({ events }: { events: NewsEvent[] }) {
  return (
    <div className="divide-y divide-line">
      {events.map((ev, i) => (
        <div key={i} className="grid gap-2 py-4 sm:grid-cols-[9rem_1fr]">
          <div className="font-sans text-[11px] font-semibold uppercase tracking-[0.1em] text-mut">
            {ev.when}
          </div>
          <div>
            <h3 className="font-headline text-lg font-bold leading-snug">
              {ev.title}
              <Tickers tickers={ev.affected?.map((a) => a.ticker)} />
            </h3>
            {ev.why_it_matters && (
              <p className="mt-1 text-[14px] leading-relaxed">{ev.why_it_matters}</p>
            )}
            {ev.affected?.some((a) => a.note) && (
              <ul className="mt-2 space-y-1 text-[13px] text-mut">
                {ev.affected!.filter((a) => a.note).map((a) => (
                  <li key={a.ticker}>
                    <span className="font-mono text-[11px]">{a.ticker}</span> — {a.note}
                  </li>
                ))}
              </ul>
            )}
            <SourceList sources={ev.sources} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SectionBlock({ section }: { section: Section }) {
  const hasArticles = !!section.articles?.length;
  const hasEvents = !!section.events?.length;
  if (!hasArticles && !hasEvents) return null;
  return (
    <section className="py-6">
      <div className="np-rule" />
      <h2 className="mt-2 mb-5 flex items-baseline gap-3 font-headline text-[15px] font-black uppercase tracking-[0.22em]">
        {section.title}
        <span className="h-px flex-1 bg-line" aria-hidden />
      </h2>
      {hasArticles && (
        <div className="np-columns md:columns-2 xl:columns-3">
          {section.articles!.map((a, i) => <ArticleCard key={i} article={a} />)}
        </div>
      )}
      {hasEvents && <EventsTable events={section.events!} />}
    </section>
  );
}

export function EditorsNotes({ warnings }: { warnings?: string[] }) {
  if (!warnings?.length) return null;
  return (
    <aside className="mt-4 border-t border-line pt-3 text-[12px] italic text-faint">
      <span className="font-semibold not-italic">Editor’s notes:</span>{" "}
      {warnings.join(" · ")}
    </aside>
  );
}

export function Archive({
  editions,
  currentSlug,
}: {
  editions: EditionSummary[];
  currentSlug: string;
}) {
  if (editions.length <= 1) return null;
  return (
    <section className="py-6">
      <div className="np-rule" />
      <h2 className="mt-2 mb-4 font-headline text-[13px] font-black uppercase tracking-[0.22em]">
        Past Editions
      </h2>
      <ul className="grid gap-x-8 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {editions.map((e) => (
          <li key={e.slug} className="flex items-baseline justify-between gap-3 text-[13px]">
            <Link
              href={`/news?edition=${e.slug}`}
              className={
                e.slug === currentSlug
                  ? "font-semibold"
                  : "text-mut underline decoration-line underline-offset-2 hover:text-txt"
              }
            >
              {new Date(`${e.edition_date}T12:00:00Z`).toLocaleDateString("en-US", {
                month: "long", day: "numeric", year: "numeric", timeZone: CHICAGO,
              })}
            </Link>
            <span className="font-sans text-[10px] uppercase tracking-[0.12em] text-faint">
              {e.title ?? e.slot}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
