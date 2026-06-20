"use client";

import { useMemo, useState } from "react";
import { useTool } from "@/lib/hooks";
import { usd } from "@/lib/format";
import { Balance, Button, Card, EmptyState, ErrorBanner, inputCls, KpiCard, Loading, Segmented, SkeletonStats, WarningsBanner, Warning } from "@/components/ui";
import { NetWorthChart } from "@/components/charts";
import { ContextStrip } from "@/components/realestate/context-strip";
import { IconNetWorth } from "@/components/icons";

type Pt = { date: string; assets: number; liabilities: number; net_worth: number };
type History = { history: Pt[]; warnings?: Warning[] };
type Trajectory = {
  estimated_monthly_change?: number | null;
  estimate_source?: string;
  milestone?: Record<string, unknown>;
  warnings?: Warning[];
};

const RANGES: Record<string, number> = { "3M": 90, "6M": 180, "1Y": 365, All: Infinity };

function isoDaysBefore(anchorDate: string | undefined, days: number): string | null {
  if (!anchorDate) return null;
  const t = new Date(`${anchorDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t - days * 864e5).toISOString().slice(0, 10);
}

export default function NetWorthPage() {
  const [milestoneInput, setMilestoneInput] = useState("100000");
  const [milestone, setMilestone] = useState(100000);
  const [range, setRange] = useState<keyof typeof RANGES>("6M");

  const hist = useTool<History>("get_net_worth_history");
  const traj = useTool<Trajectory>("get_net_worth_trajectory", { milestone });

  const all = useMemo(() => hist.data?.history ?? [], [hist.data?.history]);
  const latest = all[all.length - 1];

  const cutoff30 = isoDaysBefore(latest?.date, 30);
  const monthAgo = cutoff30 ? all.find((r) => r.date >= cutoff30) : undefined;
  const change30 = latest && monthAgo && monthAgo !== latest ? latest.net_worth - monthAgo.net_worth : null;

  const shown = useMemo(() => {
    const days = RANGES[range];
    if (!isFinite(days)) return all;
    const cut = isoDaysBefore(latest?.date, days);
    if (!cut) return all;
    return all.filter((r) => r.date >= cut);
  }, [all, latest?.date, range]);

  return (
    <div className="space-y-4">
      <ErrorBanner error={hist.error ?? traj.error} />
      <WarningsBanner warnings={hist.data?.warnings} />

      <ContextStrip />

      {hist.data ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <KpiCard label="Net worth" value={<Balance amount={latest?.net_worth} />} icon={<IconNetWorth size={15} />} accent footnote={latest ? `as of ${latest.date}` : "no snapshots yet"} />
          <KpiCard label="30-day change" value={change30 == null ? "—" : <span className={change30 >= 0 ? "text-green" : "text-red"}>{change30 >= 0 ? "+" : "−"}{usd(Math.abs(change30))}</span>} footnote={latest ? `assets ${usd(latest.assets)} · debts ${usd(latest.liabilities)}` : undefined} />
          <KpiCard
            label="Est. monthly change"
            value={traj.data?.estimated_monthly_change == null ? "—" : <span className={traj.data.estimated_monthly_change >= 0 ? "text-green" : "text-red"}>{traj.data.estimated_monthly_change >= 0 ? "+" : "−"}{usd(Math.abs(traj.data.estimated_monthly_change))}</span>}
            footnote={traj.data?.estimate_source ? `source: ${traj.data.estimate_source}` : undefined}
          />
        </div>
      ) : hist.error ? null : (
        <SkeletonStats n={3} />
      )}

      <Card
        title="History"
        subtitle="assets, liabilities & net worth"
        right={<Segmented value={range as string} onChange={(v) => setRange(v as keyof typeof RANGES)} options={Object.keys(RANGES).map((r) => ({ value: r, label: r }))} />}
      >
        {hist.data ? (
          shown.length > 1 ? (
            <NetWorthChart data={shown} height={320} />
          ) : (
            <EmptyState icon={<IconNetWorth size={20} />} title="Not enough snapshots in range" description="Widen the range or run a sync to build history." />
          )
        ) : hist.error ? null : (
          <Loading />
        )}
      </Card>

      <Card
        title="Milestone trajectory"
        right={
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setMilestone(Number(milestoneInput) || 100000);
            }}
          >
            <input className={`${inputCls} w-36`} type="number" value={milestoneInput} onChange={(e) => setMilestoneInput(e.target.value)} />
            <Button type="submit" size="sm" variant="secondary">
              Project
            </Button>
          </form>
        }
      >
        {traj.data?.milestone ? (
          <div className="grid gap-x-6 gap-y-px sm:grid-cols-2">
            {Object.entries(traj.data.milestone).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-4 border-b border-line py-2.5 last:border-0">
                <span className="text-[13px] capitalize text-mut">{k.replace(/_/g, " ")}</span>
                <span className="nums text-[13px] font-medium text-txt">{typeof v === "number" ? (Math.abs(v) >= 1000 ? usd(v) : String(v)) : String(v ?? "—")}</span>
              </div>
            ))}
          </div>
        ) : traj.error ? null : (
          <Loading />
        )}
      </Card>
    </div>
  );
}
