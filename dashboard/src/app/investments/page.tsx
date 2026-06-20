"use client";

import { useMemo, useState } from "react";
import { useSWRConfig } from "swr";
import { useTool } from "@/lib/hooks";
import { callTool } from "@/lib/api";
import { pct, usd } from "@/lib/format";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  KpiCard,
  Loading,
  SkeletonStats,
  Spinner,
} from "@/components/ui";
import { AllocationDonut, DonutLegend } from "@/components/charts";
import {
  ChipCell,
  DataCard,
  DateCell,
  makeGainCell,
  MoneyCell,
  numCol,
  pctFormatter,
  type ColDef,
} from "@/components/data-grid";
import { IconInvestments, IconSparkle, IconSync, IconWallet } from "@/components/icons";

type Position = {
  symbol: string | null;
  name: string | null;
  security_type: string | null;
  quantity: number;
  market_value: number;
  weight_pct: number | null;
  cost_basis: number | null;
  basis_known: boolean;
  unrealized_gain: number | null;
  unrealized_pct: number | null;
  cash_like: boolean;
  accounts: number;
};
type Portfolio = {
  as_of: string | null;
  total_value: number;
  cash_like_value: number;
  invested_value: number;
  positions: Position[];
  allocation_by_type: Record<string, number>;
  concentration: {
    top_position: { symbol: string | null; weight_pct: number | null };
    top5_weight_pct: number;
  } | null;
  basis_coverage_pct: number | null;
  total_unrealized_gain: number | null;
};
type InvTx = {
  date?: string;
  name?: string;
  symbol?: string | null;
  security_name?: string | null;
  type?: string;
  subtype?: string;
  amount?: number;
};
type InvTxs = { investment_transactions: InvTx[]; total_matching?: number };
type ActivityRow = { date: string; symbol: string; description: string; kind: string; amount: number };

export default function InvestmentsPage() {
  const portfolio = useTool<Portfolio>("get_portfolio_analysis");
  const activity = useTool<InvTxs>("list_investment_transactions", { limit: 2000, offset: 0 });
  const { mutate } = useSWRConfig();
  const [refreshing, setRefreshing] = useState(false);

  const p = portfolio.data;
  const gain = p?.total_unrealized_gain;

  async function refreshFromPlaid() {
    setRefreshing(true);
    try {
      await callTool("sync_now");
      await mutate((key) => Array.isArray(key) && key[0] === "tool:list_investment_transactions");
    } finally {
      setRefreshing(false);
    }
  }

  const allocation = useMemo(
    () =>
      p
        ? Object.entries(p.allocation_by_type)
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => b.value - a.value)
        : [],
    [p],
  );

  const activityRows = useMemo<ActivityRow[]>(
    () =>
      (activity.data?.investment_transactions ?? []).map((t) => ({
        date: t.date ?? "",
        symbol: t.symbol ?? "—",
        description: t.name ?? t.security_name ?? "—",
        kind: t.subtype ?? t.type ?? "—",
        amount: t.amount ?? 0,
      })),
    [activity.data],
  );

  const positionCols = useMemo<ColDef[]>(
    () => [
      {
        field: "symbol",
        headerName: "Symbol",
        width: 130,
        pinned: "left",
        cellRenderer: (c: { data: Position }) => (
          <span className="flex items-center gap-2">
            <span className="font-semibold text-txt">{c.data.symbol ?? "?"}</span>
            {c.data.cash_like && <Badge tone="neutral">cash</Badge>}
          </span>
        ),
      },
      { field: "name", headerName: "Name", flex: 2, minWidth: 180 },
      { field: "security_type", headerName: "Type", flex: 1, minWidth: 120, cellRenderer: ChipCell },
      { field: "quantity", headerName: "Qty", ...numCol(), width: 110, valueFormatter: (v) => Number(v.value).toLocaleString(undefined, { maximumFractionDigits: 4 }) },
      { field: "market_value", headerName: "Value", ...numCol(), width: 130, cellRenderer: MoneyCell },
      { field: "weight_pct", headerName: "Weight", ...numCol(), width: 100, valueFormatter: pctFormatter },
      {
        field: "cost_basis",
        headerName: "Basis",
        ...numCol(),
        width: 120,
        valueFormatter: (v) => (v.data.basis_known ? usd(Number(v.value)) : "—"),
      },
      { field: "unrealized_gain", headerName: "Gain", ...numCol(), width: 150, cellRenderer: makeGainCell("unrealized_pct") },
    ],
    [],
  );

  const activityCols = useMemo<ColDef[]>(
    () => [
      { field: "date", headerName: "Date", cellRenderer: DateCell, width: 130, sort: "desc", filter: "agDateColumnFilter" },
      { field: "symbol", headerName: "Symbol", width: 120, cellRenderer: (c: { value: string }) => <span className="font-medium text-txt">{c.value}</span> },
      { field: "description", headerName: "Description", flex: 2, minWidth: 200 },
      { field: "kind", headerName: "Type", flex: 1, minWidth: 120, cellRenderer: ChipCell },
      { field: "amount", headerName: "Amount", ...numCol(), width: 140, cellRenderer: MoneyCell, filter: "agNumberColumnFilter" },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <ErrorBanner error={portfolio.error} />

      {p ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard label="Total value" value={usd(p.total_value)} icon={<IconInvestments size={15} />} accent footnote={p.as_of ? `as of ${p.as_of}` : undefined} />
          <KpiCard label="Invested" value={usd(p.invested_value)} icon={<IconSparkle size={15} />} />
          <KpiCard label="Cash-like" value={usd(p.cash_like_value)} icon={<IconWallet size={15} />} />
          <KpiCard
            label="Unrealized gain"
            value={gain == null ? "—" : <span className={gain >= 0 ? "text-green" : "text-red"}>{gain >= 0 ? "+" : "−"}{usd(Math.abs(gain))}</span>}
            footnote={p.basis_coverage_pct != null && p.basis_coverage_pct < 100 ? `basis: ${p.basis_coverage_pct}% of value` : undefined}
          />
        </div>
      ) : portfolio.error ? null : (
        <SkeletonStats n={4} />
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Allocation by type" className="lg:col-span-2">
          {p ? (
            allocation.length ? (
              <div className="grid items-center gap-4 sm:grid-cols-2">
                <AllocationDonut data={allocation} centerLabel="total" centerValue={usd(p.total_value)} />
                <DonutLegend data={allocation} total={p.total_value} />
              </div>
            ) : (
              <EmptyState icon={<IconInvestments size={20} />} title="No holdings snapshots yet" description="Run a sync to pull your positions from Plaid." />
            )
          ) : portfolio.error ? null : (
            <Loading />
          )}
        </Card>

        <Card title="Concentration">
          {p?.concentration ? (
            <div className="space-y-4">
              <div>
                <div className="text-[11px] uppercase tracking-[0.08em] text-mut">Top position</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-2xl font-semibold tracking-tight text-txt">{p.concentration.top_position.symbol ?? "?"}</span>
                  <span className="nums text-sm text-mut">{pct(p.concentration.top_position.weight_pct)} of portfolio</span>
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-[0.08em] text-mut">Top 5 positions</div>
                <div className="nums mt-1 text-2xl font-semibold tracking-tight text-txt">{pct(p.concentration.top5_weight_pct)}</div>
              </div>
              {p.concentration.top5_weight_pct > 60 && (
                <Badge tone="amber" dot>
                  Concentrated — top 5 hold most of the book
                </Badge>
              )}
            </div>
          ) : (
            <div className="text-sm text-mut">—</div>
          )}
        </Card>
      </div>

      {p ? (
        <DataCard<Position>
          title="Positions"
          icon={<IconInvestments size={16} />}
          rowData={p.positions}
          columnDefs={positionCols}
          countLabel="positions"
          exportName="positions"
          pagination={false}
          height={Math.min(520, 120 + p.positions.length * 44)}
        />
      ) : portfolio.error ? null : (
        <Loading />
      )}

      <DataCard<ActivityRow>
        title="Investment activity"
        subtitle="Trades, dividends & fees from your synced history — instant, no Plaid call"
        icon={<IconSync size={16} />}
        rowData={activityRows}
        columnDefs={activityCols}
        countLabel="transactions"
        exportName="investment-activity"
        height="calc(100vh - 280px)"
        actions={
          <Button variant="secondary" size="sm" disabled={refreshing} onClick={refreshFromPlaid} icon={refreshing ? <Spinner size={14} /> : <IconSync size={14} />}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />
    </div>
  );
}
