import { describe, expect, it } from "vitest";
import { DEFAULTS, type Inputs } from "./defaults";
import { buildSubtotal } from "./model";
import { compareMetrics, compareBudget } from "./compare";

describe("compareMetrics", () => {
  it("identical inputs ⇒ every delta is exactly zero", () => {
    for (const m of compareMetrics(DEFAULTS, DEFAULTS, "sellAll")) {
      expect(m.delta).toBe(0);
      expect(m.current).toBe(m.baseline);
    }
  });

  it("a higher sale rate lifts profit and revenue vs the baseline", () => {
    const current: Inputs = { ...DEFAULTS, baseSaleRate: 13_000 };
    const rows = compareMetrics(current, DEFAULTS, "sellAll");
    expect(rows.find((r) => r.key === "netProfit")!.delta).toBeGreaterThan(0);
    expect(rows.find((r) => r.key === "revenue")!.delta).toBeGreaterThan(0);
  });

  it("a fatter build budget shows the exact cost delta", () => {
    const bump = 1_000_000;
    const current: Inputs = {
      ...DEFAULTS,
      constructionExpenses: DEFAULTS.constructionExpenses.map((e, idx) =>
        idx === 0 ? { ...e, amount: e.amount + bump } : e,
      ),
    };
    const build = compareMetrics(current, DEFAULTS, "sellAll").find((r) => r.key === "build")!;
    expect(build.delta).toBe(bump);
    expect(build.current).toBe(buildSubtotal(current));
    expect(build.lowerIsBetter).toBe(true);
  });
});

describe("compareBudget", () => {
  it("reports the changed category by the exact rupee delta", () => {
    const bump = 1_000_000;
    const cat = DEFAULTS.constructionExpenses[0].category;
    const current: Inputs = {
      ...DEFAULTS,
      constructionExpenses: DEFAULTS.constructionExpenses.map((e, idx) =>
        idx === 0 ? { ...e, amount: e.amount + bump } : e,
      ),
    };
    const diffs = compareBudget(current, DEFAULTS);
    expect(diffs[0].category).toBe(cat); // largest movement sorts first
    expect(diffs[0].delta).toBe(bump);
    // untouched categories net to zero
    expect(diffs.filter((d) => d.category !== cat).every((d) => d.delta === 0)).toBe(true);
  });
});
