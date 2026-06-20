// Forecast layer: turns logged actuals into a live Estimate-at-Completion (EAC)
// and runs the SAME honest engine on it, so the page can show "where profit
// actually lands" beside the plan — with zero engine duplication.
//
// Actuals join to the budget by CATEGORY — the only link the editor sets — so the
// forecast can never disagree with the "spent vs budget" rollup (which buckets the
// same way). A category's EAC = max(its budget, its committed-so-far): you can't
// un-spend, so an overspent category forecasts at its committed total; an under-
// or untouched category forecasts at budget. Actuals whose category has no budget
// line are "unbudgeted" and append on top. The forecast Inputs is EPHEMERAL — build
// it, compute, discard. It must NEVER be persisted (its synthetic lines would
// otherwise become permanent budget).

import { type Inputs } from "./defaults";
import { computeReality, type Reality } from "./reality";
import type { ActualExpense } from "./actuals-defaults";
import type { ConstructionExpense } from "./construction-defaults";
import { constructionByCategory } from "./construction";

export type ForecastBasis = "committed" | "paid";

/** Which actuals count toward the forecast: all of them on the committed basis;
 * on the paid basis, settled AND partially-settled lines (a partial payment is
 * real cash out the door — excluding it entirely would hide a partially-paid
 * overspend). Only fully-unpaid "pending" lines are excluded on the paid basis. */
const counts = (a: ActualExpense, basis: ForecastBasis) =>
  basis === "paid" ? a.status === "paid" || a.status === "partial" : true;

// Actuals with no category bucket here, matching plannedVsActual's fallback so the
// forecast and the rollup label unbudgeted spend identically.
const UNASSIGNED = "Unassigned";

/** Σ counted actuals per category (same bucketing as plannedVsActual). */
function committedByCategory(i: Inputs, basis: ForecastBasis): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of i.actualExpenses ?? []) {
    if (!counts(a, basis)) continue;
    const cat = a.category || UNASSIGNED;
    m.set(cat, (m.get(cat) ?? 0) + (a.amount || 0));
  }
  return m;
}

/** Budgeted ₹ per category, from the itemized construction budget. */
function budgetByCategory(i: Inputs): Map<string, number> {
  return new Map(constructionByCategory(i).map((c) => [c.category, c.amount]));
}

/**
 * Build an EPHEMERAL forecast Inputs whose construction budget encodes the EAC.
 * Original budget lines are left intact; a synthetic line tops up any category
 * that has committed past its budget (an "overspend" for budgeted categories, an
 * "unbudgeted" line for categories with no budget). `actualExpenses` is stripped
 * so nothing downstream double-counts. NEVER persist.
 */
export function forecastInputs(i: Inputs, basis: ForecastBasis = "committed"): Inputs {
  const committed = committedByCategory(i, basis);
  const budget = budgetByCategory(i);
  const synthetic: ConstructionExpense[] = [];
  for (const [category, com] of committed) {
    const over = com - (budget.get(category) ?? 0);
    if (over <= 0) continue; // under/on budget → the existing budget lines already cover it
    const unbudgeted = !budget.has(category);
    synthetic.push({
      id: `fc-${unbudgeted ? "unbudgeted" : "overspend"}:${category}`,
      category,
      item: unbudgeted ? "Logged actuals (unbudgeted)" : "Committed over budget",
      qty: 1,
      unit: "lumpsum",
      rate: over,
      amount: over,
      month: 24, // exit; month is irrelevant to the economics (only the total feeds buildSubtotal)
    });
  }
  return {
    ...i,
    constructionExpenses: [...(i.constructionExpenses ?? []), ...synthetic],
    actualExpenses: [],
  };
}

/** The honest figures recomputed on the EAC. Reduces EXACTLY to computeReality(i)
 * when there are no actuals. */
export function forecast(i: Inputs, basis: ForecastBasis = "committed"): Reality {
  return computeReality(forecastInputs(i, basis));
}

export type EacRow = {
  category: string;
  budget: number; // 0 for unbudgeted categories
  committed: number;
  eac: number; // max(budget, committed)
  unbudgeted: boolean;
};

/** Per-category plan-vs-forecast rows for the EAC grid (budget categories in
 * canonical order, then unbudgeted ones). Σ eac == buildSubtotal(forecastInputs). */
export function eacByCategory(i: Inputs, basis: ForecastBasis = "committed"): EacRow[] {
  const committed = committedByCategory(i, basis);
  const budgetCats = constructionByCategory(i);
  const seen = new Set(budgetCats.map((c) => c.category));
  const budgeted: EacRow[] = budgetCats.map((c) => {
    const com = committed.get(c.category) ?? 0;
    return { category: c.category, budget: c.amount, committed: com, eac: Math.max(c.amount, com), unbudgeted: false };
  });
  const unbudgeted: EacRow[] = [];
  for (const [category, com] of committed) {
    if (seen.has(category)) continue;
    unbudgeted.push({ category, budget: 0, committed: com, eac: com, unbudgeted: true });
  }
  return [...budgeted, ...unbudgeted];
}
