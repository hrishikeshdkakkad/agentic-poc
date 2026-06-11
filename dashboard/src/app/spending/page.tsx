"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTool } from "@/lib/hooks";
import { usd } from "@/lib/format";
import { Card, ErrorBanner, Loading } from "@/components/ui";
import { StackedMonthlyBars } from "@/components/charts";

type AggRow = { month?: string; category?: string; merchant?: string; total: number; transaction_count: number };
type Agg = { rows: AggRow[]; grand_total: number };
type Compare = {
  total_a: number; total_b: number; delta: number; delta_pct: number | null;
  by_category: Array<Record<string, unknown>>;
  by_merchant: Array<Record<string, unknown>>;
};

const TOP_SERIES = 8;

function isoDaysAgoMonths(monthsBack: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - monthsBack, 1);
  return d.toISOString().slice(0, 10);
}

export default function SpendingPage() {
  const router = useRouter();
  const [monthsBack, setMonthsBack] = useState(6);
  const [groupBy, setGroupBy] = useState<"category" | "merchant">("category");
  const [periodA, setPeriodA] = useState("");
  const [periodB, setPeriodB] = useState("");
  const [comparePair, setComparePair] = useState<{ a: string; b: string } | null>(null);

  const start_date = isoDaysAgoMonths(monthsBack);
  const end_date = new Date().toISOString().slice(0, 10);

  const monthly = useTool<Agg>("aggregate_spending",
    { start_date, end_date, group_by: "category", monthly: true });
  const totals = useTool<Agg>("aggregate_spending",
    { start_date, end_date, group_by: groupBy, monthly: false });
  const compare = useTool<Compare>(comparePair ? "compare_periods" : "",
    comparePair ? { period_a: comparePair.a, period_b: comparePair.b } : {});

  // Pivot monthly category rows into one object per month, keeping the top
  // categories as series and folding the tail into one bucket. The bucket name
  // must not collide with a real category (Plaid has a literal "OTHER").
  const FOLD = "(everything else)";
  const { chartData, series } = useMemo(() => {
    const rows = monthly.data?.rows ?? [];
    const catTotals = new Map<string, number>();
    for (const r of rows) catTotals.set(r.category!, (catTotals.get(r.category!) ?? 0) + r.total);
    const top = [...catTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_SERIES).map(([c]) => c);
    const topSet = new Set(top);
    const byMonth = new Map<string, Record<string, number | string>>();
    for (const r of rows) {
      const m = byMonth.get(r.month!) ?? { month: r.month! };
      const key = topSet.has(r.category!) ? r.category! : FOLD;
      m[key] = ((m[key] as number) ?? 0) + r.total;
      byMonth.set(r.month!, m);
    }
    const hasFold = rows.some((r) => !topSet.has(r.category!));
    return {
      chartData: [...byMonth.values()].sort((a, b) => String(a.month).localeCompare(String(b.month))),
      series: hasFold ? [...top, FOLD] : top,
    };
  }, [monthly.data]);

  const grand = totals.data?.grand_total ?? 0;
  const btn = (active: boolean) =>
    `rounded-lg px-3 py-1.5 text-sm font-semibold ${active ? "bg-accent text-white" : "border border-line"}`;

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-1 text-xl font-bold">Spending</h1>
      <p className="mb-6 text-sm text-mut">
        Outflows only — transfers and loan payments excluded. Click a bar segment or row to see the transactions behind it.
      </p>
      <ErrorBanner error={monthly.error ?? totals.error} />

      <Card title={`Monthly by category (${monthsBack} mo · total ${usd(monthly.data?.grand_total)})`}
        right={
          <span className="flex gap-2">
            {[3, 6, 12].map((m) => (
              <button key={m} className={btn(monthsBack === m)} onClick={() => setMonthsBack(m)}>{m}m</button>
            ))}
          </span>
        }>
        {monthly.data ? (
          chartData.length
            ? <StackedMonthlyBars data={chartData} series={series}
                onBarClick={(cat) => cat !== FOLD &&
                  router.push(`/transactions?category=${encodeURIComponent(cat)}&start_date=${start_date}`)} />
            : <div className="text-mut">No spending in this window.</div>
        ) : monthly.error ? null : <Loading />}
      </Card>

      <Card className="mt-4"
        title={`Totals by ${groupBy}`}
        right={
          <span className="flex gap-2">
            <button className={btn(groupBy === "category")} onClick={() => setGroupBy("category")}>Category</button>
            <button className={btn(groupBy === "merchant")} onClick={() => setGroupBy("merchant")}>Merchant</button>
          </span>
        }>
        {totals.data ? (
          <table className="w-full text-sm">
            <tbody>
              {totals.data.rows.slice().sort((a, b) => b.total - a.total).map((r) => {
                const label = groupBy === "category" ? r.category! : r.merchant!;
                const share = grand ? (r.total / grand) * 100 : 0;
                const href = groupBy === "category"
                  ? `/transactions?category=${encodeURIComponent(label)}&start_date=${start_date}`
                  : `/transactions?merchant=${encodeURIComponent(label)}&start_date=${start_date}`;
                return (
                  <tr key={label} className="cursor-pointer border-t border-line hover:bg-bg/50"
                    onClick={() => router.push(href)}>
                    <td className="py-2">{label}</td>
                    <td className="w-1/3 py-2">
                      <div className="h-2 overflow-hidden rounded-full bg-line">
                        <div className="h-full bg-accent" style={{ width: `${share}%` }} />
                      </div>
                    </td>
                    <td className="py-2 text-right text-mut">{r.transaction_count}×</td>
                    <td className="py-2 text-right font-medium">{usd(r.total)}</td>
                    <td className="py-2 text-right text-mut">{share.toFixed(1)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : totals.error ? null : <Loading />}
      </Card>

      <Card className="mt-4" title="Compare two months"
        right={
          <form className="flex gap-2"
            onSubmit={(e) => { e.preventDefault(); if (periodA && periodB) setComparePair({ a: periodA, b: periodB }); }}>
            <input type="month" className="rounded-md border border-line bg-bg px-2 py-1 text-sm"
              value={periodA} onChange={(e) => setPeriodA(e.target.value)} />
            <span className="self-center text-mut">vs</span>
            <input type="month" className="rounded-md border border-line bg-bg px-2 py-1 text-sm"
              value={periodB} onChange={(e) => setPeriodB(e.target.value)} />
            <button className="rounded-lg border border-line px-3 py-1 text-sm font-semibold">Compare</button>
          </form>
        }>
        {!comparePair ? (
          <div className="text-sm text-mut">Pick two months to diff category- and merchant-level spending.</div>
        ) : compare.data ? (
          <>
            <div className="mb-3 text-sm">
              {comparePair.a}: <b>{usd(compare.data.total_a)}</b> → {comparePair.b}: <b>{usd(compare.data.total_b)}</b>{" "}
              <span className={compare.data.delta <= 0 ? "text-green" : "text-red"}>
                ({compare.data.delta > 0 ? "+" : ""}{usd(compare.data.delta)}
                {compare.data.delta_pct != null ? `, ${compare.data.delta_pct > 0 ? "+" : ""}${compare.data.delta_pct}%` : ""})
              </span>
            </div>
            <div className="grid gap-6 md:grid-cols-2">
              {([["by_category", compare.data.by_category], ["by_merchant", compare.data.by_merchant]] as const)
                .map(([title, rows]) => (
                  <div key={title}>
                    <div className="mb-1 text-xs uppercase tracking-wide text-mut">{title.replace("by_", "by ")}</div>
                    <table className="w-full text-sm">
                      <tbody>
                        {rows.map((r, i) => {
                          const label = String(r.category ?? r.merchant ?? "—");
                          const a = Number(r.a ?? r.total_a ?? 0), b = Number(r.b ?? r.total_b ?? 0);
                          const delta = Number(r.delta ?? b - a);
                          return (
                            <tr key={i} className="border-t border-line">
                              <td className="py-1.5">{label}</td>
                              <td className="py-1.5 text-right text-mut">{usd(a)}</td>
                              <td className="py-1.5 text-right text-mut">{usd(b)}</td>
                              <td className={`py-1.5 text-right ${delta <= 0 ? "text-green" : "text-red"}`}>
                                {delta > 0 ? "+" : ""}{usd(delta)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ))}
            </div>
          </>
        ) : compare.error ? <ErrorBanner error={compare.error} /> : <Loading />}
      </Card>
    </div>
  );
}
