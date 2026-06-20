"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { useTool } from "@/lib/hooks";
import { usd } from "@/lib/format";
import { Badge, Card, EmptyState, ErrorBanner, KpiCard, Loading, SkeletonStats } from "@/components/ui";
import { IncomeExpenseBars } from "@/components/charts";
import { ChipCell, DataCard, DateCell, numCol, usdFormatter, type ColDef } from "@/components/data-grid";
import { IconArrowDownRight, IconArrowUpRight, IconSync } from "@/components/icons";

type Income = {
  months: Array<{ month: string; partial: boolean; income: number; expenses: number; net: number; inflows_total: number; by_bucket: Record<string, number> }>;
  estimated_monthly_income: number;
  avg_monthly_expenses: number;
  savings_rate: number | null;
  by_bucket: Record<string, number>;
  top_sources: Array<{ source: string; bucket: string; total: number; count: number }>;
  caveats: string[];
};
type Stream = {
  merchant: string;
  category: string | null;
  cadence: string;
  occurrences: number;
  first_date: string;
  last_date: string;
  next_expected_date: string;
  latest_amount: number;
  median_amount: number;
  is_fixed_amount: boolean;
  price_change: { pct: number; from: number; to: number } | null;
  annualized_cost: number;
  monthly_equivalent: number;
};
type Recurring = {
  streams: Stream[];
  monthly_recurring_total: number;
  annual_recurring_total: number;
  price_increases: string[];
};

function BarList({ items, max }: { items: Array<{ label: string; sub?: string; value: number }>; max: number }) {
  return (
    <div className="space-y-2.5">
      {items.map((it) => (
        <div key={it.label}>
          <div className="flex items-center justify-between gap-3 text-[13px]">
            <span className="truncate text-txt">
              {it.label} {it.sub && <span className="text-faint">· {it.sub}</span>}
            </span>
            <span className="nums shrink-0 font-medium text-txt">{usd(it.value)}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-accent" style={{ width: `${max ? (it.value / max) * 100 : 0}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function CashFlowPage() {
  const router = useRouter();
  const income = useTool<Income>("get_income_analysis", { months: 6 });
  const recurring = useTool<Recurring>("get_recurring_analysis", { months: 6 });

  const inc = income.data;
  const rec = recurring.data;

  const cols = useMemo<ColDef[]>(
    () => [
      {
        field: "merchant",
        headerName: "Merchant",
        flex: 2,
        minWidth: 200,
        pinned: "left",
        cellRenderer: (c: { data: Stream }) => (
          <span className="flex items-center gap-2">
            <span className="font-medium text-txt">{c.data.merchant}</span>
            {!c.data.is_fixed_amount && <Badge tone="neutral">variable</Badge>}
          </span>
        ),
      },
      { field: "cadence", headerName: "Cadence", flex: 1, minWidth: 110, cellRenderer: ChipCell },
      { field: "latest_amount", headerName: "Latest", ...numCol(), width: 120, valueFormatter: usdFormatter },
      { field: "next_expected_date", headerName: "Next", width: 130, cellRenderer: DateCell, filter: "agDateColumnFilter" },
      { field: "monthly_equivalent", headerName: "Monthly", ...numCol(), width: 120, valueFormatter: usdFormatter },
      { field: "annualized_cost", headerName: "Annualized", ...numCol(), width: 130, valueFormatter: usdFormatter },
      {
        field: "price_change",
        headerName: "Price change",
        width: 170,
        sortable: false,
        filter: false,
        cellDataType: false,
        cellRenderer: (c: { data: Stream }) => {
          const pc = c.data.price_change;
          if (!pc) return <span className="text-faint">—</span>;
          return (
            <Badge tone={pc.pct > 0 ? "red" : "green"}>
              {pc.pct > 0 ? "+" : ""}
              {pc.pct}% · {usd(pc.from)}→{usd(pc.to)}
            </Badge>
          );
        },
      },
    ],
    [],
  );

  const topSources = (inc?.top_sources ?? []).map((s) => ({ label: s.source, sub: `${s.bucket} · ${s.count}×`, value: s.total }));
  const buckets = Object.entries(inc?.by_bucket ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label, value }));

  return (
    <div className="space-y-4">
      <ErrorBanner error={income.error ?? recurring.error} />

      {inc ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard label="Est. monthly income" value={usd(inc.estimated_monthly_income)} icon={<IconArrowDownRight size={15} />} footnote="completed months" accent />
          <KpiCard label="Avg monthly expenses" value={usd(inc.avg_monthly_expenses)} icon={<IconArrowUpRight size={15} />} />
          <KpiCard
            label="Savings rate"
            value={inc.savings_rate == null ? "—" : <span className={inc.savings_rate >= 0 ? "text-green" : "text-red"}>{(inc.savings_rate * 100).toFixed(1)}%</span>}
          />
          <KpiCard label="Recurring / mo" value={usd(rec?.monthly_recurring_total)} icon={<IconSync size={15} />} footnote={rec ? `${usd(rec.annual_recurring_total)}/yr` : undefined} />
        </div>
      ) : income.error ? null : (
        <SkeletonStats n={4} />
      )}

      <Card title="Income vs expenses" subtitle="last 6 months">
        {inc ? (
          <>
            <IncomeExpenseBars data={inc.months} />
            {inc.months.some((m) => m.partial) && <div className="mt-1 text-xs text-faint">Current month is partial.</div>}
          </>
        ) : income.error ? null : (
          <Loading />
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Top income sources">
          {inc ? (
            topSources.length ? (
              <BarList items={topSources} max={Math.max(...topSources.map((s) => s.value), 1)} />
            ) : (
              <EmptyState title="No income detected" />
            )
          ) : (
            <Loading />
          )}
          {inc?.caveats.map((c, i) => (
            <p key={i} className="mt-3 text-xs text-faint">
              ※ {c}
            </p>
          ))}
        </Card>
        <Card title="Inflows by bucket" subtitle="window total">
          {inc ? <BarList items={buckets} max={Math.max(...buckets.map((b) => b.value), 1)} /> : <Loading />}
        </Card>
      </div>

      {rec ? (
        rec.streams.length ? (
          <DataCard<Stream>
            title="Recurring streams"
            subtitle={`${usd(rec.monthly_recurring_total)}/mo · ${usd(rec.annual_recurring_total)}/yr · click a row to see transactions`}
            icon={<IconSync size={16} />}
            rowData={rec.streams}
            columnDefs={cols}
            getRowId={(p) => p.data.merchant}
            onRowClicked={(e) => router.push(`/transactions?merchant=${encodeURIComponent(e.data.merchant)}`)}
            countLabel="streams"
            exportName="recurring"
            pagination={false}
            height={Math.min(560, 120 + rec.streams.length * 44)}
          />
        ) : (
          <Card>
            <EmptyState icon={<IconSync size={20} />} title="No recurring streams detected yet" description="As more history syncs, subscriptions and bills will surface here." />
          </Card>
        )
      ) : recurring.error ? null : (
        <Loading />
      )}
    </div>
  );
}
