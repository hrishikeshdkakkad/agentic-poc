import "server-only";
import { Pool } from "pg";
import type { EditionSummary, NewsEdition } from "./types";

// One pool per process, cached on globalThis so `next dev` hot-reload doesn't
// leak a new pool on every module re-evaluation (same pattern as realestate).
declare global {
  // eslint-disable-next-line no-var
  var __newsPool: Pool | undefined;
}

function pool(): Pool {
  if (!globalThis.__newsPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    globalThis.__newsPool = new Pool({ connectionString, max: 3 });
  }
  return globalThis.__newsPool;
}

// No DDL here: Python owns news_editions (storage.py _SCHEMA), created lazily
// on the Lambda's first publish. Until then the table is simply absent —
// undefined_table reads as "no editions yet", not an error page.
const TABLE_MISSING = "42P01";

function missingTable(err: unknown): boolean {
  return (err as { code?: string })?.code === TABLE_MISSING;
}

type EditionDbRow = Omit<NewsEdition, "published_at"> & { published_at: Date };

function rowToEdition(row: EditionDbRow): NewsEdition {
  return { ...row, published_at: row.published_at.toISOString() };
}

const EDITION_COLS =
  "slug, edition_date::text AS edition_date, slot, title, content, published_at";

export async function getLatestEdition(): Promise<NewsEdition | null> {
  try {
    const { rows } = await pool().query<EditionDbRow>(
      `SELECT ${EDITION_COLS} FROM news_editions
       ORDER BY published_at DESC LIMIT 1`,
    );
    return rows[0] ? rowToEdition(rows[0]) : null;
  } catch (err) {
    if (missingTable(err)) return null;
    throw err;
  }
}

export async function getEditionBySlug(slug: string): Promise<NewsEdition | null> {
  try {
    const { rows } = await pool().query<EditionDbRow>(
      `SELECT ${EDITION_COLS} FROM news_editions WHERE slug = $1`,
      [slug],
    );
    return rows[0] ? rowToEdition(rows[0]) : null;
  } catch (err) {
    if (missingTable(err)) return null;
    throw err;
  }
}

/** Archive rail. Excludes the JSONB payload on purpose — editions are large. */
export async function listEditionSummaries(limit = 42): Promise<EditionSummary[]> {
  try {
    const { rows } = await pool().query<
      Omit<EditionSummary, "published_at"> & { published_at: Date }
    >(
      `SELECT slug, edition_date::text AS edition_date, slot, title, published_at
       FROM news_editions ORDER BY published_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({ ...r, published_at: r.published_at.toISOString() }));
  } catch (err) {
    if (missingTable(err)) return [];
    throw err;
  }
}
