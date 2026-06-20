import { describe, expect, it } from "vitest";
import { DEFAULTS, normalizeInputs, type Inputs } from "./defaults";
import { buildSubtotal } from "./model";
import { computeReality } from "./reality";
import type { ActualExpense } from "./actuals-defaults";
import { forecast, forecastInputs, eacByCategory } from "./forecast";

const actual = (over: Partial<ActualExpense>): ActualExpense => ({
  id: "a1",
  name: "x",
  amount: 0,
  date: "",
  status: "paid",
  createdAt: 0,
  ...over,
});

// Derived (not hardcoded) so the contract tracks the budget if it ever changes.
const BASE_BUILD = buildSubtotal(DEFAULTS); // Σ line items = 20_520_000
const PRELIM = "Preliminaries & site setup";
const PRELIM_BUDGET = 410_000; // Σ Preliminaries line items (construction-defaults)

describe("forecast reduces to the plan when there are no actuals", () => {
  it("forecast(i) deep-equals computeReality(i)", () => {
    expect(forecast(DEFAULTS)).toEqual(computeReality(DEFAULTS));
  });
  it("forecastInputs strips actualExpenses", () => {
    const withActuals: Inputs = {
      ...DEFAULTS,
      actualExpenses: [actual({ category: PRELIM, amount: 100 })],
    };
    expect(forecastInputs(withActuals).actualExpenses).toEqual([]);
  });
});

describe("actuals join to the budget by CATEGORY (no expenseId required)", () => {
  it("an under-budget actual counts as committed against its category, never unbudgeted", () => {
    // This is the real UI path: the editor only sets `category`, not `expenseId`.
    const i: Inputs = { ...DEFAULTS, actualExpenses: [actual({ category: PRELIM, amount: 10_000 })] };
    expect(buildSubtotal(forecastInputs(i))).toBe(BASE_BUILD); // under budget → build unchanged
    const row = eacByCategory(i).find((r) => r.category === PRELIM)!;
    expect(row.committed).toBe(10_000);
    expect(row.budget).toBe(PRELIM_BUDGET);
    expect(row.eac).toBe(PRELIM_BUDGET);
    expect(row.unbudgeted).toBe(false);
    // nothing categorized against a real budget line is ever mislabelled unbudgeted
    expect(eacByCategory(i).some((r) => r.unbudgeted)).toBe(false);
  });

  it("a stale/bogus expenseId is ignored — the category drives the join", () => {
    const i: Inputs = {
      ...DEFAULTS,
      actualExpenses: [actual({ category: PRELIM, expenseId: "does-not-exist", amount: 10_000 })],
    };
    const row = eacByCategory(i).find((r) => r.category === PRELIM)!;
    expect(row.committed).toBe(10_000);
    expect(row.unbudgeted).toBe(false);
  });

  it("overspending a category lifts the build EAC by the category overspend and trims profit", () => {
    const over = 200_000;
    const i: Inputs = {
      ...DEFAULTS,
      actualExpenses: [actual({ category: PRELIM, amount: PRELIM_BUDGET + over })],
    };
    expect(buildSubtotal(forecastInputs(i))).toBe(BASE_BUILD + over);
    expect(forecast(i).dilution.profit).toBeLessThan(computeReality(DEFAULTS).dilution.profit);
    expect(eacByCategory(i).find((r) => r.category === PRELIM)!.eac).toBe(PRELIM_BUDGET + over);
  });

  it("multiple actuals in one category aggregate before comparing to budget", () => {
    const i: Inputs = {
      ...DEFAULTS,
      actualExpenses: [
        actual({ id: "a", category: PRELIM, amount: 250_000 }),
        actual({ id: "b", category: PRELIM, amount: 250_000 }),
      ],
    };
    // 500_000 committed vs 410_000 budget → 90_000 overspend
    expect(buildSubtotal(forecastInputs(i))).toBe(BASE_BUILD + 90_000);
    expect(eacByCategory(i).find((r) => r.category === PRELIM)!.committed).toBe(500_000);
  });
});

describe("unbudgeted actuals (no matching budget category) add on top", () => {
  it("an actual in a category with no budget is flagged unbudgeted and added on top", () => {
    const i: Inputs = {
      ...DEFAULTS,
      actualExpenses: [actual({ category: "Solar & EV", amount: 300_000 })],
    };
    expect(buildSubtotal(forecastInputs(i))).toBe(BASE_BUILD + 300_000);
    const row = eacByCategory(i).find((r) => r.unbudgeted)!;
    expect(row.category).toBe("Solar & EV");
    expect(row.budget).toBe(0);
    expect(row.eac).toBe(300_000);
  });

  it("an actual with no category falls back to Unassigned and is unbudgeted", () => {
    const i: Inputs = { ...DEFAULTS, actualExpenses: [actual({ amount: 120_000 })] };
    expect(buildSubtotal(forecastInputs(i))).toBe(BASE_BUILD + 120_000);
    expect(eacByCategory(i).find((r) => r.unbudgeted)!.category).toBe("Unassigned");
  });
});

describe("forecast basis: committed vs paid", () => {
  it("a pending actual counts under committed but not under paid", () => {
    const i: Inputs = {
      ...DEFAULTS,
      actualExpenses: [actual({ category: PRELIM, amount: PRELIM_BUDGET + 400_000, status: "pending" })],
    };
    expect(buildSubtotal(forecastInputs(i, "committed"))).toBe(BASE_BUILD + 400_000);
    expect(buildSubtotal(forecastInputs(i, "paid"))).toBe(BASE_BUILD);
  });

  it("a partial actual counts under paid too (real cash out the door, not hidden)", () => {
    const i: Inputs = {
      ...DEFAULTS,
      actualExpenses: [actual({ category: PRELIM, amount: PRELIM_BUDGET + 400_000, status: "partial" })],
    };
    expect(buildSubtotal(forecastInputs(i, "paid"))).toBe(BASE_BUILD + 400_000);
  });
});

describe("EAC grid reconciles to the forecast build", () => {
  it("Σ eac across categories == forecast buildSubtotal (to the rupee)", () => {
    const i: Inputs = normalizeInputs({
      ...DEFAULTS,
      actualExpenses: [
        actual({ id: "x1", category: PRELIM, amount: PRELIM_BUDGET + 50_000 }),
        actual({ id: "x2", category: "Site extras", amount: 75_000 }),
      ],
    });
    const eacSum = eacByCategory(i).reduce((s, r) => s + r.eac, 0);
    expect(eacSum).toBe(buildSubtotal(forecastInputs(i)));
  });
});
