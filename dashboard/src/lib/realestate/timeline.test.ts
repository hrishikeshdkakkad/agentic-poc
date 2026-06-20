import { describe, expect, it } from "vitest";
import { DEFAULTS, Inputs } from "./defaults";
import { interestCarry, capitalPrincipal, capitalPartnerReturns } from "./model";
import { financingSummary } from "./financing";
import { profitTimeline } from "./timeline";

describe("profitTimeline — SMV default", () => {
  const rep = profitTimeline(DEFAULTS);
  const cor = profitTimeline(DEFAULTS, { corrected: true });

  it("spans the quarterly horizon", () => {
    expect(rep.months).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24]);
    expect(rep.cumCash).toHaveLength(9);
  });

  it("peak capital at risk is the M18 trough (≈ ₹2.15 Cr)", () => {
    expect(rep.troughIndex).toBe(6);
    expect(rep.months[rep.troughIndex]).toBe(18);
    expect(rep.peakCapitalAtRisk).toBe(21_476_000);
  });

  it("break-even-in-time lands just after M20", () => {
    expect(rep.breakevenMonth).toBeCloseTo(20.33, 2);
  });

  it("distributed interest sums to the model's total carry, monotonically", () => {
    expect(rep.totalInterest).toBeCloseTo(interestCarry(DEFAULTS), 2);
    expect(rep.totalInterest).toBeCloseTo(3_400_000, 2); // ₹0.34 Cr
    expect(rep.cumInterest[0]).toBe(0); // nothing accrued at M0
    for (let k = 1; k < rep.cumInterest.length; k++) {
      expect(rep.cumInterest[k]).toBeGreaterThanOrEqual(rep.cumInterest[k - 1]);
    }
  });

  it("reported exit carries the unrepaid loan; corrected repays it", () => {
    // identical curve until the exit step
    expect(cor.cumCash.slice(0, 8)).toEqual(rep.cumCash.slice(0, 8));
    expect(cor.troughIndex).toBe(rep.troughIndex);
    const repaid =
      DEFAULTS.loanAmount + capitalPrincipal(DEFAULTS) + capitalPartnerReturns(DEFAULTS);
    expect(repaid).toBe(20_000_000); // just the loan; no capital partners
    expect(rep.exitValue - cor.exitValue).toBe(repaid);
    expect(cor.exitValue).toBeLessThan(rep.exitValue);
  });
});

describe("profitTimeline — with a capital partner", () => {
  const i: Inputs = {
    ...DEFAULTS,
    units: 5,
    investors: [
      ...DEFAULTS.investors,
      { id: "cap", name: "Cap", kind: "capital", returnPct: 0.18, tranches: [{ amount: 5_000_000, month: 0 }] },
    ],
  };

  it("corrected exit repays loan + partner principal + partner return", () => {
    const rep = profitTimeline(i);
    const cor = profitTimeline(i, { corrected: true });
    const repaid = i.loanAmount + capitalPrincipal(i) + capitalPartnerReturns(i);
    expect(repaid).toBeCloseTo(20_000_000 + 5_000_000 + 1_800_000, 2);
    expect(rep.exitValue - cor.exitValue).toBeCloseTo(repaid, 2);
  });
});

describe("profitTimeline — durable break-even", () => {
  // A big capital tranche lands at M21 (pushing the position briefly positive),
  // then the M24 loan + partner repayment sinks it underwater by exit.
  const i: Inputs = {
    ...DEFAULTS,
    baseSaleRate: 7000,
    investors: [
      ...DEFAULTS.investors,
      { id: "cap", name: "Cap", kind: "capital", returnPct: 0.18, tranches: [{ amount: 30_000_000, month: 21 }] },
    ],
  };

  it("reports no break-even when the curve surfaces then exits underwater", () => {
    const t = profitTimeline(i, { corrected: true });
    // there IS a transient upward crossing...
    const crossedUp = t.cumCash.some((v, k) => k > 0 && t.cumCash[k - 1] < 0 && v >= 0);
    expect(crossedUp).toBe(true);
    // ...but the deal exits negative, so it never DURABLY broke even
    expect(t.exitValue).toBeLessThan(0);
    expect(t.breakevenMonth).toBeNull();
  });
});

describe("profitTimeline — full-EMI financing mode", () => {
  const i: Inputs = { ...DEFAULTS, repayment: "fullEMI" };

  it("interest line comes from the amortization schedule (≤ interest-only)", () => {
    const emi = profitTimeline(i);
    expect(emi.cumInterest[0]).toBe(0);
    expect(emi.totalInterest).toBeLessThan(profitTimeline(DEFAULTS).totalInterest);
    expect(emi.totalInterest).toBeCloseTo(financingSummary(i).interestOverBuild, 0);
  });

  it("corrected repays only the remaining balance, not the full ₹2 Cr", () => {
    const rep = profitTimeline(i);
    const cor = profitTimeline(i, { corrected: true });
    const balance = financingSummary(i).balanceAtExit;
    expect(rep.exitValue - cor.exitValue).toBeCloseTo(balance, 0);
    expect(balance).toBeLessThan(DEFAULTS.loanAmount);
  });
});
