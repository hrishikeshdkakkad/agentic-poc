"use client";

import Link from "next/link";
import { useTool } from "@/lib/hooks";
import { fmtDate, usd } from "@/lib/format";
import { Card, ErrorBanner, Loading, Stat } from "@/components/ui";
import { IncomeExpenseBars } from "@/components/charts";

type Income = {
  months: Array<{ month: string; partial: boolean; income: number; expenses: number; net: number;
    inflows_total: number; by_bucket: Record<string, number> }>;
  estimated_monthly_income: number;
  avg_monthly_expenses: number;
  savings_rate: number | null;
  by_bucket: Record<string, number>;
  top_sources: Array<{ source: string; bucket: string; total: number; count: number }>;
  caveats: string[];
};
type Recurring = {
  streams: Array<{
    merchant: string; category: string | null; cadence: string; occurrences: number;
    first_date: string; last_date: string; next_expected_date: string;
    latest_amount: number; median_amount: number; is_fixed_amount: boolean;
    price_change: { pct: number; from: number; to: number } | null;
    annualized_cost: number; monthly_equivalent: number;
  }>;
  monthly_recurring_total: number;
  annual_recurring_total: number;
  price_increases: string[];
};

export default function CashFlowPage() {
  const income = useTool<Income>("get_income_analysis", { months: 6 });
  const recurring = useTool<Recurring>("get_recurring_analysis", { months: 6 });

  const inc = income.data;
  const rec = recurring.data;

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-1 text-xl font-bold">Cash flow</h1>
      <p className="mb-6 text-sm text-mut">Income vs expenses, and everything that bills you on a schedule.</p>
      <ErrorBanner error={income.error ?? recurring.error} />

      <div className="mb-4 grid gap-4 md:grid-cols-3">
        <Card><Stat label="Est. monthly income" value={usd(inc?.estimated_monthly_income)}
          sub="completed months only" /></Card>
        <Card><Stat label="Avg monthly expenses" value={usd(inc?.avg_monthly_expenses)} /></Card>
        <Card><Stat label="Savings rate"
          value={inc?.savings_rate == null ? "—" : (
            <span className={inc.savings_rate >= 0 ? "text-green" : "text-red"}>
              {(inc.savings_rate * 100).toFixed(1)}%
            </span>
          )} /></Card>
      </div>

      <Card title="Income vs expenses by month">
        {inc ? (
          <>
            <IncomeExpenseBars data={inc.months} />
            {inc.months.some((m) => m.partial) && (
              <div className="mt-1 text-xs text-mut">current month is partial</div>
            )}
          </>
        ) : income.error ? null : <Loading />}
      </Card>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Card title="Top income sources">
          {inc ? (
            <table className="w-full text-sm">
              <tbody>
                {inc.top_sources.map((s) => (
                  <tr key={s.source} className="border-t border-line first:border-0">
                    <td className="py-1.5">{s.source}</td>
                    <td className="py-1.5 text-mut">{s.bucket}</td>
                    <td className="py-1.5 text-right text-mut">{s.count}×</td>
                    <td className="py-1.5 text-right font-medium">{usd(s.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : income.error ? null : <Loading />}
          {inc?.caveats.map((c, i) => (
            <p key={i} className="mt-2 text-xs text-mut">※ {c}</p>
          ))}
        </Card>
        <Card title="Inflows by bucket (window total)">
          {inc ? (
            <table className="w-full text-sm">
              <tbody>
                {Object.entries(inc.by_bucket).sort((a, b) => b[1] - a[1]).map(([bucket, total]) => (
                  <tr key={bucket} className="border-t border-line first:border-0">
                    <td className="py-1.5">{bucket}</td>
                    <td className="py-1.5 text-right font-medium">{usd(total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : income.error ? null : <Loading />}
        </Card>
      </div>

      <Card className="mt-4"
        title={`Recurring (${usd(rec?.monthly_recurring_total)}/mo · ${usd(rec?.annual_recurring_total)}/yr)`}>
        {rec ? (
          rec.streams.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-mut">
                  <th className="py-2">Merchant</th><th>Cadence</th>
                  <th className="text-right">Latest</th><th>Next expected</th>
                  <th className="text-right">Annualized</th><th>Price change</th>
                </tr>
              </thead>
              <tbody>
                {rec.streams.map((s) => (
                  <tr key={s.merchant} className="border-t border-line">
                    <td className="py-2">
                      <Link className="hover:text-accent" href={`/transactions?merchant=${encodeURIComponent(s.merchant)}`}>
                        {s.merchant}
                      </Link>
                      {!s.is_fixed_amount && <span className="ml-1.5 text-[10px] text-mut">variable</span>}
                      <div className="text-xs text-mut">{s.category ?? ""} · {s.occurrences}× since {fmtDate(s.first_date)}</div>
                    </td>
                    <td className="py-2 text-mut">{s.cadence}</td>
                    <td className="py-2 text-right">{usd(s.latest_amount)}</td>
                    <td className="py-2 text-mut">{fmtDate(s.next_expected_date)}</td>
                    <td className="py-2 text-right">{usd(s.annualized_cost)}</td>
                    <td className="py-2">
                      {s.price_change ? (
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${s.price_change.pct > 0 ? "bg-red/15 text-red" : "bg-green/15 text-green"}`}>
                          {s.price_change.pct > 0 ? "+" : ""}{s.price_change.pct}% ({usd(s.price_change.from)} → {usd(s.price_change.to)})
                        </span>
                      ) : <span className="text-mut">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="text-mut">No recurring streams detected yet.</div>
        ) : recurring.error ? null : <Loading />}
      </Card>
    </div>
  );
}
