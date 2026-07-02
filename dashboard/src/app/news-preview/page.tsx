// Dev-only viewing harness for the newsroom: localhost has no Cognito env, so
// the gated /news can't be reached locally. Renders the REAL latest edition
// from the database when one exists; until then, a fixture. Hard-404s in
// production builds (and proxy.ts only exempts it from auth in development).
import { notFound } from "next/navigation";
import type { NewsEdition } from "@/lib/news/types";
import { getLatestEdition, listEditionSummaries } from "@/lib/news/db";
import {
  Archive,
  EditorsNotes,
  LeadStory,
  Masthead,
  SectionBlock,
} from "@/components/news/newsprint";

export const dynamic = "force-dynamic";

const SRC = (n: number) => [
  {
    url: `https://example.com/story-${n}`,
    title: "Fed Officials Signal Patience on Rate Path",
    publisher: "Reuters",
    published: "2026-07-01",
  },
];

const BODY = `The Federal Reserve's preferred inflation gauge cooled more than expected in May, rising 2.3 percent from a year earlier, **the Commerce Department said Tuesday**, giving policymakers fresh cover to hold rates steady through the summer.

The reading matters because it lands one week before the June employment report, the last major data point before the July meeting. Futures markets, [according to CME FedWatch](https://example.com/fedwatch), now price a 68 percent chance of a September cut, up from 55 percent a week ago.

## What changed overnight

Treasury yields fell across the curve, with the 10-year settling at 4.18 percent. The dollar weakened against the euro and yen.

> "The disinflation trend is intact, but the committee wants two more clean prints," said one former Fed economist.

- Two-year yield: 3.92%, down 6 basis points
- S&P 500 futures: up 0.4% pre-market
- Brent crude: $78.10, little changed`;

const FIXTURE: NewsEdition = {
  slug: "fixture-preview",
  edition_date: "2026-07-01",
  slot: "evening",
  title: "Preview Edition (fixture)",
  published_at: "2026-07-01T22:04:00Z",
  content: {
    schema_version: 1,
    masthead: {
      edition_label: "Preview Edition (fixture)",
      dateline: "Chicago, Tuesday, July 1, 2026",
      slot: "evening",
      edition_date: "2026-07-01",
    },
    lead: {
      kicker: "The Economy",
      headline: "Inflation Cools Again, and Wall Street Starts Counting Down to September",
      dek: "A softer PCE print pulled yields lower and put a first rate cut back on the table; chipmakers led the afternoon rally.",
      byline: "By the Time Newsroom",
      body: BODY,
      tickers: ["SPY", "TLT"],
      sources: SRC(1),
    },
    sections: [
      {
        id: "economy",
        title: "The Economy",
        articles: [
          {
            kicker: "Housing",
            headline: "Pending Home Sales Snap a Three-Month Slide",
            dek: "Lower mortgage rates coaxed buyers back in the Midwest and South.",
            body: "Pending sales rose 1.9 percent in May, the National Association of Realtors said, the first increase since February.\n\nThe 30-year fixed rate has drifted below 6.5 percent, *its lowest since March*.",
            sources: SRC(2),
          },
          {
            kicker: "Labor",
            headline: "Jobless Claims Hold Near Historic Lows Ahead of Friday's Report",
            body: "Initial claims came in at 224,000, little changed on the week, according to the Labor Department.",
            sources: SRC(3),
          },
        ],
      },
      {
        id: "events",
        title: "Upcoming Events",
        events: [
          {
            when: "2026-07-03",
            title: "June Employment Report, 7:30 a.m. CT",
            why_it_matters:
              "The last major print before the July FOMC. A miss in either direction re-prices the September cut.",
            affected: [
              { ticker: "SPY", note: "Broad-market repricing on any surprise." },
              { ticker: "TLT", note: "Long bonds move first on payrolls day." },
            ],
            sources: SRC(7),
          },
        ],
      },
      {
        id: "chip_desk",
        title: "The Chip Desk",
        articles: [
          {
            kicker: "Memory",
            headline: "HBM4 Qualification Timelines Tighten as Hyperscaler Orders Stack Up",
            dek: "SK Hynix and Micron are racing certification windows that used to be sequential.",
            body: "Both memory makers now expect HBM4 qualification with their lead GPU customer this quarter, **TrendForce said Tuesday**.",
            tickers: ["MU", "NVDA"],
            sources: SRC(9),
          },
          {
            kicker: "GPUs",
            headline: "Interconnect Is the New Battleground: Optical Links Move Up the Roadmap",
            body: "Co-packaged optics announcements this week point at the real constraint on trillion-parameter training runs: moving data between GPUs, not the GPUs themselves.",
            tickers: ["NVDA", "AVGO"],
            sources: SRC(11),
          },
        ],
      },
    ],
    warnings: ["This is placeholder fixture content — the first real edition replaces it automatically."],
  },
};

export default async function NewsPreview() {
  if (process.env.NODE_ENV === "production") notFound();
  const [live, archive] = await Promise.all([
    getLatestEdition().catch(() => null),
    listEditionSummaries().catch(() => []),
  ]);
  const edition = live ?? FIXTURE;
  const editionNo = live
    ? archive.length - Math.max(archive.findIndex((e) => e.slug === edition.slug), 0)
    : 1;
  const { content } = edition;
  return (
    <div className="newsroom mx-auto max-w-[82rem]">
      <Masthead edition={edition} editionNo={editionNo} />
      <LeadStory lead={content.lead} />
      {content.sections.map((s) => (
        <SectionBlock key={s.id} section={s} />
      ))}
      {live && <Archive editions={archive} currentSlug={edition.slug} />}
      <EditorsNotes warnings={content.warnings} />
      <footer className="mt-6 border-t border-line py-4 text-center font-sans text-[10px] uppercase tracking-[0.14em] text-faint">
        Written and published by a scheduled Claude agent · Verify before trading
      </footer>
    </div>
  );
}
