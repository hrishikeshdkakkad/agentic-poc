import { describe, it, expect, vi, beforeEach } from "vitest";

const query = vi.fn();
vi.mock("pg", () => ({
  Pool: class {
    query = query;
  },
}));

import { getLatestEdition, getEditionBySlug, listEditionSummaries } from "./db";

function tableMissing(): Error & { code?: string } {
  const err = new Error('relation "news_editions" does not exist') as Error & {
    code?: string;
  };
  err.code = "42P01"; // undefined_table — Python owns the DDL; before the
  return err; //          first publish the table simply isn't there yet.
}

const ROW = {
  slug: "2026-07-01-evening",
  edition_date: "2026-07-01",
  slot: "evening",
  title: "Evening Edition",
  content: {
    masthead: { slot: "evening", edition_date: "2026-07-01" },
    lead: { headline: "Chips Rally" },
    sections: [],
  },
  published_at: new Date("2026-07-01T22:05:00Z"),
};

beforeEach(() => {
  query.mockReset();
  process.env.DATABASE_URL = "postgresql://test";
  (globalThis as { __newsPool?: unknown }).__newsPool = undefined;
});

describe("news db", () => {
  it("returns null before the table exists (42P01), instead of throwing", async () => {
    query.mockRejectedValue(tableMissing());
    expect(await getLatestEdition()).toBeNull();
    expect(await getEditionBySlug("2026-07-01-evening")).toBeNull();
    expect(await listEditionSummaries()).toEqual([]);
  });

  it("maps the latest edition row, ISO-stamping published_at", async () => {
    query.mockResolvedValue({ rows: [ROW] });
    const ed = await getLatestEdition();
    expect(ed?.slug).toBe("2026-07-01-evening");
    expect(ed?.published_at).toBe("2026-07-01T22:05:00.000Z");
    expect(ed?.content.lead.headline).toBe("Chips Rally");
  });

  it("returns null when there are no editions", async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await getLatestEdition()).toBeNull();
  });

  it("fetches a specific edition by slug", async () => {
    query.mockResolvedValue({ rows: [ROW] });
    const ed = await getEditionBySlug("2026-07-01-evening");
    expect(ed?.slug).toBe("2026-07-01-evening");
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/WHERE slug = \$1/);
    expect(params).toEqual(["2026-07-01-evening"]);
  });

  it("archive summaries never select the content payload", async () => {
    query.mockResolvedValue({ rows: [{ ...ROW, content: undefined }] });
    const list = await listEditionSummaries();
    expect(list[0].slug).toBe("2026-07-01-evening");
    const [sql] = query.mock.calls[0];
    expect(sql).not.toMatch(/content/);
  });

  it("rethrows real database errors", async () => {
    query.mockRejectedValue(new Error("connection refused"));
    await expect(getLatestEdition()).rejects.toThrow("connection refused");
  });
});
