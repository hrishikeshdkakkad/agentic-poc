// Provenance layer: turns the engine's final figures into expandable derivation
// trees so every number on the page can be drilled to its exact composition,
// down to individual budget line items. CRITICAL: this module never re-implements
// the math — each node's `value` is the output of an existing engine primitive
// (model.ts / reality.ts / construction.ts), and the children are explanatory.
// trace.test.ts asserts that every `sum` node equals the sum of its children to
// the rupee, so the tree can never drift from the parity-locked engine.
//
// Two deliberately SEPARATE trees exist because they sit on different bases:
//   • the cost / revenue / profit trees reconcile among themselves (totalCost,
//     netBreakdown), and
//   • the IRR tree is built from the dated cash-flow series (netFlows /
//     correctedNetFlows), which carries the ₹7,50,000 M3 prep outflow that is
//     NOT in totalCost. They are annotated, never force-reconciled.

import { Inputs, CF_MONTHS } from "./defaults";
import {
  landSubtotal,
  buildSubtotal,
  contingencyCost,
  interestCarry,
  totalCost,
  builtUp,
  perUnit,
  marketUnits,
  prebuyUnits,
  trancheTotal,
  netFlows,
} from "./model";
import {
  netBreakdown,
  correctedNetFlows,
  correctedAnnualIrrByMode,
  reportedAnnualIrr,
} from "./reality";
import { emiNetFlows } from "./financing";
import { constructionByCategory } from "./construction";
import { cr, rate as inrRate } from "./format";

export type TraceUnit = "inr" | "pct" | "rate" | "x" | "sqft" | "num";
// `sum` nodes MUST equal Σ children.value (enforced by trace.test.ts). `formula`
// nodes carry a human formula and a value straight from an engine primitive (used
// for products like contingency/carry and for subtractions like net profit, which
// don't reconcile as a plain sum). `leaf` is a terminal source value.
export type TraceOp = "sum" | "formula" | "leaf";

export type TraceNode = {
  key: string;
  label: string;
  value: number;
  unit: TraceUnit;
  op: TraceOp;
  formula?: string; // shown for `formula` nodes
  note?: string; // advisory annotation — never a reconciliation target
  sub?: string; // small descriptive subtitle
  children?: TraceNode[];
};

const leaf = (
  key: string,
  label: string,
  value: number,
  unit: TraceUnit = "inr",
  sub?: string,
): TraceNode => ({ key, label, value, unit, op: "leaf", sub });

// ---- shared subtrees ----

/** Land & approvals = site + registration + brokerage + khata (always integer ₹). */
function landSubtree(i: Inputs): TraceNode {
  return {
    key: "land",
    label: "Land & approvals",
    value: landSubtotal(i),
    unit: "inr",
    op: "sum",
    sub: "site + registration + brokerage + khata",
    children: [
      leaf("land:site", "Site cost", i.siteCost),
      leaf("land:reg", "Registration", i.registration),
      leaf("land:brok", "Brokerage", i.brokerage),
      leaf("land:khata", "Khata", i.khata),
    ],
  };
}

/**
 * Build subtree. Mirrors the engine's ternary (model.ts buildSubtotal): when an
 * itemized budget exists it's a sum of categories → line items; otherwise it's
 * the coarse-rate formula leaf. The itemized path always reconciles to the rupee
 * because every line item belongs to exactly one category.
 */
function buildSubtree(i: Inputs): TraceNode {
  const value = buildSubtotal(i);
  const items = i.constructionExpenses ?? [];
  if (!items.length) {
    return {
      key: "build",
      label: "Build",
      value,
      unit: "inr",
      op: "formula",
      formula: `(₹${i.constructionRate} + ₹${i.extrasRate})/sqft × ${builtUp(i).toLocaleString("en-IN")} sqft`,
      sub: "coarse rate (no itemized budget)",
    };
  }
  const children = constructionByCategory(i).map((c) => {
    const lines = items.filter((e) => e.category === c.category);
    return {
      key: `build:${c.category}`,
      label: c.category,
      value: c.amount,
      unit: "inr" as const,
      op: "sum" as const,
      sub: `${c.count} item${c.count === 1 ? "" : "s"}`,
      children: lines.map((e) =>
        leaf(
          `ci:${e.id}`,
          e.item,
          e.amount,
          "inr",
          e.unit === "lumpsum"
            ? `M${e.month} · lumpsum`
            : `M${e.month} · ${e.qty} ${e.unit} × ₹${e.rate.toLocaleString("en-IN")}`,
        ),
      ),
    } satisfies TraceNode;
  });
  return {
    key: "build",
    label: "Build",
    value,
    unit: "inr",
    op: "sum",
    sub: `${items.length} items`,
    children,
  };
}

const pctLabel = (p: number) => `${(p * 100).toFixed(p * 100 < 10 ? 2 : 1)}%`;

/**
 * Saleable-area derivation, shared by every revenue node that prices a unit:
 * per-unit area = built-up ÷ units, built-up = plot × FAR. All `formula` nodes
 * (products/quotients don't reconcile as plain sums), terminating in the raw
 * plot / FAR / unit-count leaves.
 */
function specsSubtree(i: Inputs): TraceNode {
  return {
    key: "perUnit",
    label: "Per-unit area",
    value: perUnit(i),
    unit: "sqft",
    op: "formula",
    formula: `built-up ÷ ${i.units} unit${i.units === 1 ? "" : "s"}`,
    children: [
      {
        key: "builtUp",
        label: "Built-up area",
        value: builtUp(i),
        unit: "sqft",
        op: "formula",
        formula: "plot × FAR",
        children: [
          leaf("spec:plot", "Plot area", i.plotArea, "sqft"),
          leaf("spec:far", "FAR", i.far, "x"),
        ],
      },
      leaf("spec:units", "Units", i.units, "num"),
    ],
  };
}

// ---- top-level trees ----

/** Total cost = Land + Build + Contingency + Interest carry (faithful basis). */
export function costTrace(i: Inputs): TraceNode {
  return {
    key: "totalCost",
    label: "Total cost",
    value: totalCost(i),
    unit: "inr",
    op: "sum",
    children: [
      landSubtree(i),
      buildSubtree(i),
      {
        key: "contingency",
        label: "Contingency",
        value: contingencyCost(i),
        unit: "inr",
        op: "formula",
        formula: `Build × ${pctLabel(i.contingencyPct)}`,
        sub: `${pctLabel(i.contingencyPct)} of build`,
      },
      {
        key: "carry",
        label: "Interest carry",
        value: interestCarry(i),
        unit: "inr",
        op: "formula",
        formula: "Loan × rate × months ÷ 12",
        sub: `bullet carry · ${i.loanMonths} mo @ ${(i.loanRate * 100).toFixed(2)}%`,
      },
    ],
  };
}

/** Revenue = market-unit sales + bridge sale + pre-bought units (honest basis).
 * Each child drills to its own formula: market sales → rate × per-unit × units
 * (per-unit → built-up → plot × FAR); bridge → price vs market; pre-buy → one
 * leaf per unit-buyer (Σ tranches), which reconciles to the rupee. */
export function revenueTrace(i: Inputs): TraceNode {
  const b = netBreakdown(i);
  const unitValue = i.baseSaleRate * perUnit(i);
  const mUnits = marketUnits(i);
  const bridgeUnits = mUnits > 0 ? 1 : 0;
  const fullMarket = Math.max(0, mUnits - bridgeUnits); // units sold at FULL market
  const preUnits = prebuyUnits(i);
  const bridgePrice = i.bridgePrice;
  const discount = unitValue > 0 ? (unitValue - bridgePrice) / unitValue : 0;
  const unitBuyers = i.investors.filter((v) => v.kind === "unit");

  return {
    key: "revenue",
    label: "Revenue",
    value: b.revenue,
    unit: "inr",
    op: "sum",
    sub: "after the funding-gap bridge sale",
    children: [
      {
        key: "rev:market",
        label: "Market-unit sales",
        value: b.marketSales, // = fullMarket × unitValue
        unit: "inr",
        op: "formula",
        formula: `${fullMarket} unit${fullMarket === 1 ? "" : "s"} × ${cr(unitValue)}`,
        sub: "units sold at full market rate",
        children: [
          leaf(
            "rev:market:units",
            "Units at market",
            fullMarket,
            "num",
            `${i.units} total − ${preUnits} pre-bought${bridgeUnits ? " − 1 bridge" : ""}`,
          ),
          {
            key: "rev:market:unitval",
            label: "Unit value",
            value: unitValue, // = baseSaleRate × per-unit area
            unit: "inr",
            op: "formula",
            formula: `${inrRate(i.baseSaleRate)}/sqft × per-unit area`,
            children: [leaf("rev:market:rate", "Base sale rate", i.baseSaleRate, "rate", "₹/sqft"), specsSubtree(i)],
          },
        ],
      },
      {
        key: "rev:bridge",
        label: "Bridge unit sale",
        value: b.bridgeSale, // = bridgeUnits × bridgePrice
        unit: "inr",
        op: "formula",
        formula: bridgeUnits ? `${bridgeUnits} unit × ${cr(bridgePrice)}` : "no bridge sale",
        sub: bridgeUnits
          ? `early sale · ${pctLabel(Math.abs(discount))} ${discount >= 0 ? "below" : "above"} ${cr(unitValue)} market`
          : "no market unit available to bridge-sell",
      },
      {
        key: "rev:prebuy",
        label: "Pre-bought units",
        value: b.prebuy, // = Σ unit-buyer tranches
        unit: "inr",
        op: "sum",
        sub: "at what their buyers actually pay (Σ tranches)",
        children: unitBuyers.map((v) =>
          leaf(
            `rev:prebuy:${v.id}`,
            v.name,
            trancheTotal(v),
            "inr",
            `${v.units ?? 1} unit${(v.units ?? 1) === 1 ? "" : "s"} · ${v.tranches.length} tranche${v.tranches.length === 1 ? "" : "s"}`,
          ),
        ),
      },
    ],
  };
}

/** Honest cost = Land + Build + Contingency + Financing interest (matches the
 * hero; financing interest is the real interest, = carry under interest-only). */
function netCostSubtree(i: Inputs): TraceNode {
  const b = netBreakdown(i);
  return {
    key: "cost",
    label: "Total cost",
    value: b.cost,
    unit: "inr",
    op: "sum",
    children: [
      landSubtree(i),
      buildSubtree(i),
      {
        key: "contingency",
        label: "Contingency",
        value: b.contingency,
        unit: "inr",
        op: "formula",
        formula: `Build × ${pctLabel(i.contingencyPct)}`,
      },
      {
        key: "fin",
        label: "Financing interest",
        value: b.financingInterest,
        unit: "inr",
        op: "formula",
        formula: "real interest over the build",
        sub: i.repayment === "fullEMI" ? "amortized EMIs" : "interest-only carry",
      },
    ],
  };
}

/** Net profit = Revenue − Cost − Capital-partner returns (the verdict figure). */
export function netProfitTrace(i: Inputs): TraceNode {
  const b = netBreakdown(i);
  return {
    key: "netProfit",
    label: "Net profit",
    value: b.netProfit,
    unit: "inr",
    op: "formula",
    formula: "Revenue − Cost − Capital-partner returns",
    children: [
      revenueTrace(i),
      netCostSubtree(i),
      leaf("capRet", "Capital-partner returns", b.capitalReturns, "inr", "agreed return paid at exit"),
    ],
  };
}

/** Levered cash-flow series the IRR runs on, matching whatever basis the IRR
 * value is solved on (EMI schedule under full-EMI, bullet otherwise). */
function correctedFlows(i: Inputs, saleRate: number): number[] {
  return i.repayment === "fullEMI"
    ? emiNetFlows(i, { corrected: true, saleRate })
    : correctedNetFlows(i, saleRate);
}

/**
 * IRR tree — a SEPARATE basis from the cost tree. Its leaves are the dated
 * cash flows the IRR solves; the ₹7,50,000 M3 prep outflow lives here (and not
 * in total cost), so it's annotated, not reconciled to the cost tree.
 */
export function irrTrace(
  i: Inputs,
  opts: { corrected?: boolean; saleRate?: number } = {},
): TraceNode {
  const corrected = opts.corrected ?? true;
  const saleRate = opts.saleRate ?? i.baseSaleRate;
  const flows = corrected ? correctedFlows(i, saleRate) : netFlows(i, saleRate);
  const value = corrected
    ? correctedAnnualIrrByMode(i, saleRate)
    : reportedAnnualIrr(i, saleRate);
  return {
    key: corrected ? "correctedIrr" : "reportedIrr",
    label: corrected ? "Corrected annual IRR" : "Reported annual IRR",
    value,
    unit: "pct",
    op: "formula",
    formula: "annualized rate solving NPV(cash flows) = 0",
    note:
      "The ₹7,50,000 M3 plan-sanction outflow is modeled in these cash flows only, not in total cost.",
    children: CF_MONTHS.map((m, idx) =>
      leaf(
        `cf:${m}`,
        `Month ${m}`,
        flows[idx],
        "inr",
        flows[idx] > 0 ? "cash in" : flows[idx] < 0 ? "cash out" : "no flow",
      ),
    ),
  };
}
