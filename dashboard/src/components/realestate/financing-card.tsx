"use client";

// The financing calculator readout: what the loan actually costs and does over
// the build (EMI, net disbursement, interest, balance at exit), plus a rate-
// sensitivity table for floating-rate exposure. Pure presentation over
// ./financing + ./timeline; the faithful KPIs are never touched.

import type { Inputs } from "@/lib/realestate/defaults";
import { financingSummary } from "@/lib/realestate/financing";
import { profitTimeline } from "@/lib/realestate/timeline";
import { irr } from "@/lib/realestate/model";
import { cr, lakh, inr, pct } from "@/lib/realestate/format";
import { Badge, Card, cx } from "@/components/ui";

const annualize = (q: number) => (Number.isNaN(q) ? NaN : Math.pow(1 + q, 4) - 1);

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">{label}</div>
      <div className="nums mt-1 text-[15px] font-semibold tracking-tight text-txt">{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-mut">{sub}</div>}
    </div>
  );
}

export function FinancingCard({ inputs }: { inputs: Inputs }) {
  const s = financingSummary(inputs);
  const emiMode = inputs.repayment === "fullEMI";
  const floating = inputs.rateType === "floating";

  // Sensitivity on the honest (corrected) basis: base / +1% / +2% on the rate.
  const rows = (floating ? [0, 0.01, 0.02] : [0]).map((d) => {
    const i = { ...inputs, loanRate: inputs.loanRate + d };
    const t = profitTimeline(i, { corrected: true });
    return {
      delta: d,
      rate: i.loanRate,
      interest: financingSummary(i).interestOverBuild,
      peak: t.peakCapitalAtRisk,
      exit: t.exitValue,
      irr: annualize(irr(t.flows)),
    };
  });

  return (
    <Card
      title="Financing"
      subtitle={emiMode ? `full-EMI · ${inputs.loanTenureYears}-yr term` : "interest-only carry"}
      right={
        <Badge tone={floating ? "amber" : "neutral"}>
          {floating ? "floating" : "fixed"} · {pct(inputs.loanRate)}
        </Badge>
      }
    >
      <div className="grid grid-cols-2 gap-x-6 gap-y-3.5 sm:grid-cols-3">
        <Stat
          label="Net disbursement"
          value={cr(s.netDisbursement)}
          sub={`after ${lakh(s.processingFee)} fee + ${inr(s.brokenPeriodInterest)} BPI`}
        />
        {emiMode && (
          <Stat label="EMI" value={`${lakh(s.emi)}/mo`} sub={`across the ${inputs.loanMonths}-mo build`} />
        )}
        <Stat label="Interest over build" value={cr(s.interestOverBuild)} sub={`${inputs.loanMonths} months`} />
        {emiMode ? (
          <Stat label="Balance at exit" value={cr(s.balanceAtExit)} sub={`${cr(s.principalPaidDown)} paid down`} />
        ) : (
          <Stat label="Repaid at exit" value={cr(s.balanceAtExit)} sub="full principal (bullet)" />
        )}
        <Stat label="Total financing cost" value={cr(s.totalFinancingCost)} sub="interest + fee + BPI" />
      </div>

      {floating && (
        <div className="mt-4">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">
            Rate sensitivity — floating exposure
          </div>
          <div className="overflow-x-auto rounded-[var(--radius-sm)] border border-line">
            <table className="w-full min-w-[34rem] text-[12.5px]">
              <thead>
                <tr className="bg-surface text-left text-mut">
                  <th className="px-3 py-2 font-medium">Loan rate</th>
                  <th className="px-3 py-2 text-right font-medium">Interest</th>
                  <th className="px-3 py-2 text-right font-medium">Peak at risk</th>
                  <th className="px-3 py-2 text-right font-medium">Exit</th>
                  <th className="px-3 py-2 text-right font-medium">IRR</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.delta}
                    className={cx("border-t border-line", r.delta === 0 && "bg-[var(--accent-soft)]")}
                  >
                    <td className="nums px-3 py-2 text-txt">
                      {pct(r.rate)}
                      {r.delta === 0 ? (
                        <span className="ml-1 text-[10px] text-accent">now</span>
                      ) : (
                        <span className="ml-1 text-[10px] text-faint">+{(r.delta * 100).toFixed(0)}%</span>
                      )}
                    </td>
                    <td className="nums px-3 py-2 text-right text-amber">{cr(r.interest)}</td>
                    <td className="nums px-3 py-2 text-right text-red">−{cr(r.peak)}</td>
                    <td
                      className={cx(
                        "nums px-3 py-2 text-right font-medium",
                        r.exit >= 0 ? "text-green" : "text-red",
                      )}
                    >
                      {cr(r.exit)}
                    </td>
                    <td className="nums px-3 py-2 text-right text-mut">{pct(r.irr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-faint">
            Honest (corrected) basis. A floating rate that drifts up mid-build raises the carry and trims
            the exit — the exposure a flat-rate headline hides.
          </p>
        </div>
      )}
    </Card>
  );
}
