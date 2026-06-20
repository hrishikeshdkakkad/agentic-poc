// Realistic financing layer that sits BESIDE the faithful engine (model.ts is
// never touched, so the parity-locked headline numbers can't move). It models
// what a real plot loan actually does: a lump-sum disbursement net of fee +
// broken-period interest, amortizing EMIs during the build, and the principal
// still owed at exit. Everything here is pure and opt-in (only used when
// inputs.repayment === "fullEMI" or for the rate-sensitivity scenarios).

import { Inputs, CF_MONTHS } from "./defaults";
import { netFlows, interestCarry } from "./model";

const monthlyRate = (annual: number) => annual / 12;
const tenureMonths = (i: Inputs) => Math.max(1, Math.round(i.loanTenureYears * 12));
const EXIT = CF_MONTHS[CF_MONTHS.length - 1];

/** Standard amortizing EMI. Falls back to straight-line when the rate is 0. */
export function monthlyEMI(principal: number, annualRate: number, months: number): number {
  if (months <= 0) return principal;
  const r = monthlyRate(annualRate);
  if (r === 0) return principal / months;
  const f = Math.pow(1 + r, months);
  return (principal * r * f) / (f - 1);
}

/** Run the amortization forward `monthsPaid` months; report what's been paid + the balance. */
export function amortizeThrough(
  principal: number,
  annualRate: number,
  months: number,
  monthsPaid: number,
): { interestPaid: number; principalPaid: number; balance: number; emi: number } {
  const emi = monthlyEMI(principal, annualRate, months);
  const r = monthlyRate(annualRate);
  let balance = principal;
  let interestPaid = 0;
  let principalPaid = 0;
  for (let m = 0; m < Math.min(monthsPaid, months); m++) {
    const interest = balance * r;
    const principalPart = Math.min(emi - interest, balance);
    balance -= principalPart;
    interestPaid += interest;
    principalPaid += principalPart;
  }
  return { interestPaid, principalPaid, balance, emi };
}

export const processingFee = (i: Inputs) => i.loanAmount * i.processingFeePct;
export const brokenPeriodInterest = (i: Inputs) => (i.loanAmount * i.loanRate * i.bpiDays) / 365;
/** What actually hits your account at M0 — the "cut and give" the user remembered. */
export const netDisbursement = (i: Inputs) =>
  i.loanAmount - processingFee(i) - brokenPeriodInterest(i);

export type FinancingSummary = {
  emi: number; // monthly EMI (0 in interest-only mode)
  netDisbursement: number; // cash received at M0 (loan − fee − BPI)
  processingFee: number;
  brokenPeriodInterest: number;
  interestOverBuild: number; // interest paid across the build window
  principalPaidDown: number; // principal repaid via EMIs during the build
  balanceAtExit: number; // loan principal still owed at exit
  emisPaid: number; // total EMI cash out during the build
  totalFinancingCost: number; // interest over build + fee + BPI
};

export function financingSummary(i: Inputs): FinancingSummary {
  const fee = processingFee(i);
  const bpi = brokenPeriodInterest(i);
  const base = {
    netDisbursement: netDisbursement(i),
    processingFee: fee,
    brokenPeriodInterest: bpi,
  };

  if (i.repayment === "interestOnly") {
    const interest = interestCarry(i); // bullet: full principal owed until exit
    return {
      ...base,
      emi: 0,
      interestOverBuild: interest,
      principalPaidDown: 0,
      balanceAtExit: i.loanAmount,
      emisPaid: 0,
      totalFinancingCost: interest + fee + bpi,
    };
  }

  // Months actually paid by exit can't exceed the M24 horizon — the project exits
  // at EXIT and repays the balance still owed. Capping here keeps interestOverBuild,
  // balanceAtExit and emisPaid on the SAME basis as emiNetFlows()/the corrected IRR;
  // using the uncapped loanMonths made the honest profit and the IRR disagree for
  // any loanMonths > 24. The default (24) is unaffected (min(24, 24) = 24).
  const monthsPaid = Math.min(i.loanMonths, EXIT);
  const a = amortizeThrough(i.loanAmount, i.loanRate, tenureMonths(i), monthsPaid);
  return {
    ...base,
    emi: a.emi,
    interestOverBuild: a.interestPaid,
    principalPaidDown: a.principalPaid,
    balanceAtExit: a.balance,
    emisPaid: a.emi * monthsPaid,
    totalFinancingCost: a.interestPaid + fee + bpi,
  };
}

// ---- EMI-mode cash flows for the J-curve ----

/** The faithful levered flows with the loan inflow and the lumped interest-only
 * carry stripped out — leaving pure operating flows (land, draws, sales,
 * investor tranches) to re-clothe with whatever financing we want. Sale rate is
 * parameterized so the bear/bull net scenarios can re-clothe their own flows. */
function operatingFlows(i: Inputs, saleRate: number = i.baseSaleRate): number[] {
  const base = netFlows(i, saleRate);
  const carry = interestCarry(i);
  return CF_MONTHS.map((m, idx) => {
    let cf = base[idx];
    if (m === 0) cf -= i.loanAmount; // strip the M0 loan inflow
    if (m === 21) cf += carry; // strip the lumped −carry
    return cf;
  });
}

/** Full-EMI levered flows: net disbursement at M0, an EMI drag while the loan is
 * outstanding, and (when corrected) the principal still owed repaid at exit.
 *
 * The EMI drag is prorated per quarter and capped at `loanMonths` (and never
 * beyond the M24 exit), so the EMIs paid + the balance repaid at exit retire the
 * principal EXACTLY ONCE. Hardcoding 24 EMIs regardless of `loanMonths` while
 * repaying the `loanMonths` balance double-counted the paydown for any deal with
 * `loanMonths ≠ 24` — the default (24) is unaffected. */
export function emiNetFlows(
  i: Inputs,
  opts: { corrected?: boolean; saleRate?: number } = {},
): number[] {
  const op = operatingFlows(i, opts.saleRate);
  const net = netDisbursement(i);
  const emi = monthlyEMI(i.loanAmount, i.loanRate, tenureMonths(i));
  // Months actually paid by exit: can't exceed the loan's outstanding window nor
  // the 24-month horizon. The balloon repaid at exit is the balance at that point.
  const monthsPaid = Math.min(i.loanMonths, EXIT);
  const balance = amortizeThrough(i.loanAmount, i.loanRate, tenureMonths(i), monthsPaid).balance;

  return CF_MONTHS.map((m, idx) => {
    let cf = op[idx];
    if (m === 0) cf += net; // disbursement, net of fee + BPI
    // EMI-months falling in this quarter, capped at loanMonths — three per quarter
    // until the loan is repaid, then zero.
    const emisThisStep =
      Math.min(m, i.loanMonths) - Math.min(CF_MONTHS[idx - 1] ?? 0, i.loanMonths);
    if (emisThisStep > 0) cf -= emisThisStep * emi;
    if (m === EXIT && opts.corrected) cf -= balance; // repay what's still owed
    return cf;
  });
}

/** Cumulative interest paid through each CF step in full-EMI mode (from the schedule). */
export function emiCumInterest(i: Inputs): number[] {
  return CF_MONTHS.map(
    (m) =>
      amortizeThrough(i.loanAmount, i.loanRate, tenureMonths(i), Math.min(m, i.loanMonths))
        .interestPaid,
  );
}
