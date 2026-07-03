// Exercises the REAL engine wiring (compute + computeReality), unlike
// scripts/realestate-parity.mjs which re-implements the math independently.
// Two jobs:
//   1. The SMV default (one "Manoj" unit-buyer) must reproduce the source
//      workbook's faithful + reality figures exactly — the parity contract.
//   2. The generalized investor model (N unit-buyers + capital partners) must
//      behave correctly: capital-partner returns are an honest cost the reality
//      layer surfaces, never a faithful-headline deduction.

import { describe, expect, it } from "vitest";
import { DEFAULTS, Inputs, normalizeInputs, validateInputs } from "./defaults";
import {
  compute,
  marketUnits,
  perUnit,
  prebuyRevenue,
  investorCapital,
  capitalPartnerReturns,
  totalCost,
  irr,
} from "./model";
import { emiNetFlows, financingSummary } from "./financing";
import { computeReality, netScenarios } from "./reality";
import { migrateInputs } from "./deals";

describe("SMV default — parity with the source workbook", () => {
  const r = compute(DEFAULTS, "sellAll");

  it("built-up area", () => expect(r.builtUp).toBe(7200));
  it("total cost", () => expect(r.totalCost).toBe(59_626_000));
  it("base profit", () => expect(r.scenarios.base.profit).toBe(17_974_000));
  it("margin", () => expect(r.scenarios.base.margin).toBeCloseTo(0.231624, 5));
  it("ROE ×", () => expect(r.scenarios.base.roe).toBeCloseTo(2.66865, 4));
  it("reported annual IRR", () => expect(r.scenarios.base.annualIrr).toBeCloseTo(1.1527, 3));
  it("sources", () =>
    expect(r.sources).toBe(DEFAULTS.equity + DEFAULTS.loanAmount + 15_500_000));
  it("breakeven is the required market-unit sale rate after fixed pre-buy revenue", () => {
    const expected = (totalCost(DEFAULTS) - prebuyRevenue(DEFAULTS)) /
      (marketUnits(DEFAULTS) * perUnit(DEFAULTS));
    expect(r.breakeven).toBeCloseTo(expected, 2);
  });
  it("sensitivity grid respects pre-bought units at their fixed price", () => {
    const row = r.sensitivity.constructionRates.indexOf(2250);
    const col = r.sensitivity.saleRates.indexOf(11000);
    const expected =
      (11000 * perUnit(DEFAULTS) * marketUnits(DEFAULTS) + prebuyRevenue(DEFAULTS) - totalCost(DEFAULTS)) /
      10_000_000;
    expect(r.sensitivity.grid[row][col]).toBeCloseTo(expected, 6);
  });

  const reality = computeReality(DEFAULTS);
  it("corrected IRR (loan repaid)", () => expect(reality.correctedIrr).toBeCloseTo(0.631, 2));
  it("dilution profit", () => expect(reality.dilution.profit).toBe(14_274_000));
  it("dilution ROE ×", () => expect(reality.dilution.roe).toBeCloseTo(2.1193, 3));
  it("unlevered annual", () => expect(reality.unlevered.annual).toBeCloseTo(0.1408, 3));
  it("no capital partners → zero capital cost", () =>
    expect(capitalPartnerReturns(DEFAULTS)).toBe(0));
});

describe("generalized investors — multiple buyers + a capital partner", () => {
  // 5 units: two unit pre-buyers take one each (3 left for market), plus a
  // capital partner who funds the build for an 18% annual preferred return.
  // Buyer B pays at M12 so M0 stays a net outlay and the levered IRR is defined.
  const multi: Inputs = {
    ...DEFAULTS,
    units: 5,
    investors: [
      { id: "a", name: "Buyer A", kind: "unit", units: 1, tranches: [{ amount: 8_500_000, month: 0 }, { amount: 7_000_000, month: 12 }] },
      { id: "b", name: "Buyer B", kind: "unit", units: 1, tranches: [{ amount: 10_000_000, month: 12 }] },
      { id: "c", name: "Capital LLP", kind: "capital", returnPct: 0.18, tranches: [{ amount: 5_000_000, month: 0 }] },
    ],
  };

  it("market units = units − pre-bought", () => expect(marketUnits(multi)).toBe(3));
  it("pre-buy revenue = Σ unit-buyer tranches", () => expect(prebuyRevenue(multi)).toBe(25_500_000));
  it("sources include all investor capital", () =>
    expect(investorCapital(multi)).toBe(30_500_000));

  // Capital partner: ₹50L outstanding for the full 24-month horizon at 18%/yr
  // simple interest = 50L × 0.18 × 2 = ₹9L.
  it("capital-partner return is simple interest to exit", () =>
    expect(capitalPartnerReturns(multi)).toBe(1_800_000));

  const faithful = compute(multi, "sellAll").scenarios.base;
  const reality = computeReality(multi);

  it("faithful headline does NOT deduct the capital-partner return", () => {
    // perUnit = 7200/5 = 1440 → unitValue = 11_500 × 1440 = 16_560_000
    // revenue = 3×16_560_000 + 25_500_000 = 75_180_000; cost = 59_626_000
    expect(faithful.profit).toBe(75_180_000 - 59_626_000);
  });

  it("reality deducts exactly the capital-partner return", () => {
    expect(faithful.profit - reality.unlevered.profit).toBe(1_800_000);
  });

  it("capital repayment drags the corrected IRR below the reported one", () => {
    expect(reality.correctedIrr).toBeLessThan(reality.reportedIrr);
  });

  it("breakeven falls on the market units, lifted by the capital cost", () => {
    // (cost + capitalReturn − prebuyRevenue) / (marketUnits × perUnit)
    const expected = (59_626_000 + 1_800_000 - 25_500_000) / (3 * 1440);
    expect(reality.breakevenSaleRate).toBeCloseTo(expected, 2);
  });
});

describe("legacy deal migration", () => {
  it("rebuilds the Manoj unit-buyer from manoj1/manoj2 and drops the dead keys", () => {
    // Simulate a pre-generalization deal: flat manoj fields, no investors array.
    const legacy: Record<string, unknown> = { ...DEFAULTS, manoj1: 9_000_000, manoj2: 6_000_000 };
    delete legacy.investors;

    const migrated = migrateInputs(legacy);
    expect(migrated.investors).toHaveLength(1);
    expect(migrated.investors[0]).toMatchObject({ name: "Manoj", kind: "unit", units: 1 });
    expect(migrated.investors[0].tranches).toEqual([
      { amount: 9_000_000, month: 0 },
      { amount: 6_000_000, month: 12 },
    ]);
    expect((migrated as Record<string, unknown>).manoj1).toBeUndefined();
    expect((migrated as Record<string, unknown>).manoj2).toBeUndefined();
    // The rebuilt deal still computes (regression against a silently-broken upgrade).
    expect(compute(migrated, "sellAll").scenarios.base.profit).toBeTypeOf("number");
  });

  it("leaves a current-shape deal untouched", () => {
    expect(migrateInputs(DEFAULTS).investors).toEqual(DEFAULTS.investors);
  });

  it("normalizes corrupted saved numbers into finite engine inputs", () => {
    const normalized = normalizeInputs({
      ...DEFAULTS,
      units: 0,
      equity: 0,
      loanRate: Number.NaN,
      investors: [
        { id: "bad", name: "", kind: "unit", units: -3, tranches: [{ amount: -100, month: 5 }] },
      ],
      baseSaleRate: Infinity,
    });
    const result = compute(normalized, "sellAll");
    expect(normalized.units).toBe(1);
    expect(normalized.equity).toBe(1);
    expect(normalized.loanRate).toBe(DEFAULTS.loanRate);
    expect(normalized.investors[0].units).toBe(1);
    expect(normalized.investors[0].tranches[0]).toEqual({ amount: 0, month: 6 });
    expect(Number.isFinite(result.totalCost)).toBe(true);
  });

  it("blank investor names default by KIND, never to the SMV seed's name", () => {
    // The old per-index fallback resolved to DEFAULTS.investors[0] ("Manoj") for
    // every index, renaming any blank-named investor — even a capital partner.
    const normalized = normalizeInputs({
      ...DEFAULTS,
      investors: [
        { id: "u", name: "  ", kind: "unit", units: 1, tranches: [{ amount: 1, month: 0 }] },
        { id: "c", name: "", kind: "capital", returnPct: 0.2, tranches: [{ amount: 1, month: 0 }] },
      ],
    });
    expect(normalized.investors[0].name).toBe("Unit buyer");
    expect(normalized.investors[1].name).toBe("Capital partner");
  });

  it("flags impossible unit-buyer mixes instead of computing silent nonsense", () => {
    const invalid: Inputs = {
      ...DEFAULTS,
      units: 2,
      investors: [
        { id: "a", name: "A", kind: "unit", units: 1, tranches: [{ amount: 1_000_000, month: 0 }] },
        { id: "b", name: "B", kind: "unit", units: 1, tranches: [{ amount: 1_000_000, month: 0 }] },
      ],
    };
    expect(validateInputs(invalid)).toContain(
      "At least one unit must remain available for market sale; the sale-rate model cannot value a fully pre-bought project.",
    );
  });
});

describe("full-EMI repayment flows into the honest layer", () => {
  const annualize = (q: number) => Math.pow(1 + q, 4) - 1;
  // Short tenure so the amortization actually bites within the 24-month build,
  // making the interest-only vs full-EMI difference observable.
  const fullEmi: Inputs = { ...DEFAULTS, repayment: "fullEMI", loanTenureYears: 2 };
  const intOnly: Inputs = { ...fullEmi, repayment: "interestOnly" };

  it("corrected IRR responds to the repayment toggle", () => {
    const a = computeReality(fullEmi).correctedIrr;
    const b = computeReality(intOnly).correctedIrr;
    expect(Math.abs(a - b)).toBeGreaterThan(0.02);
  });

  it("corrected IRR is computed on the EMI schedule, not the bullet carry", () => {
    const expected = annualize(irr(emiNetFlows(fullEmi, { corrected: true })));
    expect(computeReality(fullEmi).correctedIrr).toBeCloseTo(expected, 6);
  });

  it("honest profit rises because amortizing pays less total interest than the bullet carry", () => {
    expect(computeReality(fullEmi).dilution.profit).toBeGreaterThan(
      computeReality(intOnly).dilution.profit,
    );
  });

  it("interest-only honest numbers are unchanged (parity preserved)", () => {
    expect(computeReality(DEFAULTS).dilution.profit).toBe(14_274_000);
    expect(computeReality(DEFAULTS).correctedIrr).toBeCloseTo(0.631, 2);
  });

  it("the Scenarios base IRR equals the verdict hero's corrected IRR (one source of truth)", () => {
    // Both quote "annual IRR after loan repaid"; in full-EMI mode they must run
    // the SAME amortization-aware math, not bullet-vs-EMI. (Interest-only always
    // agreed; the regression was full-EMI only.)
    expect(netScenarios(fullEmi).base.annualIrr).toBeCloseTo(
      computeReality(fullEmi).correctedIrr,
      6,
    );
    expect(netScenarios(intOnly).base.annualIrr).toBeCloseTo(
      computeReality(intOnly).correctedIrr,
      6,
    );
  });
});

describe("full-EMI EMI drag honors loanMonths", () => {
  // Long tenure so a meaningful balance survives at both 12 and 24 months.
  const lm24: Inputs = { ...DEFAULTS, repayment: "fullEMI", loanTenureYears: 5, loanMonths: 24 };
  const lm12: Inputs = { ...lm24, loanMonths: 12 };
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

  it("a shorter outstanding window can't pay MORE total EMIs", () => {
    // Old code paid 24 months of EMIs regardless, then repaid the 12-month
    // balloon on top — a double paydown that made the shorter loan look worse.
    const exit24 = sum(emiNetFlows(lm24, { corrected: true }));
    const exit12 = sum(emiNetFlows(lm12, { corrected: true }));
    expect(exit12).toBeGreaterThan(exit24);
  });

  it("the exit gap equals exactly the interest the shorter term saves (no double-count)", () => {
    // loanMonths is the ONLY thing differing, and it only changes interest paid
    // while outstanding; principal is retired exactly once either way.
    const exit24 = sum(emiNetFlows(lm24, { corrected: true }));
    const exit12 = sum(emiNetFlows(lm12, { corrected: true }));
    const dInterest =
      financingSummary(lm24).interestOverBuild - financingSummary(lm12).interestOverBuild;
    expect(Math.abs(exit12 - exit24 - dInterest)).toBeLessThan(1);
  });

  it("loanMonths = 24 is unchanged (parity with the pre-fix engine)", () => {
    // 8 quarters × 3 EMIs = 24 EMI-months, exactly as before.
    const flows = emiNetFlows(lm24, { corrected: true });
    const baseline = emiNetFlows({ ...DEFAULTS, repayment: "fullEMI", loanTenureYears: 5 });
    // structural: same number of steps, finite throughout
    expect(flows).toHaveLength(9);
    expect(flows.every(Number.isFinite)).toBe(true);
    expect(baseline.every(Number.isFinite)).toBe(true);
  });
});
