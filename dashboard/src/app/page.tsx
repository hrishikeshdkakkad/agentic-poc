"use client";

import { useLinkStatus, useTool } from "@/lib/hooks";
import { fmtDateTime, usd } from "@/lib/format";
import { Balance, Card, ErrorBanner, Loading, Stat, StatusBadge, WarningsBanner } from "@/components/ui";
import Link from "next/link";

type NetWorth = {
  net_worth?: number; total_assets?: number; total_liabilities?: number;
  by_class?: Record<string, { total: number; accounts: unknown[] }>;
  warnings?: [];
};
type Health = {
  months_of_runway?: number | null;
  liquid_reserves?: number;
  income?: { savings_rate?: number | null };
  flags?: Array<{ flag: string; severity: string; detail: string }>;
};
type Game = {
  current_month?: {
    total: number; target: number; remaining: number; elapsed_days: number;
    days_in_month: number; saved: number; allowance_to_date?: number;
    new_record?: boolean; by_category?: Record<string, number>;
  };
  months_won?: number; months_played?: number; wedding_saved_total?: number;
};
type LinkStatus = {
  institutions: Array<{ env_key: string; institution: string; status: string;
    last_synced_at: string | null; accounts: Array<{ name: string; mask?: string }> }>;
  db_ok: boolean;
  delivery?: { this_month?: number; orders?: number; last_month?: number };
  last_sync?: { at: string; ok: boolean } | null;
};

export default function Overview() {
  const nw = useTool<NetWorth>("get_net_worth");
  const health = useTool<Health>("get_financial_health");
  const game = useTool<Game>("get_optimizer_score");
  const status = useLinkStatus<LinkStatus>();

  const cm = game.data?.current_month;
  const overBudget = cm ? cm.total > cm.target : false;
  const pctUsed = cm ? Math.min(100, Math.round((100 * cm.total) / cm.target)) : 0;
  const lastOk = status.data?.institutions.map((i) => i.last_synced_at).filter(Boolean).sort().pop();
  const savingsRate = health.data?.income?.savings_rate;

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-1 text-xl font-bold">Overview</h1>
      <p className="mb-6 text-sm text-mut">Everything, at a glance.</p>

      <ErrorBanner error={nw.error ?? status.error} />
      <WarningsBanner warnings={nw.data?.warnings} />

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <Stat label="Net worth" value={<Balance amount={nw.data?.net_worth} />}
            sub={nw.data ? <>assets {usd(nw.data.total_assets)} · debts {usd(nw.data.total_liabilities)}</> : "…"} />
        </Card>
        <Card>
          <Stat label="Financial health"
            value={health.data?.months_of_runway != null ? `${health.data.months_of_runway} mo runway` : "…"}
            sub={health.data ? <>
              liquid {usd(health.data.liquid_reserves)}
              {savingsRate != null && <> · saving {(savingsRate * 100).toFixed(0)}%</>}
            </> : undefined} />
          {!!health.data?.flags?.length && (
            <div className="mt-2 text-xs text-amber">
              {health.data.flags.length} flag{health.data.flags.length > 1 ? "s" : ""}:{" "}
              {health.data.flags.map((f) => f.flag).join(", ")}
            </div>
          )}
        </Card>
        <Card>
          <Stat label="This month (Optimizer)"
            value={cm ? <span className={overBudget ? "text-red" : ""}>{usd(cm.total)}</span> : "…"}
            sub={cm ? `of ${usd(cm.target)} target · day ${cm.elapsed_days}/${cm.days_in_month}` : undefined} />
          {cm && (
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-line">
              <div className={`h-full ${overBudget ? "bg-red" : pctUsed > 80 ? "bg-amber" : "bg-green"}`}
                style={{ width: `${pctUsed}%` }} />
            </div>
          )}
        </Card>
      </div>

      {nw.data?.by_class && (
        <Card title="Breakdown by class" className="mt-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Object.entries(nw.data.by_class).map(([cls, v]) => (
              <Stat key={cls} label={cls.replace(/_/g, " ")} value={<Balance amount={v.total} />}
                sub={`${v.accounts.length} account${v.accounts.length === 1 ? "" : "s"}`} />
            ))}
          </div>
        </Card>
      )}

      <Card title="Connections & sync" className="mt-4"
        right={<Link href="/connections" className="text-sm text-accent">Manage →</Link>}>
        {status.data ? (
          <>
            <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-mut">
              <span>Banks: <b className="text-txt">{status.data.institutions.length}</b></span>
              <span>History DB: <b className={status.data.db_ok ? "text-green" : "text-red"}>
                {status.data.db_ok ? "connected" : "unreachable"}</b></span>
              <span>Last successful sync: <b className="text-txt">{fmtDateTime(lastOk)}</b></span>
              {status.data.delivery?.this_month != null && (
                <span>🛵 Delivery this month: <b className="text-txt">{usd(status.data.delivery.this_month)}</b>
                  {" "}({status.data.delivery.orders})</span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {status.data.institutions.map((i) => (
                <span key={i.env_key} className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm">
                  {i.institution} <StatusBadge status={i.status} />
                </span>
              ))}
            </div>
          </>
        ) : status.error ? null : <Loading />}
      </Card>

      {cm && (
        <Card title="🎮 The Optimizer" className="mt-4">
          <div className="text-sm">
            {cm.saved > 0
              ? <>💍 On track to send <b className="text-green">{usd(cm.saved)}</b> to the wedding</>
              : <>📊 Allowance to date {usd(cm.allowance_to_date ?? 0)} · at {usd(cm.total)}</>}
            {" · "}<span className="text-mut">{usd(game.data?.wedding_saved_total ?? 0)} banked</span>
            {" · "}won {game.data?.months_won ?? 0}/{game.data?.months_played ?? 0} months
            {cm.new_record && <span className="ml-2 rounded-full bg-green/15 px-2 py-0.5 text-xs font-semibold text-green">RECORD PACE</span>}
          </div>
          {cm.by_category && (
            <div className="mt-2 text-sm text-mut">
              where it&apos;s going: {Object.entries(cm.by_category).slice(0, 4)
                .map(([k, v]) => `${k} ${usd(v)}`).join(" · ")}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
