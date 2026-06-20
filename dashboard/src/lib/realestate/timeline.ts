// Cumulative "profit over time" series for the J-curve chart. Pure, and derived
// entirely from the existing engine (netFlows / correctedNetFlows) so it can
// never drift from the headline numbers. It adds ONE thing the faithful engine
// lumps into a single charge: the loan interest, distributed across the quarters
// the loan is actually outstanding.

import { Inputs, CF_MONTHS } from "./defaults";
import { netFlows, interestCarry } from "./model";
import { correctedNetFlows } from "./reality";
import { emiNetFlows, emiCumInterest } from "./financing";

export type TimelineSeries = {
  months: number[]; // CF_MONTHS
  flows: number[]; // per-quarter net cash (reported or corrected)
  cumCash: number[]; // running cumulative position — the J-curve
  periodInterest: number[]; // loan interest accrued each quarter
  cumInterest: number[]; // running cumulative interest paid
  troughIndex: number; // quarter of peak capital at risk (min cumCash)
  peakCapitalAtRisk: number; // ₹ at the trough (positive); 0 if never negative
  breakevenMonth: number | null; // interpolated month cumCash first turns >= 0
  exitValue: number; // cumulative position at exit
  totalInterest: number; // cumulative interest at exit
};

function runningSum(xs: number[]): number[] {
  let acc = 0;
  return xs.map((x) => (acc += x));
}

export function profitTimeline(i: Inputs, opts: { corrected?: boolean } = {}): TimelineSeries {
  // Interest-only (the faithful source model) vs full-EMI (the realistic
  // financing layer in ./financing). EMI mode uses the amortization schedule;
  // interest-only distributes the carry across the quarters the loan is
  // outstanding (sums to interestCarry for the default 24-month deal).
  const emiMode = i.repayment === "fullEMI";

  const flows = emiMode
    ? emiNetFlows(i, opts)
    : opts.corrected
      ? correctedNetFlows(i, i.baseSaleRate)
      : netFlows(i, i.baseSaleRate);

  // Interest-only: distribute the model's full bullet carry across the quarters the
  // loan is outstanding, so the line ALWAYS sums to interestCarry(i) — even when
  // loanMonths > 24, where the old per-month accrual silently topped out at the
  // 24-month horizon while the J-curve charged the full carry.
  const cumInterest = emiMode
    ? emiCumInterest(i)
    : (() => {
        const monthsByStep = CF_MONTHS.map((m, idx) => {
          if (idx === 0) return 0;
          const prev = Math.min(CF_MONTHS[idx - 1], i.loanMonths);
          const cur = Math.min(m, i.loanMonths);
          return Math.max(0, cur - prev);
        });
        const totalMonths = monthsByStep.reduce((s, x) => s + x, 0) || 1;
        const carry = interestCarry(i);
        return runningSum(monthsByStep.map((months) => (months / totalMonths) * carry));
      })();

  const periodInterest = cumInterest.map((v, idx) => (idx ? v - cumInterest[idx - 1] : v));
  const cumCash = runningSum(flows);

  let troughIndex = 0;
  cumCash.forEach((v, idx) => {
    if (v < cumCash[troughIndex]) troughIndex = idx;
  });

  // DURABLE break-even: the month the position turns positive AND stays positive
  // through exit — anchored on the LAST quarter it was underwater. A deal that
  // momentarily surfaces (e.g. an early sale tranche) and then sinks back below
  // zero by exit never truly broke even, so we report none when exitValue < 0.
  // For the common single-crossing deal this equals the first upward crossing.
  const exitValue = cumCash[cumCash.length - 1];
  let breakevenMonth: number | null = null;
  if (exitValue >= 0) {
    let lastNeg = -1;
    for (let idx = 0; idx < cumCash.length; idx++) if (cumCash[idx] < 0) lastNeg = idx;
    if (lastNeg >= 0 && lastNeg < cumCash.length - 1) {
      const f0 = cumCash[lastNeg];
      const f1 = cumCash[lastNeg + 1];
      const frac = (0 - f0) / (f1 - f0);
      breakevenMonth = CF_MONTHS[lastNeg] + frac * (CF_MONTHS[lastNeg + 1] - CF_MONTHS[lastNeg]);
    }
  }

  return {
    months: CF_MONTHS,
    flows,
    cumCash,
    periodInterest,
    cumInterest,
    troughIndex,
    peakCapitalAtRisk: cumCash[troughIndex] < 0 ? -cumCash[troughIndex] : 0,
    breakevenMonth,
    exitValue,
    totalInterest: cumInterest[cumInterest.length - 1],
  };
}
