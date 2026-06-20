import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { blankDeal } from "./deals";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://finance:finance@127.0.0.1:5433/finance";
let available = false;

beforeAll(async () => {
  process.env.DATABASE_URL = DB_URL; // db.ts reads this lazily on first query
  const probe = new Pool({ connectionString: DB_URL, max: 1 });
  try {
    await probe.query("SELECT 1");
    available = true;
  } catch {
    available = false;
  } finally {
    await probe.end();
  }
});

afterAll(async () => {
  if (available) {
    const p = new Pool({ connectionString: DB_URL, max: 1 });
    await p.query("DELETE FROM real_estate_deals WHERE id = 'it_test_deal'");
    await p.end();
  }
  const g = globalThis as { __realEstatePool?: { end: () => Promise<void> } };
  if (g.__realEstatePool) {
    await g.__realEstatePool.end();
    g.__realEstatePool = undefined;
  }
});

describe("db round-trip", () => {
  it("upserts, lists, and deletes a deal", async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    const { ensureSchema, upsertDeal, listDeals, deleteDeal } = await import("./db");
    await ensureSchema();

    const deal = { ...blankDeal("IT deal"), id: "it_test_deal" };
    const saved = await upsertDeal(deal);
    expect(saved.id).toBe("it_test_deal");
    expect(saved.name).toBe("IT deal");
    expect(typeof saved.updatedAt).toBe("number");

    const renamed = await upsertDeal({ ...saved, name: "IT deal v2" });
    expect(renamed.name).toBe("IT deal v2");

    const deals = await listDeals();
    expect(deals.find((d) => d.id === "it_test_deal")?.name).toBe("IT deal v2");

    await deleteDeal("it_test_deal");
    const after = await listDeals();
    expect(after.find((d) => d.id === "it_test_deal")).toBeUndefined();
  });
});
