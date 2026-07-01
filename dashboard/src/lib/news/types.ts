/** TS mirror of the edition content schema owned by docs/NEWSROOM.md and
 * validated python-side by newsroom.validate_edition(). The dashboard only
 * reads; the scheduled cloud agent writes via the publish_news_edition tool. */

export type Source = {
  url: string;
  title?: string;
  publisher?: string;
  published?: string;
};

export type Article = {
  kicker?: string;
  headline: string;
  dek?: string;
  byline?: string;
  /** Markdown subset: paragraphs, **bold**, *italic*, [links](url),
   * > blockquotes, -/1. lists, ## subheads. Rendered by ArticleBody. */
  body?: string;
  tickers?: string[];
  sources?: Source[];
};

export type NewsEvent = {
  when?: string;
  title: string;
  why_it_matters?: string;
  affected?: { ticker: string; note?: string }[];
  sources?: Source[];
};

export type Section = {
  id: string;
  title: string;
  articles?: Article[];
  events?: NewsEvent[];
};

export type EditionContent = {
  schema_version?: number;
  masthead: {
    edition_label?: string;
    dateline?: string;
    slot: string;
    edition_date: string;
  };
  lead: Article;
  sections: Section[];
  warnings?: string[];
};

/** Summary row for the archive rail — deliberately excludes content (JSONB
 * editions are large; the archive list must stay light). */
export type EditionSummary = {
  slug: string;
  edition_date: string;
  slot: string;
  title: string | null;
  published_at: string;
};

export type NewsEdition = EditionSummary & { content: EditionContent };
