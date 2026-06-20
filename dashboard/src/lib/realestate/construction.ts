// Aggregations over the itemized construction budget — pure functions for the
// UI and (later) agentic computation. `buildSubtotal` itself is derived in
// model.ts; this module shapes the same line items into the views the page needs.
import type { Inputs } from "./defaults";
import { builtUp } from "./model";
import { CONSTRUCTION_CATEGORIES, sumExpenses, type ConstructionExpense } from "./construction-defaults";

export const constructionTotal = (i: Inputs): number => sumExpenses(i.constructionExpenses);

export type CategoryBreakdown = { category: string; amount: number; count: number; pct: number };

/** Spend per category, in canonical category order, with share of the total. */
export function constructionByCategory(i: Inputs): CategoryBreakdown[] {
  const total = constructionTotal(i);
  const acc = new Map<string, { amount: number; count: number }>();
  for (const e of i.constructionExpenses ?? []) {
    const cur = acc.get(e.category) ?? { amount: 0, count: 0 };
    cur.amount += e.amount;
    cur.count += 1;
    acc.set(e.category, cur);
  }
  const known = CONSTRUCTION_CATEGORIES.filter((c) => acc.has(c));
  const extras = [...acc.keys()].filter((c) => !CONSTRUCTION_CATEGORIES.includes(c as never));
  return [...known, ...extras].map((category) => {
    const { amount, count } = acc.get(category)!;
    return { category, amount, count, pct: total > 0 ? amount / total : 0 };
  });
}

export type PhaseBreakdown = { month: number; amount: number; pct: number };

/** Spend by cash-flow month (the construction draw schedule). */
export function constructionByPhase(i: Inputs): PhaseBreakdown[] {
  const total = constructionTotal(i);
  const acc = new Map<number, number>();
  for (const e of i.constructionExpenses ?? []) acc.set(e.month, (acc.get(e.month) ?? 0) + e.amount);
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([month, amount]) => ({ month, amount, pct: total > 0 ? amount / total : 0 }));
}

/** Blended build rate implied by the itemized budget (₹/sqft). */
export const constructionPerSqft = (i: Inputs): number => {
  const bu = builtUp(i);
  return bu > 0 ? constructionTotal(i) / bu : NaN;
};

export type Reconciliation = { itemized: number; coarse: number; variance: number; matched: boolean };

/** Itemized total vs the legacy coarse build budget ((rate+extras)×builtUp). */
export function constructionReconciliation(i: Inputs): Reconciliation {
  const itemized = constructionTotal(i);
  const coarse = (i.constructionRate + i.extrasRate) * builtUp(i);
  const variance = itemized - coarse;
  return { itemized, coarse, variance, matched: Math.abs(variance) < 1 };
}

/** A fresh line item for the editor's "add row". */
export function blankExpense(category: string): ConstructionExpense {
  return {
    id: `ce-${Math.random().toString(36).slice(2, 9)}`,
    category,
    item: "New item",
    qty: 1,
    unit: "lumpsum",
    rate: 0,
    amount: 0,
    month: 6,
  };
}

// ---- category workspace ops (pure list transforms) ----

export function renameCategory(
  list: ConstructionExpense[],
  from: string,
  to: string,
): ConstructionExpense[] {
  const target = to.trim() || from;
  return list.map((e) => (e.category === from ? { ...e, category: target } : e));
}

export function removeCategory(list: ConstructionExpense[], category: string): ConstructionExpense[] {
  return list.filter((e) => e.category !== category);
}

/** Adding a category = appending a starter line tagged with it (categories are derived from items). */
export function addCategoryLine(list: ConstructionExpense[], category: string): ConstructionExpense[] {
  return [...list, blankExpense(category)];
}
