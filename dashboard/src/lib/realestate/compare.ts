// Current-vs-baseline diffs for the control center. Pure: runs the engine on
// both input sets and reports per-metric and per-budget-category deltas. The UI
// renders these with the existing <Delta> chip.

import { type Inputs } from "./defaults";
import { compute, buildSubtotal, type Strategy } from "./model";
import { computeReality, netBreakdown } from "./reality";
import { constructionByCategory } from "./construction";

export type CompareUnit = "inr" | "pct" | "rate" | "x";

export type MetricDelta = {
  key: string;
  label: string;
  unit: CompareUnit;
  current: number;
  baseline: number;
  delta: number; // current − baseline
  pct: number; // delta / |baseline| (NaN when baseline is 0 / non-finite)
  lowerIsBetter?: boolean; // cost-like metrics — UI inverts the delta tone
};

function metric(
  key: string,
  label: string,
  unit: CompareUnit,
  current: number,
  baseline: number,
  lowerIsBetter = false,
): MetricDelta {
  const delta = current - baseline;
  const pct = Number.isFinite(baseline) && baseline !== 0 ? delta / Math.abs(baseline) : NaN;
  return { key, label, unit, current, baseline, delta, pct, lowerIsBetter };
}

/** The headline metrics, current vs baseline, on the honest (post-debt) basis. */
export function compareMetrics(
  current: Inputs,
  baseline: Inputs,
  strategy: Strategy,
): MetricDelta[] {
  const cc = compute(current, strategy);
  const cb = compute(baseline, strategy);
  const rc = computeReality(current);
  const rb = computeReality(baseline);
  const nc = netBreakdown(current);
  const nb = netBreakdown(baseline);
  return [
    metric("netProfit", "Net profit", "inr", rc.dilution.profit, rb.dilution.profit),
    metric("roe", "ROE", "x", rc.dilution.roe, rb.dilution.roe),
    metric("correctedIrr", "Corrected IRR", "pct", rc.correctedIrr, rb.correctedIrr),
    metric("revenue", "Revenue", "inr", nc.revenue, nb.revenue),
    metric("totalCost", "Total cost", "inr", cc.totalCost, cb.totalCost, true),
    metric("build", "Build cost", "inr", buildSubtotal(current), buildSubtotal(baseline), true),
    metric("breakeven", "Breakeven /sqft", "rate", cc.breakeven, cb.breakeven, true),
  ];
}

export type BudgetDelta = {
  category: string;
  current: number;
  baseline: number;
  delta: number;
};

/** Per-category build budget diff, largest movements first. */
export function compareBudget(current: Inputs, baseline: Inputs): BudgetDelta[] {
  const cur = new Map(constructionByCategory(current).map((c) => [c.category, c.amount]));
  const base = new Map(constructionByCategory(baseline).map((c) => [c.category, c.amount]));
  const cats = [...new Set([...cur.keys(), ...base.keys()])];
  return cats
    .map((category) => {
      const c = cur.get(category) ?? 0;
      const b = base.get(category) ?? 0;
      return { category, current: c, baseline: b, delta: c - b };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}
