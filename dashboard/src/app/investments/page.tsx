"use client";

import { useState } from "react";
import { useTool } from "@/lib/hooks";
import { fmtDate, pct, usd } from "@/lib/format";
import { Card, ErrorBanner, Loading, Stat, WarningsBanner, Warning } from "@/components/ui";
import { AllocationDonut } from "@/components/charts";

type Portfolio = {
  as_of: string | null;
  total_value: number;
  cash_like_value: number;
  invested_value: number;
  positions: Array<{
    symbol: string | null; name: string | null; security_type: string | null;
    quantity: number; market_value: number; weight_pct: number | null;
    cost_basis: number | null; basis_known: boolean;
    unrealized_gain: number | null; unrealized_pct: number | null;
    cash_like: boolean; accounts: number;
  }>;
  allocation_by_type: Record<string, number>;
  concentration: { top_position: { symbol: string | null; weight_pct: number | null }; top5_weight_pct: number } | null;
  basis_coverage_pct: number | null;
  total_unrealized_gain: number | null;
};
type InvTxs = {
  investment_transactions: Array<{
    date?: string; name?: string; type?: string; subtype?: string;
    amount?: number; quantity?: number; price?: number; symbol?: string | null;
    institution?: string;
  }>;
  warnings?: Warning[];
};

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
}

export default function InvestmentsPage() {
  const portfolio = useTool<Portfolio>("get_portfolio_analysis");
  const [showActivity, setShowActivity] = useState(false);
  // Live Plaid call — only fire after the user asks for it.
  const activity = useTool<InvTxs>(showActivity ? "get_investment_transactions" : "",
    showActivity ? { start_date: daysAgoIso(90), end_date: daysAgoIso(0) } : {});

  const p = portfolio.data;
  const gain = p?.total_unrealized_gain;

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-1 text-xl font-bold">Investments</h1>
      <p className="mb-6 text-sm text-mut">
        Positions at the latest holdings snapshot{p?.as_of ? ` (${p.as_of})` : ""}.
      </p>
      <ErrorBanner error={portfolio.error} />

      <div className="mb-4 grid gap-4 md:grid-cols-4">
        <Card><Stat label="Total value" value={usd(p?.total_value)} /></Card>
        <Card><Stat label="Invested" value={usd(p?.invested_value)} /></Card>
        <Card><Stat label="Cash-like" value={usd(p?.cash_like_value)} /></Card>
        <Card>
          <Stat label="Unrealized gain"
            value={gain == null ? "—" : (
              <span className={gain >= 0 ? "text-green" : "text-red"}>{gain >= 0 ? "+" : ""}{usd(gain)}</span>
            )}
            sub={p?.basis_coverage_pct != null && p.basis_coverage_pct < 100
              ? `basis known for ${p.basis_coverage_pct}% of value`
              : undefined} />
        </Card>
      </div>

      <div className="mb-4 grid gap-4 md:grid-cols-2">
        <Card title="Allocation by type">
          {p ? (
            Object.keys(p.allocation_by_type).length
              ? <AllocationDonut data={Object.entries(p.allocation_by_type).map(([name, value]) => ({ name, value }))} />
              : <div className="text-mut">No holdings snapshots yet — run a sync.</div>
          ) : portfolio.error ? null : <Loading />}
        </Card>
        <Card title="Concentration">
          {p?.concentration ? (
            <div className="space-y-2 text-sm">
              <div>Top position: <b>{p.concentration.top_position.symbol ?? "?"}</b>{" "}
                at <b>{pct(p.concentration.top_position.weight_pct)}</b> of portfolio</div>
              <div>Top 5 positions: <b>{pct(p.concentration.top5_weight_pct)}</b></div>
              {p.concentration.top5_weight_pct > 60 && (
                <div className="text-amber">⚠ concentrated — top 5 hold most of the portfolio</div>
              )}
            </div>
          ) : <div className="text-mut">—</div>}
        </Card>
      </div>

      <Card title="Positions">
        {p ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-mut">
                <th className="py-2">Symbol</th><th>Name</th><th>Type</th>
                <th className="text-right">Qty</th><th className="text-right">Value</th>
                <th className="text-right">Weight</th><th className="text-right">Basis</th>
                <th className="text-right">Gain</th>
              </tr>
            </thead>
            <tbody>
              {p.positions.map((pos, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="py-2 font-medium">
                    {pos.symbol ?? "?"}
                    {pos.cash_like && <span className="ml-1.5 rounded-full bg-mut/15 px-1.5 py-0.5 text-[10px] text-mut">cash</span>}
                  </td>
                  <td className="max-w-56 truncate py-2 text-mut">{pos.name ?? "—"}</td>
                  <td className="py-2 text-mut">{pos.security_type ?? "—"}</td>
                  <td className="py-2 text-right">{pos.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                  <td className="py-2 text-right">{usd(pos.market_value)}</td>
                  <td className="py-2 text-right text-mut">{pct(pos.weight_pct)}</td>
                  <td className="py-2 text-right text-mut">{pos.basis_known ? usd(pos.cost_basis) : "?"}</td>
                  <td className="py-2 text-right">
                    {pos.unrealized_gain == null ? <span className="text-mut">?</span> : (
                      <span className={pos.unrealized_gain >= 0 ? "text-green" : "text-red"}>
                        {pos.unrealized_gain >= 0 ? "+" : ""}{usd(pos.unrealized_gain)}
                        {pos.unrealized_pct != null && <span className="ml-1 text-xs">({pos.unrealized_pct > 0 ? "+" : ""}{pos.unrealized_pct}%)</span>}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : portfolio.error ? null : <Loading />}
      </Card>

      <Card className="mt-4" title="Recent investment activity"
        right={
          <button onClick={() => setShowActivity(!showActivity)}
            className="rounded-lg border border-line px-3 py-1.5 text-sm font-semibold">
            {showActivity ? "Hide" : "Load (live Plaid, ~30s)"}
          </button>
        }>
        {!showActivity ? (
          <div className="text-sm text-mut">Trades, dividends, and fees from the last 90 days — fetched live on demand.</div>
        ) : activity.data ? (
          <>
            <WarningsBanner warnings={activity.data.warnings} />
            {activity.data.investment_transactions.length ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-mut">
                    <th className="py-2">Date</th><th>Description</th><th>Type</th><th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.data.investment_transactions.map((t, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="py-2 text-mut">{fmtDate(t.date)}</td>
                      <td className="py-2">{t.name ?? t.symbol ?? "—"}</td>
                      <td className="py-2 text-mut">{t.subtype ?? t.type ?? "—"}</td>
                      <td className="py-2 text-right">{usd(t.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="text-mut">No activity in the last 90 days.</div>}
          </>
        ) : activity.error ? <ErrorBanner error={activity.error} /> : <Loading />}
      </Card>
    </div>
  );
}
