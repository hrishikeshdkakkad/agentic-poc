// Forecast layer: turns logged actuals into a live Estimate-at-Completion (EAC)
// and runs the SAME honest engine on it, so the page can show "where profit
// actually lands" beside the plan — with zero engine duplication.
//
// EAC per budget line = max(budgeted, committed-so-far): you can't un-spend, so
// an overspent line forecasts at its committed total; an untouched line forecasts
// at budget. Actuals not tied to a live budget line (orphans / unbudgeted) are
// appended as their own forecast lines. The forecast Inputs is EPHEMERAL — build
// it, compute, discard. It must NEVER be persisted (its synthetic lines would
// otherwise become permanent budget).

import { type Inputs } from "./defaults";
import { computeReality, type Reality } from "./reality";
import type { ActualExpense } from "./actuals-defaults";
import type { ConstructionExpense } from "./construction-defaults";

export type ForecastBasis = "committed" | "paid";

/** Which actuals count toward the forecast: all of them on the committed basis;
 * on the paid basis, settled AND partially-settled lines (a partial payment is
 * real cash out the door — excluding it entirely would hide a partially-paid
 * overspend). Only fully-unpaid "pending" lines are excluded on the paid basis. */
const counts = (a: ActualExpense, basis: ForecastBasis) =>
  basis === "paid" ? a.status === "paid" || a.status === "partial" : true;

/** Σ committed actuals per LIVE budget line id (orphans excluded). */
function committedByLine(i: Inputs, basis: ForecastBasis): Map<string, number> {
  const live = new Set((i.constructionExpenses ?? []).map((e) => e.id));
  const m = new Map<string, number>();
  for (const a of i.actualExpenses ?? []) {
    if (!counts(a, basis) || !a.expenseId || !live.has(a.expenseId)) continue;
    m.set(a.expenseId, (m.get(a.expenseId) ?? 0) + (a.amount || 0));
  }
  return m;
}

/** Actuals with no expenseId, or whose expenseId points at a deleted line. */
function orphanActuals(i: Inputs, basis: ForecastBasis): ActualExpense[] {
  const live = new Set((i.constructionExpenses ?? []).map((e) => e.id));
  return (i.actualExpenses ?? []).filter(
    (a) => counts(a, basis) && (!a.expenseId || !live.has(a.expenseId)),
  );
}

/** Orphan/unbudgeted actuals collapsed into one synthetic budget line per category. */
function syntheticLines(i: Inputs, basis: ForecastBasis): ConstructionExpense[] {
  const byCat = new Map<string, number>();
  for (const a of orphanActuals(i, basis)) {
    const cat = a.category || "Unbudgeted";
    byCat.set(cat, (byCat.get(cat) ?? 0) + (a.amount || 0));
  }
  return [...byCat.entries()].map(([category, amount]) => ({
    id: `fc-unbudgeted:${category}`,
    category,
    item: "Logged actuals (unbudgeted)",
    qty: 1,
    unit: "lumpsum",
    rate: amount,
    amount,
    month: 24, // exit; month is irrelevant to the economics (only the total feeds buildSubtotal)
  }));
}

/**
 * Build an EPHEMERAL forecast Inputs whose construction budget encodes the EAC.
 * `actualExpenses` is stripped so nothing downstream double-counts. NEVER persist.
 */
export function forecastInputs(i: Inputs, basis: ForecastBasis = "committed"): Inputs {
  const committed = committedByLine(i, basis);
  const forecastLines = (i.constructionExpenses ?? []).map((e) => ({
    ...e,
    amount: Math.max(e.amount, committed.get(e.id) ?? 0),
  }));
  return {
    ...i,
    constructionExpenses: [...forecastLines, ...syntheticLines(i, basis)],
    actualExpenses: [],
  };
}

/** The honest figures recomputed on the EAC. Reduces EXACTLY to computeReality(i)
 * when there are no actuals. */
export function forecast(i: Inputs, basis: ForecastBasis = "committed"): Reality {
  return computeReality(forecastInputs(i, basis));
}

export type EacRow = {
  id: string;
  item: string;
  category: string;
  budget: number; // 0 for unbudgeted lines
  committed: number;
  eac: number; // max(budget, committed) for budgeted lines; = committed for unbudgeted
  unbudgeted: boolean;
};

/** Per-line plan-vs-forecast rows for the EAC grid (budgeted lines, then unbudgeted). */
export function eacByLine(i: Inputs, basis: ForecastBasis = "committed"): EacRow[] {
  const committed = committedByLine(i, basis);
  const budgeted: EacRow[] = (i.constructionExpenses ?? []).map((e) => {
    const c = committed.get(e.id) ?? 0;
    return {
      id: e.id,
      item: e.item,
      category: e.category,
      budget: e.amount,
      committed: c,
      eac: Math.max(e.amount, c),
      unbudgeted: false,
    };
  });
  const unbudgeted: EacRow[] = syntheticLines(i, basis).map((s) => ({
    id: s.id,
    item: s.item,
    category: s.category,
    budget: 0,
    committed: s.amount,
    eac: s.amount,
    unbudgeted: true,
  }));
  return [...budgeted, ...unbudgeted];
}
