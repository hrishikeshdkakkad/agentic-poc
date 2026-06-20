// SMV Layout deal — base assumptions, ported verbatim from the standalone
// smv-deal-simulator (lib/defaults.ts) so the numbers match the source model
// exactly. These are the "blue" cells you adjust. The corrected/honest figures
// live alongside in ./reality, never by editing this faithful engine.

import {
  type ConstructionExpense,
  DEFAULT_CONSTRUCTION_EXPENSES,
  normalizeConstructionExpenses,
} from "./construction-defaults";
import { type ActualExpense, normalizeActualExpenses } from "./actuals-defaults";

// A co-investor's capital arrives in one or more dated installments ("tranches").
// The month must land on the quarterly CF grid (see CF_MONTHS) to show up in the
// IRR timeline; the input UI constrains it to those steps.
export type Tranche = {
  amount: number; // ₹ in this installment
  month: number; // CF step it lands on
};

// Two economically different ways outside money enters the deal:
//   "unit"    — pre-buys `units` of the project at a fixed price = Σ tranches
//               (this is what "Manoj" was). Counts as revenue, is never repaid,
//               and removes those units from the market-sale pool.
//   "capital" — funds the build for a return; takes no unit; repaid principal +
//               `returnPct` (simple interest, like the loan) at exit. The return
//               is an honest cost surfaced by the reality layer.
export type InvestorKind = "unit" | "capital";

export type Investor = {
  id: string;
  name: string;
  kind: InvestorKind;
  tranches: Tranche[];
  units?: number; // "unit" kind: units pre-bought (treated as 1 if omitted)
  returnPct?: number; // "capital" kind: annual preferred return, e.g. 0.18
};

// Floating rates can drift mid-build (repo/EBLR-linked); fixed locks the rate.
export type RateType = "fixed" | "floating";
// Interest-only carry (the faithful source model) vs amortizing EMIs from day one.
export type Repayment = "interestOnly" | "fullEMI";

export type Inputs = {
  // Project specs
  plotArea: number; // sqft
  far: number;
  units: number;

  // Land & approvals
  siteCost: number;
  registration: number;
  brokerage: number;
  khata: number;

  // Build
  constructionRate: number; // ₹/sqft
  extrasRate: number; // ₹/sqft
  contingencyPct: number;

  // Financing
  loanAmount: number;
  loanRate: number; // annual
  loanMonths: number; // months loan is outstanding (drives interest carry)
  rateType: RateType; // "floating" enables the rate-sensitivity band
  repayment: Repayment; // interest-only carry (faithful) vs amortizing EMIs
  loanTenureYears: number; // amortization term that sets the EMI (≠ loanMonths)
  processingFeePct: number; // netted from disbursement (e.g. 0.005 = 0.5%)
  bpiDays: number; // broken-period interest days, netted from disbursement

  // Funding mix
  equity: number; // sponsor's own capital — the ROE denominator
  investors: Investor[]; // outside money: unit pre-buyers and/or capital partners

  // Pricing
  baseSaleRate: number; // ₹/sqft, market base case
  bridgePrice: number; // ₹ early-sale price of the one unit sold to bridge the funding gap

  // Construction budget — itemized line items; drives buildSubtotal when present.
  constructionExpenses: ConstructionExpense[];

  // Real-world expenses logged against the budget (planned-vs-actual). Engine-ignored.
  actualExpenses: ActualExpense[];
};

// Default early-sale price for the funding-gap bridge unit (₹1.7 Cr). Single
// source for both the DEFAULTS seed and the normalize fallback (so existing deals
// with no stored bridgePrice keep the original ₹1.7 Cr and parity is unaffected).
export const DEFAULT_BRIDGE_PRICE = 17_000_000;

export const DEFAULTS: Inputs = {
  plotArea: 2400,
  far: 3,
  units: 4,

  siteCost: 32_400_000,
  registration: 1_980_000,
  brokerage: 250_000,
  khata: 50_000,

  constructionRate: 2_250,
  extrasRate: 600,
  contingencyPct: 0.05,

  loanAmount: 20_000_000,
  loanRate: 0.085,
  loanMonths: 24,
  rateType: "floating",
  repayment: "interestOnly", // keep the SMV baseline faithful (parity-locked)
  loanTenureYears: 15,
  processingFeePct: 0.005,
  bpiDays: 15,

  equity: 6_735_250,
  investors: [
    // SMV seed: one unit pre-buyer ("Manoj") who takes 1 of the 4 units at a
    // fixed price = sum of his two tranches (₹85L at M0, ₹70L at M12). With only
    // this investor the generic engine reduces to the source workbook's numbers.
    {
      id: "manoj",
      name: "Manoj",
      kind: "unit",
      units: 1,
      tranches: [
        { amount: 8_500_000, month: 0 },
        { amount: 7_000_000, month: 12 },
      ],
    },
  ],

  baseSaleRate: 11_500,
  bridgePrice: DEFAULT_BRIDGE_PRICE,

  // Itemized decomposition of the ₹2,05,20,000 build budget (= (2250+600)×7200).
  constructionExpenses: DEFAULT_CONSTRUCTION_EXPENSES,
  actualExpenses: [],
};

// Display-only FX rate (₹ per USD) used to show USD alongside computed values.
export const DEFAULT_USD_RATE = 86;

// Bear / Bull track the base sale rate by the workbook's ratios
// (9,000 and 14,000 against an 11,500 base), so one slider moves all three.
export const BEAR_RATIO = 9_000 / 11_500;
export const BULL_RATIO = 14_000 / 11_500;

// Cash-flow / IRR timeline (quarterly steps), fixed to match the workbook engine.
export const CF_MONTHS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

// Sensitivity grid axes (fixed, matching the Sensitivity sheet).
export const SENS_CONSTRUCTION_RATES = [1800, 2000, 2250, 2500, 2750, 3000];
export const SENS_SALE_RATES = [8000, 9500, 11000, 12500, 14000, 15500, 17000];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function finiteNumber(value: unknown, fallback: number, min: number, integer = false): number {
  const n = typeof value === "number" ? value : Number(value);
  const safe = Number.isFinite(n) ? n : fallback;
  const bounded = Math.max(min, safe);
  return integer ? Math.round(bounded) : bounded;
}

function finiteRatio(value: unknown, fallback: number): number {
  return finiteNumber(value, fallback, 0);
}

function nearestCashFlowMonth(value: unknown): number {
  const n = finiteNumber(value, 0, 0, true);
  return CF_MONTHS.reduce((best, m) =>
    Math.abs(m - n) < Math.abs(best - n) ? m : best,
  );
}

function cloneInvestor(inv: Investor): Investor {
  return {
    ...inv,
    tranches: inv.tranches.map((t) => ({ ...t })),
  };
}

export function cloneInputs(inputs: Inputs = DEFAULTS): Inputs {
  return {
    ...inputs,
    investors: inputs.investors.map(cloneInvestor),
    constructionExpenses: (inputs.constructionExpenses ?? []).map((e) => ({ ...e })),
    actualExpenses: (inputs.actualExpenses ?? []).map((e) => ({ ...e })),
  };
}

function normalizeTranches(raw: unknown): Tranche[] {
  const rows = Array.isArray(raw) ? raw : [];
  const tranches = rows
    .filter(isRecord)
    .map((t) => ({
      amount: finiteNumber(t.amount, 0, 0),
      month: nearestCashFlowMonth(t.month),
    }));
  return tranches.length ? tranches : [{ amount: 0, month: 0 }];
}

function normalizeInvestors(raw: unknown): Investor[] {
  const rows = Array.isArray(raw) ? raw : DEFAULTS.investors;
  return rows.filter(isRecord).map((v, idx) => {
    const fallback = DEFAULTS.investors[idx] ?? DEFAULTS.investors[0];
    const kind: InvestorKind = v.kind === "capital" ? "capital" : "unit";
    const name =
      typeof v.name === "string" && v.name.trim()
        ? v.name.trim()
        : fallback?.name ?? (kind === "capital" ? "Capital partner" : "Unit buyer");
    const base = {
      id: typeof v.id === "string" && v.id ? v.id : `${kind}-${idx + 1}`,
      name,
      kind,
      tranches: normalizeTranches(v.tranches),
    };
    return kind === "capital"
      ? {
          ...base,
          kind,
          returnPct: finiteRatio(v.returnPct, fallback?.returnPct ?? 0.18),
        }
      : {
          ...base,
          kind,
          units: finiteNumber(v.units, fallback?.units ?? 1, 1, true),
        };
  });
}

/**
 * Coerce arbitrary stored/UI input into the numeric domain the deal engine can
 * safely evaluate. Semantic feasibility is checked separately by
 * validateInputs(), so impossible economics can be blocked instead of silently
 * rewritten.
 */
export function normalizeInputs(raw: Partial<Inputs> | null | undefined): Inputs {
  const source = isRecord(raw) ? raw : {};
  const out: Inputs = {
    plotArea: finiteNumber(source.plotArea, DEFAULTS.plotArea, 1),
    far: finiteNumber(source.far, DEFAULTS.far, 0.01),
    units: finiteNumber(source.units, DEFAULTS.units, 1, true),
    siteCost: finiteNumber(source.siteCost, DEFAULTS.siteCost, 0),
    registration: finiteNumber(source.registration, DEFAULTS.registration, 0),
    brokerage: finiteNumber(source.brokerage, DEFAULTS.brokerage, 0),
    khata: finiteNumber(source.khata, DEFAULTS.khata, 0),
    constructionRate: finiteNumber(source.constructionRate, DEFAULTS.constructionRate, 0),
    extrasRate: finiteNumber(source.extrasRate, DEFAULTS.extrasRate, 0),
    contingencyPct: finiteRatio(source.contingencyPct, DEFAULTS.contingencyPct),
    loanAmount: finiteNumber(source.loanAmount, DEFAULTS.loanAmount, 0),
    loanRate: finiteRatio(source.loanRate, DEFAULTS.loanRate),
    loanMonths: finiteNumber(source.loanMonths, DEFAULTS.loanMonths, 1, true),
    rateType: source.rateType === "fixed" ? "fixed" : "floating",
    repayment: source.repayment === "fullEMI" ? "fullEMI" : "interestOnly",
    loanTenureYears: finiteNumber(source.loanTenureYears, DEFAULTS.loanTenureYears, 1),
    processingFeePct: finiteRatio(source.processingFeePct, DEFAULTS.processingFeePct),
    bpiDays: finiteNumber(source.bpiDays, DEFAULTS.bpiDays, 0, true),
    equity: finiteNumber(source.equity, DEFAULTS.equity, 1),
    investors: normalizeInvestors(source.investors),
    baseSaleRate: finiteNumber(source.baseSaleRate, DEFAULTS.baseSaleRate, 1),
    // Missing on pre-bridgePrice deals → defaults to ₹1.7 Cr, leaving them unchanged.
    bridgePrice: finiteNumber(source.bridgePrice, DEFAULTS.bridgePrice, 0),
    constructionExpenses: [],
    actualExpenses: normalizeActualExpenses(source.actualExpenses),
  };
  // Itemized build budget drives buildSubtotal; a deal with none gets the
  // default template scaled to its coarse build budget (migration is parity-safe).
  const coarseBuild = (out.constructionRate + out.extrasRate) * (out.plotArea * out.far);
  out.constructionExpenses = normalizeConstructionExpenses(source.constructionExpenses, coarseBuild);
  return out;
}

export function normalizeUsdRate(value: unknown): number {
  return finiteNumber(value, DEFAULT_USD_RATE, 1);
}

export function validateInputs(i: Inputs): string[] {
  const issues: string[] = [];
  const unitPrebuys = i.investors
    .filter((v) => v.kind === "unit")
    .reduce((sum, v) => sum + (v.units ?? 1), 0);

  if (unitPrebuys >= i.units) {
    issues.push("At least one unit must remain available for market sale; the sale-rate model cannot value a fully pre-bought project.");
  }
  if (unitPrebuys > i.units) {
    issues.push("Unit pre-buys exceed the project unit count.");
  }
  if (i.investors.some((v) => v.tranches.length === 0)) {
    issues.push("Every investor must have at least one dated tranche.");
  }
  if (i.investors.some((v) => v.tranches.some((t) => t.amount < 0))) {
    issues.push("Investor tranche amounts cannot be negative.");
  }

  return issues;
}
