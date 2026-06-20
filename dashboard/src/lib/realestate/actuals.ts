// Planned-vs-actual aggregations over a deal's logged real-world expenses.
// Pure; the engine never reads these — they're a tracking layer over the budget.
import type { Inputs } from "./defaults";
import type { ActualExpense, ActualStatus } from "./actuals-defaults";
import { constructionByCategory } from "./construction";

export const actualsTotal = (i: Inputs): number =>
  (i.actualExpenses ?? []).reduce((s, a) => s + (a.amount || 0), 0);

export type ActualsStatusTotals = Record<ActualStatus, number>;

/** Σ actual amounts grouped by settlement status (for the spend-log rollup). */
export function actualsByStatus(list: readonly ActualExpense[] | undefined): ActualsStatusTotals {
  const t: ActualsStatusTotals = { paid: 0, pending: 0, partial: 0 };
  for (const a of list ?? []) t[a.status] += a.amount || 0;
  return t;
}

export type PvaRow = {
  category: string;
  budgeted: number;
  actual: number;
  variance: number; // actual − budgeted (positive = over budget)
  pct: number; // actual / budgeted (0 when nothing budgeted)
};

/** Per-category budgeted vs actual, budget categories first then actual-only ones. */
export function plannedVsActual(i: Inputs): {
  rows: PvaRow[];
  totalBudget: number;
  totalActual: number;
  variance: number;
} {
  const budget = constructionByCategory(i);
  const budgetByCat = new Map(budget.map((c) => [c.category, c.amount]));
  const actualByCat = new Map<string, number>();
  for (const a of i.actualExpenses ?? []) {
    const cat = a.category || "Unassigned";
    actualByCat.set(cat, (actualByCat.get(cat) ?? 0) + (a.amount || 0));
  }
  const ordered = [
    ...budget.map((c) => c.category),
    ...[...actualByCat.keys()].filter((c) => !budgetByCat.has(c)),
  ];
  const rows: PvaRow[] = ordered.map((category) => {
    const budgeted = budgetByCat.get(category) ?? 0;
    const actual = actualByCat.get(category) ?? 0;
    return { category, budgeted, actual, variance: actual - budgeted, pct: budgeted > 0 ? actual / budgeted : 0 };
  });
  const totalBudget = budget.reduce((s, c) => s + c.amount, 0);
  const totalActual = actualsTotal(i);
  return { rows, totalBudget, totalActual, variance: totalActual - totalBudget };
}

/** Actuals logged against a specific budget line item. */
export const actualsForItem = (i: Inputs, expenseId: string): ActualExpense[] =>
  (i.actualExpenses ?? []).filter((a) => a.expenseId === expenseId);
