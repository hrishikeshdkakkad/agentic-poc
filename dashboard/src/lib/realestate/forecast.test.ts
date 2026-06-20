import { describe, expect, it } from "vitest";
import { DEFAULTS, normalizeInputs, type Inputs } from "./defaults";
import { buildSubtotal } from "./model";
import { computeReality } from "./reality";
import type { ActualExpense } from "./actuals-defaults";
import { forecast, forecastInputs, eacByLine } from "./forecast";

const actual = (over: Partial<ActualExpense>): ActualExpense => ({
  id: "a1",
  name: "x",
  amount: 0,
  date: "",
  status: "paid",
  createdAt: 0,
  ...over,
});

const firstLineId = DEFAULTS.constructionExpenses[0].id;
const firstLineBudget = DEFAULTS.constructionExpenses[0].amount;

describe("forecast reduces to the plan when there are no actuals", () => {
  it("forecast(i) deep-equals computeReality(i)", () => {
    expect(forecast(DEFAULTS)).toEqual(computeReality(DEFAULTS));
  });
  it("forecastInputs strips actualExpenses", () => {
    const withActuals: Inputs = {
      ...DEFAULTS,
      actualExpenses: [actual({ expenseId: firstLineId, amount: 100 })],
    };
    expect(forecastInputs(withActuals).actualExpenses).toEqual([]);
  });
});

describe("EAC per line = max(budget, committed)", () => {
  it("overspend on a line lifts the build EAC by the overspend and trims profit", () => {
    const over = 500_000;
    const i: Inputs = {
      ...DEFAULTS,
      actualExpenses: [actual({ expenseId: firstLineId, amount: firstLineBudget + over })],
    };
    expect(buildSubtotal(forecastInputs(i))).toBe(buildSubtotal(DEFAULTS) + over);
    expect(forecast(i).dilution.profit).toBeLessThan(computeReality(DEFAULTS).dilution.profit);
    const row = eacByLine(i).find((r) => r.id === firstLineId)!;
    expect(row.eac).toBe(firstLineBudget + over);
  });

  it("under-spend does NOT lower the line below budget (ETC fills the remainder)", () => {
    const i: Inputs = {
      ...DEFAULTS,
      actualExpenses: [actual({ expenseId: firstLineId, amount: 1 })],
    };
    expect(buildSubtotal(forecastInputs(i))).toBe(buildSubtotal(DEFAULTS));
    expect(eacByLine(i).find((r) => r.id === firstLineId)!.eac).toBe(firstLineBudget);
  });
});

describe("orphan / unbudgeted actuals become their own forecast lines", () => {
  it("an actual with a dead expenseId is added on top of the budget", () => {
    const i: Inputs = {
      ...DEFAULTS,
      actualExpenses: [actual({ expenseId: "does-not-exist", amount: 300_000, category: "Extras" })],
    };
    expect(buildSubtotal(forecastInputs(i))).toBe(buildSubtotal(DEFAULTS) + 300_000);
    const row = eacByLine(i).find((r) => r.unbudgeted)!;
    expect(row.eac).toBe(300_000);
    expect(row.budget).toBe(0);
  });

  it("an unlinked actual is added on top of the budget", () => {
    const i: Inputs = {
      ...DEFAULTS,
      actualExpenses: [actual({ amount: 120_000 })],
    };
    expect(buildSubtotal(forecastInputs(i))).toBe(buildSubtotal(DEFAULTS) + 120_000);
  });
});

describe("forecast basis: committed vs paid", () => {
  it("a pending actual counts under committed but not under paid", () => {
    const i: Inputs = {
      ...DEFAULTS,
      actualExpenses: [actual({ expenseId: firstLineId, amount: firstLineBudget + 400_000, status: "pending" })],
    };
    expect(buildSubtotal(forecastInputs(i, "committed"))).toBe(buildSubtotal(DEFAULTS) + 400_000);
    expect(buildSubtotal(forecastInputs(i, "paid"))).toBe(buildSubtotal(DEFAULTS));
  });

  it("a partial actual counts under paid too (real cash out the door, not hidden)", () => {
    const i: Inputs = {
      ...DEFAULTS,
      actualExpenses: [actual({ expenseId: firstLineId, amount: firstLineBudget + 400_000, status: "partial" })],
    };
    // partial is real spend → it lifts the paid-basis EAC, unlike fully-unpaid pending
    expect(buildSubtotal(forecastInputs(i, "paid"))).toBe(buildSubtotal(DEFAULTS) + 400_000);
  });
});

describe("EAC grid totals reconcile to the forecast build", () => {
  it("Σ eac across lines == forecast buildSubtotal (to the rupee)", () => {
    const i: Inputs = normalizeInputs({
      ...DEFAULTS,
      actualExpenses: [
        actual({ id: "x1", expenseId: firstLineId, amount: firstLineBudget + 50_000 }),
        actual({ id: "x2", amount: 75_000, category: "Site extras" }),
      ],
    });
    const eacSum = eacByLine(i).reduce((s, r) => s + r.eac, 0);
    expect(eacSum).toBe(buildSubtotal(forecastInputs(i)));
  });
});
