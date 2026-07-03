// The "honest" layer that sits beside the faithful engine. Everything here is
// the corrected analysis from the deal teardown — it never mutates ./model, it
// only re-derives the figures the source model flatters or omits:
//
//   1. Loan principal is repaid (the source IRR counts the ₹2 Cr loan as an
//      inflow at M0 but never pays it back) -> corrected IRR ~63% vs 115%.
//   2. The funding gap is bridged by selling one unit early at a discount
//      (~₹1.7 Cr) -> profit/ROE drop the source model never shows (~212% ROE).
//   3. Returns are quoted in USD after INR depreciation.
//   4. Downside is shown WITH the debt that survives it.

import {
  Inputs,
  CF_MONTHS,
  BEAR_RATIO,
  BULL_RATIO,
  SENS_CONSTRUCTION_RATES,
  SENS_SALE_RATES,
  DEFAULT_BRIDGE_PRICE,
} from "./defaults";
import {
  builtUp,
  perUnit,
  landSubtotal,
  buildSubtotal,
  contingencyCost,
  interestCarry,
  totalCost,
  netFlows,
  irr,
  marketUnits,
  prebuyRevenue,
  capitalPrincipal,
  capitalPartnerReturns,
} from "./model";
import { financingSummary, emiNetFlows } from "./financing";

/**
 * Interest actually paid over the build under the chosen repayment mode: the
 * lumped bullet carry for interest-only (the faithful source basis), or the
 * amortized interest-over-build for full-EMI. The honest layer charges what the
 * financing really costs; the reported (model.ts) side stays on the bullet carry.
 */
export function financingInterest(i: Inputs): number {
  return i.repayment === "fullEMI" ? financingSummary(i).interestOverBuild : interestCarry(i);
}

const annualize = (quarterly: number) =>
  Number.isNaN(quarterly) ? NaN : Math.pow(1 + quarterly, 4) - 1;

/**
 * Source levered flows with the obligations the faithful engine ignores repaid
 * at exit: the ₹loanAmount loan principal AND every capital partner's principal
 * plus agreed return. (Unit-buyers keep their unit, so nothing flows back to
 * them.) With no capital partners this is just the loan repayment, as before.
 */
export function correctedNetFlows(i: Inputs, saleRate: number): number[] {
  const base = netFlows(i, saleRate);
  const exit = CF_MONTHS[CF_MONTHS.length - 1];
  const repaid = i.loanAmount + capitalPrincipal(i) + capitalPartnerReturns(i);
  return base.map((cf, idx) => (CF_MONTHS[idx] === exit ? cf - repaid : cf));
}

export function reportedAnnualIrr(i: Inputs, saleRate: number): number {
  return annualize(irr(netFlows(i, saleRate)));
}

export function correctedAnnualIrr(i: Inputs, saleRate: number): number {
  return annualize(irr(correctedNetFlows(i, saleRate)));
}

/**
 * Corrected annual IRR that honors the repayment mode: the amortization schedule
 * (EMI drag + the balance still owed repaid at exit) for full-EMI, the bullet
 * corrected flows otherwise. Centralized so every surface that quotes the
 * "after loan repaid" IRR — the verdict hero AND the Scenarios table — runs the
 * SAME math and can never show two different numbers for the same case.
 */
export function correctedAnnualIrrByMode(i: Inputs, saleRate: number): number {
  return i.repayment === "fullEMI"
    ? annualize(irr(emiNetFlows(i, { corrected: true, saleRate })))
    : correctedAnnualIrr(i, saleRate);
}

/** The deal's real engine: profit / total cost, with the ~24-month annualization. */
export function unlevered(i: Inputs) {
  const cost = totalCost(i);
  const unitValue = i.baseSaleRate * perUnit(i);
  const revenue = marketUnits(i) * unitValue + prebuyRevenue(i);
  const profit = revenue - cost - capitalPartnerReturns(i);
  const totalReturn = cost > 0 ? profit / cost : NaN;
  // Annualize over the CF grid's fixed exit — revenue lands at M21/M24 no matter
  // how long the loan runs, so loanMonths must not stretch/shrink the window.
  const years = CF_MONTHS[CF_MONTHS.length - 1] / 12;
  return {
    profit,
    totalReturn,
    annual: Number.isFinite(totalReturn) ? Math.pow(1 + totalReturn, 1 / years) - 1 : NaN,
  };
}

/**
 * Bridge the funding gap by selling ONE of the three market units early at a
 * discount (default ₹1.7 Cr) — the actual plan. The source model assumes all
 * three sell at full market, so it overstates profit by the discount.
 */
export function dilutionScenario(i: Inputs, bridgePrice = i.bridgePrice ?? DEFAULT_BRIDGE_PRICE) {
  // Honest cost charges the repayment mode's real interest, not the bullet carry
  // baked into totalCost. Interest-only is a no-op (swaps the same number back in).
  const cost = totalCost(i) - interestCarry(i) + financingInterest(i);
  const unitValue = i.baseSaleRate * perUnit(i);
  const mUnits = marketUnits(i);
  const bridgeUnits = mUnits > 0 ? 1 : 0;
  // Bridge the gap by selling ONE market unit early at a discount; the remaining
  // market units sell at market, the pre-bought units at their fixed price.
  const revenue =
    Math.max(0, mUnits - bridgeUnits) * unitValue + bridgeUnits * bridgePrice + prebuyRevenue(i);
  const profit = revenue - cost - capitalPartnerReturns(i);
  return {
    bridgePrice,
    revenue,
    profit,
    roe: i.equity > 0 ? profit / i.equity : NaN,
    margin: revenue > 0 ? profit / revenue : NaN,
    discountVsMarket: bridgeUnits ? unitValue - bridgePrice : 0,
  };
}

// ---- NET (after-debt) scenarios & sensitivity ----
// These generalize dilutionScenario by sale rate so every profit figure on the
// page sits on the SAME honest basis as the hero (real interest, the funding-gap
// bridge sale of one unit, and capital-partner returns subtracted). The base
// case (saleRate === i.baseSaleRate) reduces EXACTLY to dilutionScenario().

export type NetScenario = {
  saleRate: number;
  unitValue: number;
  revenue: number;
  profit: number;
  margin: number;
  roe: number;
  annualIrr: number;
};

/** One after-debt scenario at an arbitrary sale rate (base == dilutionScenario). */
export function netScenario(
  i: Inputs,
  saleRate: number,
  bridgePrice = i.bridgePrice ?? DEFAULT_BRIDGE_PRICE,
): NetScenario {
  const cost = totalCost(i) - interestCarry(i) + financingInterest(i); // honest cost (real interest)
  const unitValue = saleRate * perUnit(i);
  const mUnits = marketUnits(i);
  const bridgeUnits = mUnits > 0 ? 1 : 0; // one unit bridge-sold at a discount
  const revenue =
    Math.max(0, mUnits - bridgeUnits) * unitValue + bridgeUnits * bridgePrice + prebuyRevenue(i);
  const profit = revenue - cost - capitalPartnerReturns(i);
  return {
    saleRate,
    unitValue,
    revenue,
    profit,
    margin: revenue > 0 ? profit / revenue : NaN,
    roe: i.equity > 0 ? profit / i.equity : NaN,
    annualIrr: correctedAnnualIrrByMode(i, saleRate),
  };
}

/** Bear / base / bull on the net basis, tracking the workbook's sale-rate ratios. */
export function netScenarios(i: Inputs): {
  bear: NetScenario;
  base: NetScenario;
  bull: NetScenario;
} {
  return {
    bear: netScenario(i, i.baseSaleRate * BEAR_RATIO),
    base: netScenario(i, i.baseSaleRate),
    bull: netScenario(i, i.baseSaleRate * BULL_RATIO),
  };
}

/**
 * Net-profit (₹ Cr) sensitivity grid mirroring model.ts sensitivityGrid, but on
 * the honest basis: real interest, the bridge sale, and capital returns netted.
 */
export function netSensitivityGrid(i: Inputs) {
  const bu = builtUp(i);
  const land = landSubtotal(i);
  const honestInt = financingInterest(i);
  const unitArea = perUnit(i);
  const mUnits = marketUnits(i);
  const bridge = mUnits > 0 ? 1 : 0;
  const bridgePrice = i.bridgePrice ?? DEFAULT_BRIDGE_PRICE;
  const fixed = prebuyRevenue(i);
  const capRet = capitalPartnerReturns(i);
  // Anchor the grid on the ITEMIZED build (the hero's basis) and move it only by
  // the construction-rate delta, instead of recomputing a coarse build per cell.
  // At constr === i.constructionRate the build is exactly buildSubtotal(i), so the
  // operating cell reconciles to netBreakdown; for an unedited deal buildSubtotal
  // == (constructionRate+extrasRate)·bu, so this reduces to the old coarse formula.
  const itemizedBuild = buildSubtotal(i);
  const grid = SENS_CONSTRUCTION_RATES.map((constr) =>
    SENS_SALE_RATES.map((sale) => {
      const buildAtRate = itemizedBuild + (constr - i.constructionRate) * bu;
      const cost = land + buildAtRate * (1 + i.contingencyPct) + honestInt;
      return (
        (Math.max(0, mUnits - bridge) * sale * unitArea +
          bridge * bridgePrice +
          fixed -
          cost -
          capRet) /
        1e7
      );
    }),
  );
  return { constructionRates: SENS_CONSTRUCTION_RATES, saleRates: SENS_SALE_RATES, grid };
}

export type NetBreakdown = {
  marketSales: number;
  bridgeSale: number;
  prebuy: number;
  revenue: number;
  land: number;
  build: number;
  contingency: number;
  financingInterest: number;
  cost: number;
  capitalReturns: number;
  netProfit: number;
  loanRepaid: number; // repaid at exit (affects IRR, shown for visibility)
  capitalPrincipal: number;
  roe: number;
  correctedIrr: number;
};

/** The base net figure decomposed into every additive piece (for the breakdown UI). */
export function netBreakdown(i: Inputs, bridgePrice = i.bridgePrice ?? DEFAULT_BRIDGE_PRICE): NetBreakdown {
  const unitValue = i.baseSaleRate * perUnit(i);
  const mUnits = marketUnits(i);
  const bridgeUnits = mUnits > 0 ? 1 : 0;
  const marketSales = Math.max(0, mUnits - bridgeUnits) * unitValue;
  const bridgeSale = bridgeUnits * bridgePrice;
  const prebuy = prebuyRevenue(i);
  const revenue = marketSales + bridgeSale + prebuy;

  const land = landSubtotal(i);
  const build = buildSubtotal(i);
  const contingency = contingencyCost(i);
  const fin = financingInterest(i);
  const cost = land + build + contingency + fin; // == totalCost - interestCarry + financingInterest

  const capitalReturns = capitalPartnerReturns(i);
  const netProfit = revenue - cost - capitalReturns;

  return {
    marketSales,
    bridgeSale,
    prebuy,
    revenue,
    land,
    build,
    contingency,
    financingInterest: fin,
    cost,
    capitalReturns,
    netProfit,
    loanRepaid: i.loanAmount,
    capitalPrincipal: capitalPrincipal(i),
    roe: i.equity > 0 ? netProfit / i.equity : NaN,
    correctedIrr: correctedAnnualIrrByMode(i, i.baseSaleRate),
  };
}

/** Convert an annual INR return to USD given annual INR depreciation vs USD. */
export const toUsdReturn = (annualInr: number, fxDepreciation: number) =>
  Number.isNaN(annualInr) ? NaN : (1 + annualInr) / (1 + fxDepreciation) - 1;

export type DownsideRow = {
  label: string;
  saleRate: number;
  profit: number;
  roe: number;
  /** Do the three market-unit sales cover the loan principal? */
  coversLoan: boolean;
  loan: number;
};

/** Downside ladder that keeps the ₹2 Cr loan visible at every rung. */
export function downsideLadder(i: Inputs): DownsideRow[] {
  const cost = totalCost(i);
  const fixedRevenue = prebuyRevenue(i);
  const capReturns = capitalPartnerReturns(i);
  // Rungs derived from the deal's own base sale rate so the percentage labels stay
  // honest at any base (the old hardcoded 9k/8k/7k were only ~−30%/−40% at ~₹11.5k).
  const rungs = [
    { label: "Base", saleRate: i.baseSaleRate },
    { label: "Bear", saleRate: i.baseSaleRate * BEAR_RATIO },
    { label: "Soft −30%", saleRate: i.baseSaleRate * 0.7 },
    { label: "Hard −40%", saleRate: i.baseSaleRate * 0.6 },
  ];
  return rungs.map(({ label, saleRate }) => {
    const unitValue = saleRate * perUnit(i);
    const marketSales = marketUnits(i) * unitValue;
    const profit = marketSales + fixedRevenue - cost - capReturns;
    return {
      label,
      saleRate,
      profit,
      roe: i.equity > 0 ? profit / i.equity : NaN,
      coversLoan: marketSales >= i.loanAmount,
      loan: i.loanAmount,
    };
  });
}

export type Reality = {
  reportedIrr: number;
  correctedIrr: number;
  unlevered: ReturnType<typeof unlevered>;
  dilution: ReturnType<typeof dilutionScenario>;
  usd: { reportedIrr: number; correctedIrr: number; fxDepreciation: number };
  downside: DownsideRow[];
  breakevenSaleRate: number; // on the market units, with pre-bought units fixed at cost
};

/** One call that assembles the whole honest picture for the panel. */
export function computeReality(i: Inputs, fxDepreciation = 0.04): Reality {
  const reportedIrr = reportedAnnualIrr(i, i.baseSaleRate);
  // Full-EMI re-clothes the corrected flows with the amortization schedule (EMI
  // drag + the balance still owed repaid at exit); interest-only keeps the bullet
  // corrected flows. Same helper the Scenarios table uses, so the two never drift.
  const correctedIrr = correctedAnnualIrrByMode(i, i.baseSaleRate);
  // Pre-bought units are fixed at their price, so breakeven — plus any capital-
  // partner return — falls only on the market units.
  const breakevenSaleRate =
    marketUnits(i) > 0
      ? (totalCost(i) + capitalPartnerReturns(i) - prebuyRevenue(i)) /
        (marketUnits(i) * perUnit(i))
      : NaN;
  return {
    reportedIrr,
    correctedIrr,
    unlevered: unlevered(i),
    dilution: dilutionScenario(i),
    usd: {
      reportedIrr: toUsdReturn(reportedIrr, fxDepreciation),
      correctedIrr: toUsdReturn(correctedIrr, fxDepreciation),
      fxDepreciation,
    },
    downside: downsideLadder(i),
    breakevenSaleRate,
  };
}

// re-exported so callers can keep the build-stack primitives in one import
export { landSubtotal, buildSubtotal, contingencyCost, interestCarry, builtUp };
