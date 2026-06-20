import { describe, expect, it } from "vitest";
import { DEFAULTS, normalizeInputs, cloneInputs, type Inputs } from "./defaults";
import { compute, buildSubtotal } from "./model";
import {
  DEFAULT_CONSTRUCTION_EXPENSES,
  sumExpenses,
  scaleExpensesTo,
  normalizeConstructionExpenses,
} from "./construction-defaults";
import {
  constructionTotal,
  constructionByCategory,
  constructionByPhase,
  constructionPerSqft,
  constructionReconciliation,
} from "./construction";

const CF_GRID = [0, 3, 6, 9, 12, 15, 18, 21, 24];

describe("default construction budget", () => {
  it("sums to exactly the coarse build budget (parity invariant)", () => {
    expect(sumExpenses(DEFAULT_CONSTRUCTION_EXPENSES)).toBe(20_520_000);
  });
  it("is comprehensive (>100 items across all 18 categories)", () => {
    expect(DEFAULT_CONSTRUCTION_EXPENSES.length).toBeGreaterThan(100);
    expect(new Set(DEFAULT_CONSTRUCTION_EXPENSES.map((e) => e.category)).size).toBe(18);
  });
  it("every item lands on the CF grid with a non-negative amount", () => {
    for (const e of DEFAULT_CONSTRUCTION_EXPENSES) {
      expect(CF_GRID).toContain(e.month);
      expect(e.amount).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("engine parity preserved", () => {
  it("buildSubtotal equals the itemized total for DEFAULTS", () => {
    expect(buildSubtotal(DEFAULTS)).toBe(20_520_000);
  });
  it("totalCost is unchanged at ₹5,96,26,000", () => {
    expect(compute(DEFAULTS, "sellAll").totalCost).toBe(59_626_000);
  });
});

describe("aggregations", () => {
  it("by-category sums to the total, canonical order, shares sum to 1", () => {
    const cats = constructionByCategory(DEFAULTS);
    expect(cats.reduce((s, c) => s + c.amount, 0)).toBe(constructionTotal(DEFAULTS));
    expect(cats[0].category).toBe("Preliminaries & site setup");
    expect(cats.reduce((s, c) => s + c.pct, 0)).toBeCloseTo(1, 6);
  });
  it("by-phase groups by CF month and sums to the total", () => {
    const phases = constructionByPhase(DEFAULTS);
    expect(phases.reduce((s, p) => s + p.amount, 0)).toBe(constructionTotal(DEFAULTS));
    for (const p of phases) expect(CF_GRID).toContain(p.month);
  });
  it("per-sqft is the blended build rate (₹2,850)", () => {
    expect(constructionPerSqft(DEFAULTS)).toBeCloseTo(2850, 6);
  });
  it("reconciles exactly to the coarse build budget", () => {
    const r = constructionReconciliation(DEFAULTS);
    expect(r.matched).toBe(true);
    expect(r.variance).toBe(0);
  });
});

describe("normalization & migration", () => {
  it("injects the template scaled to a deal's coarse build budget when empty", () => {
    const coarse = (3000 + 600) * (2400 * 3); // 3600 × 7200 = 25,920,000
    const injected = normalizeConstructionExpenses(undefined, coarse);
    expect(injected.length).toBe(DEFAULT_CONSTRUCTION_EXPENSES.length);
    expect(sumExpenses(injected)).toBe(coarse);
  });
  it("keeps & coerces user items (floors negatives, snaps off-grid month)", () => {
    const coerced = normalizeConstructionExpenses(
      [{ category: "Electrical", item: "X", amount: -50, month: 7, qty: 2, rate: 10, unit: "nos" }],
      99,
    );
    expect(coerced).toHaveLength(1);
    expect(coerced[0].amount).toBe(0);
    expect(coerced[0].month).toBe(6); // nearest grid month to 7
  });
  it("normalizeInputs gives a deal without items a parity-safe budget", () => {
    const i = normalizeInputs({ ...DEFAULTS, constructionExpenses: undefined } as Partial<Inputs>);
    expect(sumExpenses(i.constructionExpenses)).toBe(20_520_000);
    expect(buildSubtotal(i)).toBe(20_520_000);
  });
  it("scaleExpensesTo hits the target exactly despite rounding", () => {
    const scaled = scaleExpensesTo(DEFAULT_CONSTRUCTION_EXPENSES, 12_345_678);
    expect(sumExpenses(scaled)).toBe(12_345_678);
  });
  it("cloneInputs deep-clones the expense array", () => {
    const c = cloneInputs(DEFAULTS);
    expect(c.constructionExpenses).not.toBe(DEFAULTS.constructionExpenses);
    expect(c.constructionExpenses[0]).not.toBe(DEFAULTS.constructionExpenses[0]);
    expect(sumExpenses(c.constructionExpenses)).toBe(20_520_000);
  });
});
