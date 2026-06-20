"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTool } from "@/lib/hooks";
import { usd } from "@/lib/format";
import { Button, Card, cx, Delta, EmptyState, ErrorBanner, inputCls, KpiCard, Loading, Segmented, SkeletonStats } from "@/components/ui";
import { StackedMonthlyBars } from "@/components/charts";
import { DataCard, makeBarCell, numCol, usdFormatter, type ColDef } from "@/components/data-grid";
import { IconSpending } from "@/components/icons";

type AggRow = { month?: string; category?: string; merchant?: string; total: number; transaction_count: number };
type Agg = { rows: AggRow[]; grand_total: number };
type Compare = {
  total_a: number;
  total_b: number;
  delta: number;
  delta_pct: number | null;
  by_category: Array<Record<string, unknown>>;
  by_merchant: Array<Record<string, unknown>>;
};
type TotalRow = { label: string; total: number; transaction_count: number; share: number };

const TOP_SERIES = 8;
const FOLD = "(everything else)";

function isoMonthsAgo(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n, 1);
  return d.toISOString().slice(0, 10);
}

export default function SpendingPage() {
  const router = useRouter();
  const [monthsBack, setMonthsBack] = useState<"3" | "6" | "12">("6");
  const [groupBy, setGroupBy] = useState<"category" | "merchant">("category");
  const [periodA, setPeriodA] = useState("");
  const [periodB, setPeriodB] = useState("");
  const [comparePair, setComparePair] = useState<{ a: string; b: string } | null>(null);

  const start_date = isoMonthsAgo(Number(monthsBack));
  const end_date = new Date().toISOString().slice(0, 10);

  const monthly = useTool<Agg>("aggregate_spending", { start_date, end_date, group_by: "category", monthly: true });
  const totals = useTool<Agg>("aggregate_spending", { start_date, end_date, group_by: groupBy, monthly: false });
  const compare = useTool<Compare>(comparePair ? "compare_periods" : "", comparePair ? { period_a: comparePair.a, period_b: comparePair.b } : {});

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
  const totalRows = useMemo<TotalRow[]>(
    () =>
      (totals.data?.rows ?? [])
        .map((r) => ({
          label: groupBy === "category" ? r.category! : r.merchant!,
          total: r.total,
          transaction_count: r.transaction_count,
          share: grand ? (r.total / grand) * 100 : 0,
        }))
        .sort((a, b) => b.total - a.total),
    [totals.data, groupBy, grand],
  );

  const topRow = totalRows[0];

  const cols = useMemo<ColDef[]>(
    () => [
      { field: "label", headerName: groupBy === "category" ? "Category" : "Merchant", flex: 1.4, minWidth: 180, cellRenderer: (c: { value: string }) => <span className="font-medium capitalize text-txt">{String(c.value).replace(/_/g, " ").toLowerCase()}</span> },
      { field: "share", headerName: "Share", flex: 1, minWidth: 140, sortable: false, filter: false, cellRenderer: makeBarCell("share") },
      { field: "transaction_count", headerName: "Count", ...numCol(), width: 100, valueFormatter: (v) => `${v.value}×` },
      { field: "total", headerName: "Total", ...numCol(), width: 130, valueFormatter: usdFormatter },
      { field: "share", colId: "pct", headerName: "%", ...numCol(), width: 90, valueFormatter: (v) => `${Number(v.value).toFixed(1)}%` },
    ],
    [groupBy],
  );

  function drill(label: string) {
    const key = groupBy === "category" ? "category" : "merchant";
    router.push(`/transactions?${key}=${encodeURIComponent(label)}&start_date=${start_date}`);
  }

  return (
    <div className="space-y-4">
      <ErrorBanner error={monthly.error ?? totals.error} />

      {totals.data ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <KpiCard label={`Total spending · ${monthsBack}mo`} value={usd(grand)} icon={<IconSpending size={15} />} accent />
          <KpiCard label={groupBy === "category" ? "Top category" : "Top merchant"} value={topRow ? <span className="capitalize">{topRow.label.replace(/_/g, " ").toLowerCase()}</span> : "—"} footnote={topRow ? `${usd(topRow.total)} · ${topRow.share.toFixed(0)}%` : undefined} />
          <KpiCard label={groupBy === "category" ? "Categories" : "Merchants"} value={totalRows.length.toLocaleString()} />
        </div>
      ) : (
        <SkeletonStats n={3} />
      )}

      <Card
        title="Monthly by category"
        subtitle="Outflows only — transfers & loan payments excluded. Click a segment to drill in."
        right={
          <Segmented
            value={monthsBack}
            onChange={setMonthsBack}
            options={[
              { value: "3", label: "3M" },
              { value: "6", label: "6M" },
              { value: "12", label: "12M" },
            ]}
          />
        }
      >
        {monthly.data ? (
          chartData.length ? (
            <StackedMonthlyBars data={chartData} series={series} onBarClick={(cat) => cat !== FOLD && drill(cat)} />
          ) : (
            <EmptyState icon={<IconSpending size={20} />} title="No spending in this window" />
          )
        ) : monthly.error ? null : (
          <Loading />
        )}
      </Card>

      {totals.data ? (
        <DataCard<TotalRow>
          title={`Totals by ${groupBy}`}
          icon={<IconSpending size={16} />}
          rowData={totalRows}
          columnDefs={cols}
          getRowId={(p) => p.data.label}
          onRowClicked={(e) => drill(e.data.label)}
          countLabel={groupBy === "category" ? "categories" : "merchants"}
          exportName={`spending-by-${groupBy}`}
          pagination={totalRows.length > 50}
          height={Math.min(560, 110 + totalRows.length * 44)}
          actions={
            <Segmented
              size="sm"
              value={groupBy}
              onChange={setGroupBy}
              options={[
                { value: "category", label: "Category" },
                { value: "merchant", label: "Merchant" },
              ]}
            />
          }
        />
      ) : totals.error ? null : (
        <Loading />
      )}

      <Card
        title="Compare two months"
        right={
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (periodA && periodB) setComparePair({ a: periodA, b: periodB });
            }}
          >
            <input type="month" className={inputCls} value={periodA} onChange={(e) => setPeriodA(e.target.value)} />
            <span className="self-center text-mut">vs</span>
            <input type="month" className={inputCls} value={periodB} onChange={(e) => setPeriodB(e.target.value)} />
            <Button type="submit" size="sm" variant="secondary">
              Compare
            </Button>
          </form>
        }
      >
        {!comparePair ? (
          <div className="text-sm text-mut">Pick two months to diff category- and merchant-level spending.</div>
        ) : compare.data ? (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
              <span className="text-mut">
                {comparePair.a} <b className="nums text-txt">{usd(compare.data.total_a)}</b> → {comparePair.b} <b className="nums text-txt">{usd(compare.data.total_b)}</b>
              </span>
              <Delta value={compare.data.delta} invert />
              {compare.data.delta_pct != null && (
                <span className={cx("nums text-[12px] font-medium", compare.data.delta > 0 ? "text-red" : "text-green")}>
                  {compare.data.delta_pct > 0 ? "+" : ""}
                  {compare.data.delta_pct.toFixed(1)}%
                </span>
              )}
            </div>
            <div className="grid gap-6 md:grid-cols-2">
              {([["By category", compare.data.by_category], ["By merchant", compare.data.by_merchant]] as const).map(([title, rows]) => (
                <div key={title}>
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-mut">{title}</div>
                  <div className="overflow-hidden rounded-[var(--radius)] border border-line">
                    <table className="w-full text-sm">
                      <tbody>
                        {rows.map((r, i) => {
                          const label = String(r.category ?? r.merchant ?? "—");
                          const a = Number(r.a ?? r.total_a ?? 0);
                          const b = Number(r.b ?? r.total_b ?? 0);
                          const delta = Number(r.delta ?? b - a);
                          return (
                            <tr key={i} className="border-t border-line first:border-0">
                              <td className="px-3 py-2 capitalize">{label.replace(/_/g, " ").toLowerCase()}</td>
                              <td className="nums px-3 py-2 text-right text-mut">{usd(a)}</td>
                              <td className="nums px-3 py-2 text-right text-mut">{usd(b)}</td>
                              <td className={`nums px-3 py-2 text-right font-medium ${delta <= 0 ? "text-green" : "text-red"}`}>
                                {delta > 0 ? "+" : ""}
                                {usd(delta)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : compare.error ? (
          <ErrorBanner error={compare.error} />
        ) : (
          <Loading />
        )}
      </Card>
    </div>
  );
}
