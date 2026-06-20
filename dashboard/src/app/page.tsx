"use client";

import Link from "next/link";
import { useTool } from "@/lib/hooks";
import { fmtDateTime, usd } from "@/lib/format";
import {
  Badge,
  Balance,
  Card,
  cx,
  ErrorBanner,
  KpiCard,
  Loading,
  SkeletonStats,
  StatusBadge,
  WarningsBanner,
} from "@/components/ui";
import { NetWorthChart } from "@/components/charts";
import { ContextStrip } from "@/components/realestate/context-strip";
import {
  IconAlert,
  IconArrowDownRight,
  IconChevronRight,
  IconNetWorth,
  IconPlan,
  IconSparkle,
  IconWallet,
} from "@/components/icons";

type NetWorth = {
  net_worth?: number;
  total_assets?: number;
  total_liabilities?: number;
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
    total: number;
    target: number;
    remaining: number;
    elapsed_days: number;
    days_in_month: number;
    saved: number;
    allowance_to_date?: number;
    new_record?: boolean;
    by_category?: Record<string, number>;
  };
  months_won?: number;
  months_played?: number;
  wedding_saved_total?: number;
};
type History = { history?: Array<{ date: string; assets: number; liabilities: number; net_worth: number }> };
// Connections status comes from the MCP server (works in the cloud); link_helper is local-only.
type InstStatus = { items: Array<{ env_key: string; institution: string; status: string; reason: string | null }> };
type SyncStatus = { items: Array<{ item_key: string; last_synced_at: string | null }> };

const SEV: Record<string, "red" | "amber" | "neutral"> = { high: "red", medium: "amber", low: "neutral" };

export default function Overview() {
  const nw = useTool<NetWorth>("get_net_worth");
  const health = useTool<Health>("get_financial_health");
  const game = useTool<Game>("get_optimizer_score");
  const history = useTool<History>("get_net_worth_history");
  const insts = useTool<InstStatus>("get_institutions_status");
  const sync = useTool<SyncStatus>("get_sync_status");
  const lastSync = sync.data?.items?.map((i) => i.last_synced_at).filter(Boolean).sort().pop() ?? null;

  const cm = game.data?.current_month;
  const overBudget = cm ? cm.total > cm.target : false;
  const pctUsed = cm ? Math.min(100, Math.round((100 * cm.total) / cm.target)) : 0;
  const savingsRate = health.data?.income?.savings_rate;
  const hist = history.data?.history ?? [];
  // Latest dated snapshot — instant (<1s Postgres read), unlike get_net_worth's
  // ~36s live Plaid composition. Drives the Net worth KPI so it never shows "—".
  const latestSnap = hist.length ? hist.reduce((a, b) => (a.date > b.date ? a : b)) : null;
  const byClass = Object.entries(nw.data?.by_class ?? {}).sort((a, b) => Math.abs(b[1].total) - Math.abs(a[1].total));
  const maxClass = Math.max(...byClass.map(([, v]) => Math.abs(v.total)), 1);

  return (
    <div className="space-y-4">
      <ErrorBanner error={nw.error ?? insts.error} />
      <WarningsBanner warnings={nw.data?.warnings} />

      <ContextStrip />

      {/* hero KPIs — each card guards its own source, so one failing tool can't
          blank the rest (skeleton shows only while everything is still loading). */}
      {history.data || health.data || game.data || nw.data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="Net worth"
            value={latestSnap ? <Balance amount={latestSnap.net_worth} /> : "—"}
            icon={<IconNetWorth size={15} />}
            accent
            footnote={latestSnap ? `assets ${usd(latestSnap.assets)} · debts ${usd(latestSnap.liabilities)}` : undefined}
          />
          <KpiCard
            label="Liquid reserves"
            value={health.data ? usd(health.data.liquid_reserves) : "—"}
            icon={<IconWallet size={15} />}
            footnote={health.data?.months_of_runway != null ? `${health.data.months_of_runway} mo runway` : undefined}
          />
          <KpiCard
            label="Savings rate"
            value={savingsRate == null ? "—" : <span className={savingsRate >= 0 ? "text-green" : "text-red"}>{(savingsRate * 100).toFixed(0)}%</span>}
            icon={<IconArrowDownRight size={15} />}
          />
          <KpiCard
            label="This month"
            value={cm ? <span className={overBudget ? "text-red" : ""}>{usd(cm.total)}</span> : "—"}
            icon={<IconPlan size={15} />}
            footnote={cm ? `of ${usd(cm.target)} · day ${cm.elapsed_days}/${cm.days_in_month}` : undefined}
          />
        </div>
      ) : nw.error ? null : (
        <SkeletonStats n={4} />
      )}

      {/* trend + breakdown */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Net worth trend" subtitle="snapshot history" className="lg:col-span-2">
          {history.data ? (
            hist.length > 1 ? (
              <NetWorthChart data={hist} height={260} />
            ) : (
              <div className="py-10 text-center text-sm text-mut">Not enough snapshots yet — run a sync.</div>
            )
          ) : (
            <Loading />
          )}
        </Card>
        <Card title="Breakdown by class">
          {nw.data?.by_class ? (
            <div className="space-y-3">
              {byClass.map(([cls, v]) => (
                <div key={cls}>
                  <div className="flex items-center justify-between text-[13px]">
                    <span className="capitalize text-mut">{cls.replace(/_/g, " ")}</span>
                    <Balance amount={v.total} className="font-medium" />
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
                    <div className={cx("h-full rounded-full", v.total < 0 ? "bg-red" : "bg-accent")} style={{ width: `${(Math.abs(v.total) / maxClass) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Loading />
          )}
        </Card>
      </div>

      {/* optimizer + health */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          title="The Optimizer"
          icon={<IconSparkle size={16} />}
          className="lg:col-span-2"
          right={
            cm?.new_record ? (
              <Badge tone="green" dot>
                Record pace
              </Badge>
            ) : (
              <Link href="/plan" className="flex items-center gap-1 text-[13px] text-accent hover:underline">
                Plan <IconChevronRight size={14} />
              </Link>
            )
          }
        >
          {cm ? (
            <div className="space-y-4">
              <div>
                <div className="flex items-baseline justify-between">
                  <span className="nums text-2xl font-semibold tracking-tight text-txt">{usd(cm.total)}</span>
                  <span className="text-[13px] text-mut">of {usd(cm.target)} target</span>
                </div>
                <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-line">
                  <div className={cx("h-full rounded-full transition-all", overBudget ? "bg-red" : pctUsed > 80 ? "bg-amber" : "bg-green")} style={{ width: `${pctUsed}%` }} />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3 border-t border-line pt-3 text-center">
                <div>
                  <div className="nums text-lg font-semibold text-txt">{usd(game.data?.wedding_saved_total ?? 0)}</div>
                  <div className="text-[11px] uppercase tracking-wide text-mut">Banked</div>
                </div>
                <div>
                  <div className="nums text-lg font-semibold text-txt">{game.data?.months_won ?? 0}/{game.data?.months_played ?? 0}</div>
                  <div className="text-[11px] uppercase tracking-wide text-mut">Months won</div>
                </div>
                <div>
                  <div className={cx("nums text-lg font-semibold", cm.saved > 0 ? "text-green" : "text-txt")}>{cm.saved > 0 ? `+${usd(cm.saved)}` : usd(cm.allowance_to_date ?? 0)}</div>
                  <div className="text-[11px] uppercase tracking-wide text-mut">{cm.saved > 0 ? "On track" : "Allowance"}</div>
                </div>
              </div>
              {cm.by_category && (
                <div className="text-[13px] text-mut">
                  <span className="text-faint">Where it&apos;s going · </span>
                  {Object.entries(cm.by_category)
                    .slice(0, 4)
                    .map(([k, v]) => `${k} ${usd(v)}`)
                    .join(" · ")}
                </div>
              )}
            </div>
          ) : game.error ? null : (
            <Loading />
          )}
        </Card>

        <Card title="Financial health" right={health.data?.flags?.length ? <Badge tone="amber">{health.data.flags.length} flags</Badge> : <Badge tone="green" dot>Healthy</Badge>}>
          {health.data ? (
            health.data.flags?.length ? (
              <div className="space-y-2.5">
                {health.data.flags.map((f) => (
                  <div key={f.flag} className="flex gap-2.5">
                    <IconAlert size={15} className={cx("mt-0.5 shrink-0", f.severity === "high" ? "text-red" : "text-amber")} />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium capitalize text-txt">{f.flag.replace(/_/g, " ")}</span>
                        <Badge tone={SEV[f.severity] ?? "neutral"}>{f.severity}</Badge>
                      </div>
                      <div className="text-xs text-mut">{f.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-6 text-center text-sm text-mut">No flags — everything looks healthy.</div>
            )
          ) : (
            <Loading />
          )}
        </Card>
      </div>

      {/* connections */}
      <Card
        title="Connections & sync"
        right={
          <Link href="/connections" className="flex items-center gap-1 text-[13px] text-accent hover:underline">
            Manage <IconChevronRight size={14} />
          </Link>
        }
      >
        {insts.data ? (
          <>
            <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-mut">
              <span>
                Banks <b className="text-txt">{insts.data.items.length}</b>
              </span>
              <span>
                History DB <b className={sync.data ? "text-green" : "text-mut"}>{sync.data ? "connected" : "—"}</b>
              </span>
              <span>
                Last sync <b className="text-txt">{fmtDateTime(lastSync)}</b>
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {insts.data.items.map((i) => (
                <span key={i.env_key} className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-line bg-elevated px-3 py-1.5 text-[13px]">
                  {i.institution} <StatusBadge status={i.status} />
                </span>
              ))}
            </div>
          </>
        ) : insts.error ? null : (
          <Loading />
        )}
      </Card>
    </div>
  );
}
