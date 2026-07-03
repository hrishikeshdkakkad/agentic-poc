import { describe, expect, it } from "vitest";
import { DEFAULTS, Inputs } from "./defaults";
import { interestCarry } from "./model";
import {
  monthlyEMI,
  amortizeThrough,
  processingFee,
  brokenPeriodInterest,
  netDisbursement,
  financingSummary,
  emiNetFlows,
  emiCumInterest,
} from "./financing";

const EMI: Inputs = { ...DEFAULTS, repayment: "fullEMI" };
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("amortization primitives", () => {
  it("EMI is straight-line when the rate is 0", () => {
    expect(monthlyEMI(1_200_000, 0, 12)).toBe(100_000);
  });

  it("amortizes to ~zero over the full tenure (never negative)", () => {
    const a = amortizeThrough(20_000_000, 0.085, 180, 180);
    expect(a.balance).toBeGreaterThanOrEqual(0);
    expect(a.balance).toBeLessThan(1000); // within ₹1k of paid off
  });

  it("interest + principal across N months equals N EMIs; principal = P − balance", () => {
    const a = amortizeThrough(20_000_000, 0.085, 180, 24);
    expect(a.interestPaid + a.principalPaid).toBeCloseTo(24 * a.emi, 0);
    expect(a.principalPaid).toBeCloseTo(20_000_000 - a.balance, 0);
  });
});

describe("disbursement netting (fee + broken-period interest)", () => {
  it("nets fee and BPI off the loan", () => {
    expect(processingFee(DEFAULTS)).toBe(20_000_000 * 0.005); // ₹1 L
    expect(brokenPeriodInterest(DEFAULTS)).toBeCloseTo((20_000_000 * 0.085 * 15) / 365, 2);
    expect(netDisbursement(DEFAULTS)).toBeCloseTo(
      20_000_000 - processingFee(DEFAULTS) - brokenPeriodInterest(DEFAULTS),
      2,
    );
  });
});

describe("financingSummary", () => {
  it("interest-only owes the full principal at exit, no EMIs", () => {
    const s = financingSummary(DEFAULTS);
    expect(s.emi).toBe(0);
    expect(s.balanceAtExit).toBe(20_000_000);
    expect(s.interestOverBuild).toBeCloseTo(interestCarry(DEFAULTS), 2);
  });

  it("full-EMI amortizes a little principal and charges slightly less interest", () => {
    const s = financingSummary(EMI);
    expect(s.emi).toBeGreaterThan(0);
    expect(s.balanceAtExit).toBeLessThan(20_000_000);
    expect(s.balanceAtExit).toBeGreaterThan(18_000_000); // modest payoff in 24 months
    expect(s.principalPaidDown).toBeCloseTo(20_000_000 - s.balanceAtExit, 0);
    expect(s.interestOverBuild).toBeLessThan(interestCarry(DEFAULTS)); // below interest-only
    expect(s.emisPaid).toBeCloseTo(s.interestOverBuild + s.principalPaidDown, 0);
  });
});

describe("financingSummary caps the EMI window at the M24 exit (loanMonths > 24)", () => {
  const long: Inputs = { ...EMI, loanMonths: 36 };

  it("interest/EMIs/balance sit on the SAME 24-month basis as emiNetFlows", () => {
    const s = financingSummary(long);
    // EMIs paid is capped at the 24-month horizon, not 36
    expect(s.emisPaid).toBeCloseTo(s.emi * 24, 0);
    // interestOverBuild matches the cumulative interest the J-curve reports at exit
    const ci = emiCumInterest(long);
    expect(s.interestOverBuild).toBeCloseTo(ci[ci.length - 1], 0);
    // the corrected J-curve repays exactly balanceAtExit (no double-count of paydown)
    const rep = sum(emiNetFlows(long));
    const cor = sum(emiNetFlows(long, { corrected: true }));
    expect(rep - cor).toBeCloseTo(s.balanceAtExit, 0);
  });

  it("the default 24-month deal is unchanged", () => {
    const s = financingSummary(EMI);
    expect(s.emisPaid).toBeCloseTo(s.emi * 24, 0);
  });
});

describe("EMI-mode J-curve flows", () => {
  it("corrected repays the remaining balance at exit", () => {
    const rep = sum(emiNetFlows(EMI));
    const cor = sum(emiNetFlows(EMI, { corrected: true }));
    expect(rep - cor).toBeCloseTo(financingSummary(EMI).balanceAtExit, 0);
  });

  it("cumulative interest is monotonic and ends at the build-window total", () => {
    const ci = emiCumInterest(EMI);
    expect(ci[0]).toBe(0);
    expect(ci[ci.length - 1]).toBeCloseTo(financingSummary(EMI).interestOverBuild, 0);
    for (let k = 1; k < ci.length; k++) expect(ci[k]).toBeGreaterThanOrEqual(ci[k - 1]);
  });

  it("corrected repays capital partners too (principal + agreed return at exit)", () => {
    // Their tranches arrive as inflows via netFlows; without the matching outflow
    // the corrected IRR was overstated for any full-EMI deal with a capital partner.
    const cap: Inputs = {
      ...EMI,
      investors: [
        ...EMI.investors,
        { id: "cp", name: "CP", kind: "capital", returnPct: 0.18, tranches: [{ amount: 5_000_000, month: 0 }] },
      ],
    };
    const rep = sum(emiNetFlows(cap));
    const cor = sum(emiNetFlows(cap, { corrected: true }));
    const owed =
      financingSummary(cap).balanceAtExit + 5_000_000 + 5_000_000 * 0.18 * (24 / 12);
    expect(rep - cor).toBeCloseTo(owed, 0);
  });
});
