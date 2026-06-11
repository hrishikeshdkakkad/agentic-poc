"use client";

import { useState } from "react";
import { useTool } from "@/lib/hooks";
import { usd } from "@/lib/format";
import { Balance, Card, ErrorBanner, Loading, Stat, WarningsBanner, Warning } from "@/components/ui";
import { NetWorthChart } from "@/components/charts";

type History = {
  history: Array<{ date: string; assets: number; liabilities: number; net_worth: number }>;
  warnings?: Warning[];
};
type Trajectory = {
  estimated_monthly_change?: number | null;
  estimate_source?: string;
  milestone?: Record<string, unknown>;
  warnings?: Warning[];
};

export default function NetWorthPage() {
  const [milestoneInput, setMilestoneInput] = useState("100000");
  const [milestone, setMilestone] = useState(100000);

  const hist = useTool<History>("get_net_worth_history");
  const traj = useTool<Trajectory>("get_net_worth_trajectory", { milestone });

  const h = hist.data?.history ?? [];
  const latest = h[h.length - 1];
  // 30-day change: compare against the earliest snapshot within the last 30 days.
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const monthAgo = h.find((r) => r.date >= cutoff);
  const change30 =
    latest && monthAgo && monthAgo !== latest ? latest.net_worth - monthAgo.net_worth : null;

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-1 text-xl font-bold">Net worth</h1>
      <p className="mb-6 text-sm text-mut">Snapshot history and where it&apos;s heading.</p>

      <ErrorBanner error={hist.error ?? traj.error} />
      <WarningsBanner warnings={hist.data?.warnings} />

      <div className="mb-4 grid gap-4 md:grid-cols-3">
        <Card>
          <Stat label="Net worth (latest snapshot)" value={<Balance amount={latest?.net_worth} />}
            sub={latest ? `as of ${latest.date}` : "no snapshots yet — run a sync"} />
        </Card>
        <Card>
          <Stat label="30-day change"
            value={change30 == null ? "—" : (
              <span className={change30 >= 0 ? "text-green" : "text-red"}>
                {change30 >= 0 ? "+" : ""}{usd(change30)}
              </span>
            )}
            sub={latest ? `assets ${usd(latest.assets)} · debts ${usd(latest.liabilities)}` : undefined} />
        </Card>
        <Card>
          <Stat label="Est. monthly change"
            value={traj.data?.estimated_monthly_change == null ? "—" : (
              <span className={traj.data.estimated_monthly_change >= 0 ? "text-green" : "text-red"}>
                {traj.data.estimated_monthly_change >= 0 ? "+" : ""}{usd(traj.data.estimated_monthly_change)}
              </span>
            )}
            sub={traj.data?.estimate_source ? `source: ${traj.data.estimate_source}` : undefined} />
        </Card>
      </div>

      <Card title="History">
        {hist.data ? (
          h.length ? <NetWorthChart data={h} /> : <div className="text-mut">No snapshots yet — run a sync.</div>
        ) : hist.error ? null : <Loading />}
      </Card>

      <Card title="Milestone trajectory" className="mt-4"
        right={
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setMilestone(Number(milestoneInput) || 100000); }}>
            <input className="w-32 rounded-md border border-line bg-bg px-2 py-1 text-sm"
              type="number" value={milestoneInput} onChange={(e) => setMilestoneInput(e.target.value)} />
            <button className="rounded-lg border border-line px-3 py-1 text-sm font-semibold">Project</button>
          </form>
        }>
        {traj.data?.milestone ? (
          <div className="grid gap-1.5 text-sm md:grid-cols-2">
            {Object.entries(traj.data.milestone).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 border-b border-line py-1.5 last:border-0 md:last:border-b">
                <span className="text-mut">{k.replace(/_/g, " ")}</span>
                <span className="font-medium">
                  {typeof v === "number" ? (Math.abs(v) >= 1000 ? usd(v) : String(v)) : String(v ?? "—")}
                </span>
              </div>
            ))}
          </div>
        ) : traj.error ? null : <Loading />}
      </Card>
    </div>
  );
}
