// Pure calculation engine — ported verbatim from the standalone
// smv-deal-simulator (lib/model.ts). Faithful by design: it reproduces the
// source workbook's numbers (base profit ₹1.80 Cr / 23.2% margin / 267% ROE /
// 115% annual IRR). The honest, corrected figures (loan repaid, dilution
// bridge, USD, downside-with-debt) live in ./reality and never touch this file.
//
// No React, no I/O — just inputs in, numbers out. Verified against the source
// via scripts/realestate-parity.mjs.

import {
  Inputs,
  Investor,
  BEAR_RATIO,
  BULL_RATIO,
  CF_MONTHS,
  SENS_CONSTRUCTION_RATES,
  SENS_SALE_RATES,
} from "./defaults";
import { sumExpenses } from "./construction-defaults";

export type Strategy = "sellAll" | "hold1";

export type ScenarioResult = {
  key: "bear" | "base" | "bull";
  label: string;
  saleRate: number;
  unitValue: number; // market value of one unit at this rate
  revenue: number; // market-unit sales + pre-bought units at their fixed price
  profit: number; // revenue - total cost
  margin: number; // profit / revenue
  roe: number; // all-in profit / equity (strategy-aware)
  cashProfit: number; // realised cash profit in hold-1 strategy
  heldUnitValue: number; // market value of the unit you keep
  allInProfit: number; // cash + held unit (hold-1) — equals profit for sell-all
  quarterlyIrr: number;
  annualIrr: number;
  netFlows: number[]; // levered net cash flow per CF_MONTHS step
};

export type ModelResult = {
  // Specs
  builtUp: number;
  perUnit: number;

  // Cost stack
  landSubtotal: number;
  buildSubtotal: number;
  contingencyCost: number;
  interestCarry: number;
  totalCost: number;
  allInCostPerSqft: number;

  // Breakeven
  breakeven: number; // ₹/sqft to cover total cost
  breakevenBufferBase: number; // buffer of base sale rate over breakeven

  // Funding
  sources: number;
  gap: number;

  // Scenarios
  scenarios: { bear: ScenarioResult; base: ScenarioResult; bull: ScenarioResult };

  // Sensitivity
  sensitivity: {
    constructionRates: number[];
    saleRates: number[];
    grid: number[][]; // gross profit in ₹ Cr; rows = construction, cols = sale
  };

  months: number[];
};

// ---- cost-stack primitives ----

export const builtUp = (i: Inputs) => i.plotArea * i.far;
export const perUnit = (i: Inputs) => builtUp(i) / Math.max(1, i.units);

// ---- investor aggregation (replaces the old hardcoded `manoj1`/`manoj2`) ----
// All of these collapse to the legacy single-Manoj math when `investors` is just
// the SMV seed, so the parity figures are preserved.

export const trancheTotal = (inv: Investor) =>
  inv.tranches.reduce((s, t) => s + t.amount, 0);

const unitBuyers = (i: Inputs) => i.investors.filter((v) => v.kind === "unit");
const capitalPartners = (i: Inputs) => i.investors.filter((v) => v.kind === "capital");

/** Units pre-bought across all unit-buyers (capital partners take none). */
export const prebuyUnits = (i: Inputs) =>
  unitBuyers(i).reduce((s, v) => s + (v.units ?? 1), 0);

/** Units left to sell at market. */
export const marketUnits = (i: Inputs) => Math.max(0, i.units - prebuyUnits(i));

/** Revenue from pre-bought units = what those buyers actually pay (Σ tranches). */
export const prebuyRevenue = (i: Inputs) =>
  unitBuyers(i).reduce((s, v) => s + trancheTotal(v), 0);

/** Total outside capital (both kinds) — a funding source for the build. */
export const investorCapital = (i: Inputs) =>
  i.investors.reduce((s, v) => s + trancheTotal(v), 0);

/** Principal owed back to capital partners at exit (unit-buyers keep a unit instead). */
export const capitalPrincipal = (i: Inputs) =>
  capitalPartners(i).reduce((s, v) => s + trancheTotal(v), 0);

/** Every investor tranche (both kinds) landing on CF step `m`. */
export const investorInflowAt = (i: Inputs, m: number) =>
  i.investors.reduce(
    (s, v) => s + v.tranches.filter((t) => t.month === m).reduce((a, t) => a + t.amount, 0),
    0,
  );

/**
 * Honest cost of capital-partner money: principal is a wash (in then out), but
 * the agreed return is real money the developer pays at exit. Simple interest
 * from each tranche's month to the exit step, mirroring `interestCarry`. Zero
 * when there are no capital partners (so the SMV default is unaffected).
 */
export const capitalPartnerReturns = (i: Inputs) => {
  const exit = CF_MONTHS[CF_MONTHS.length - 1];
  return capitalPartners(i).reduce(
    (s, v) =>
      s +
      v.tranches.reduce(
        (a, t) => a + t.amount * (v.returnPct ?? 0) * ((exit - t.month) / 12),
        0,
      ),
    0,
  );
};

export const landSubtotal = (i: Inputs) =>
  i.siteCost + i.registration + i.brokerage + i.khata;

/** Authoritative itemized build total (Σ construction-expense amounts). */
export const constructionExpensesTotal = (i: Inputs) => sumExpenses(i.constructionExpenses);

// Build cost derives from the itemized construction budget when present. The
// default SMV itemization sums to exactly (constructionRate+extrasRate)×builtUp,
// so the parity numbers are preserved; otherwise it falls back to coarse rates.
export const buildSubtotal = (i: Inputs) =>
  i.constructionExpenses && i.constructionExpenses.length
    ? constructionExpensesTotal(i)
    : (i.constructionRate + i.extrasRate) * builtUp(i);

export const contingencyCost = (i: Inputs) => buildSubtotal(i) * i.contingencyPct;

export const interestCarry = (i: Inputs) =>
  (i.loanAmount * i.loanRate * i.loanMonths) / 12;

export const totalCost = (i: Inputs) =>
  landSubtotal(i) + buildSubtotal(i) + contingencyCost(i) + interestCarry(i);

// ---- IRR (bisection on the dated cash-flow series) ----

export function irr(cashflows: number[]): number {
  const npv = (r: number) =>
    cashflows.reduce((s, cf, t) => s + cf / Math.pow(1 + r, t), 0);

  let lo = -0.9;
  let hi = 10;
  let fLo = npv(lo);
  // If there's no sign change the series has no real IRR in range.
  if (fLo * npv(hi) > 0) return NaN;

  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    const f = npv(mid);
    if (Math.abs(f) < 1) return mid; // within ₹1 of zero NPV
    if (f * fLo > 0) {
      lo = mid;
      fLo = f;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

// Levered net cash flow per quarterly step for a given sale rate. Loan
// disbursement + every investor tranche count as inflows (this is why the IRR is
// high). Capital-partner repayment is deliberately omitted here — like the
// unpaid loan, it lives in the reality layer (./reality correctedNetFlows).
export function netFlows(i: Inputs, saleRate: number): number[] {
  const land = landSubtotal(i);
  const draw = (buildSubtotal(i) + contingencyCost(i)) / 5;
  const carry = interestCarry(i);
  // Market units sell across M21 & M24, split evenly. (= saleRate·builtUp·0.375
  // when 3 of 4 units go to market, as in the SMV default.)
  const saleTranche = (saleRate * perUnit(i) * marketUnits(i)) / 2;

  return CF_MONTHS.map((m) => {
    let cf = 0;
    if (m === 0) cf += -land + i.loanAmount;
    if (m === 3) cf += -750_000; // plan sanction & prep
    if (m === 6 || m === 9 || m === 12 || m === 15 || m === 18) cf += -draw;
    cf += investorInflowAt(i, m); // Manoj's & any other investor's tranches
    if (m === 21) cf += -carry + saleTranche;
    if (m === 24) cf += saleTranche;
    return cf;
  });
}

// ---- one scenario ----

function scenario(
  i: Inputs,
  key: ScenarioResult["key"],
  label: string,
  saleRate: number,
  strategy: Strategy
): ScenarioResult {
  const cost = totalCost(i);
  const unitValue = saleRate * perUnit(i);
  const mUnits = marketUnits(i);
  const fixedRevenue = prebuyRevenue(i); // pre-bought units at their fixed price

  // Sell all: every market unit at market + the pre-bought units at fixed price.
  const revenue = mUnits * unitValue + fixedRevenue;
  const profit = revenue - cost;

  // Hold-1 decomposition: sell all-but-one market unit + fixed cash; keep one.
  const cashInflow = Math.max(0, mUnits - 1) * unitValue + fixedRevenue;
  const cashProfit = cashInflow - cost;
  const heldUnitValue = mUnits >= 1 ? unitValue : 0;
  const allInProfit = cashProfit + heldUnitValue; // == profit when mUnits >= 1

  const realisedProfit = strategy === "hold1" ? allInProfit : profit;
  const roe = i.equity > 0 ? realisedProfit / i.equity : NaN;

  const flows = netFlows(i, saleRate);
  const q = irr(flows);
  const annual = Number.isNaN(q) ? NaN : Math.pow(1 + q, 4) - 1;

  return {
    key,
    label,
    saleRate,
    unitValue,
    revenue,
    profit,
    margin: revenue > 0 ? profit / revenue : NaN,
    roe,
    cashProfit,
    heldUnitValue,
    allInProfit,
    quarterlyIrr: q,
    annualIrr: annual,
    netFlows: flows,
  };
}

// ---- sensitivity grid ----

function sensitivityGrid(i: Inputs) {
  const bu = builtUp(i);
  const land = landSubtotal(i);
  const carry = interestCarry(i);
  const unitArea = perUnit(i);
  const mUnits = marketUnits(i);
  const fixedRevenue = prebuyRevenue(i);
  const grid = SENS_CONSTRUCTION_RATES.map((constr) =>
    SENS_SALE_RATES.map((sale) => {
      const cost =
        land + (constr + i.extrasRate) * bu * (1 + i.contingencyPct) + carry;
      return (sale * unitArea * mUnits + fixedRevenue - cost) / 10_000_000; // ₹ Cr
    })
  );
  return {
    constructionRates: SENS_CONSTRUCTION_RATES,
    saleRates: SENS_SALE_RATES,
    grid,
  };
}

// ---- top-level compute ----

export function compute(i: Inputs, strategy: Strategy): ModelResult {
  const cost = totalCost(i);
  const bu = builtUp(i);
  const sources = i.equity + i.loanAmount + investorCapital(i);
  const saleArea = marketUnits(i) * perUnit(i);
  const breakeven = saleArea > 0 ? (cost - prebuyRevenue(i)) / saleArea : NaN;
  const allInCostPerSqft = bu > 0 ? cost / bu : NaN;

  return {
    builtUp: bu,
    perUnit: perUnit(i),
    landSubtotal: landSubtotal(i),
    buildSubtotal: buildSubtotal(i),
    contingencyCost: contingencyCost(i),
    interestCarry: interestCarry(i),
    totalCost: cost,
    allInCostPerSqft,
    breakeven,
    breakevenBufferBase: breakeven > 0 ? (i.baseSaleRate - breakeven) / breakeven : NaN,
    sources,
    gap: cost - sources,
    scenarios: {
      bear: scenario(i, "bear", "Bear", i.baseSaleRate * BEAR_RATIO, strategy),
      base: scenario(i, "base", "Base", i.baseSaleRate, strategy),
      bull: scenario(i, "bull", "Bull", i.baseSaleRate * BULL_RATIO, strategy),
    },
    sensitivity: sensitivityGrid(i),
    months: CF_MONTHS,
  };
}
