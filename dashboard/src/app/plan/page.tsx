"use client";

import { useTool } from "@/lib/hooks";
import { usd } from "@/lib/format";
import { Card, ErrorBanner, Loading, Stat } from "@/components/ui";

type Envelope = {
  key: string; budget: number; spent: number; remaining: number;
  weekly_allowance: number; state: "open" | "slow" | "closed";
};
type Directive = {
  severity: "stop" | "slow" | "act" | "info"; envelope: string | null;
  order: string; reason: string; amount: number | null;
};
type PlanPayload = {
  plan: {
    month: string; mode: "NORMAL" | "TIGHT" | "DAMAGE_CONTROL"; target: number;
    total_spent: number; headroom: number;
    rent: { reserve: number; posted: number | null; status: "posted" | "reserved" };
    envelopes: Envelope[]; week: { days_left: number; weeks_left: number };
    projected_subs_monthly: number;
  } | null;
  directives: Directive[];
  warnings: string[];
};

const ENV_LABEL: Record<string, string> = {
  walmart: "Walmart", indian: "Indian store",
  subscriptions: "Subscriptions", other: "Everything else",
};
const MODE_STYLE: Record<string, string> = {
  NORMAL: "bg-green/15 text-green",
  TIGHT: "bg-accent/15 text-accent",
  DAMAGE_CONTROL: "bg-red/15 text-red",
};
const SEV_STYLE: Record<string, string> = {
  stop: "bg-red/15 text-red", slow: "bg-accent/15 text-accent",
  act: "bg-accent/15 text-accent", info: "bg-card text-mut",
};

function BurnBar({ spent, budget }: { spent: number; budget: number }) {
  const pct = budget > 0 ? (spent / budget) * 100 : 100;
  const color = pct >= 100 ? "bg-red" : pct > 60 ? "bg-accent" : "bg-green";
  return (
    <div className="mt-2 h-1.5 w-full rounded bg-line">
      <div className={`h-1.5 rounded ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

export default function PlanPage() {
  const res = useTool<PlanPayload>("get_optimizer_plan");
  const plan = res.data?.plan;
  const directives = res.data?.directives ?? [];
  const warnings = res.data?.warnings ?? [];

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-1 text-xl font-bold">Plan</h1>
      <p className="mb-6 text-sm text-mut">
        What to do with the month — envelopes, orders, and this week&apos;s allowances.
      </p>
      <ErrorBanner error={res.error} />
      {warnings.map((w, i) => (
        <div key={i} className="mb-4 rounded-md border border-line bg-card px-3 py-2 text-sm text-red">
          ⚠ {w}
        </div>
      ))}

      {!res.data && !res.error ? <Loading /> : null}

      {plan && (
        <>
          <div className="mb-4 flex items-center gap-3">
            <span className={`rounded-full px-3 py-1 text-sm font-bold ${MODE_STYLE[plan.mode]}`}>
              {plan.mode.replace("_", " ")}
            </span>
            <span className="text-sm text-mut">
              {plan.month} · {plan.week.days_left} days left · {plan.week.weeks_left} week(s)
            </span>
          </div>

          <div className="mb-4 grid gap-4 md:grid-cols-3">
            <Card><Stat label="Spent" value={usd(plan.total_spent)} sub={`target ${usd(plan.target)}`} /></Card>
            <Card><Stat label="Headroom" value={
              <span className={plan.headroom >= 0 ? "text-green" : "text-red"}>{usd(plan.headroom)}</span>
            } /></Card>
            <Card><Stat label="Rent" value={usd(plan.rent.posted ?? plan.rent.reserve)}
              sub={plan.rent.status === "posted" ? "posted" : "reserved — committed day 1"} /></Card>
          </div>

          <div className="mb-4 grid gap-4 md:grid-cols-4">
            {plan.envelopes.map((e) => (
              <Card key={e.key} title={ENV_LABEL[e.key] ?? e.key}>
                <div className="flex items-baseline justify-between">
                  <span className="text-lg font-semibold">{usd(e.remaining)}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    e.state === "open" ? "bg-green/15 text-green"
                    : e.state === "slow" ? "bg-accent/15 text-accent" : "bg-red/15 text-red"}`}>
                    {e.state.toUpperCase()}
                  </span>
                </div>
                <div className="text-xs text-mut">{usd(e.spent)} of {usd(e.budget)} spent</div>
                <BurnBar spent={e.spent} budget={e.budget} />
                <div className="mt-2 text-xs text-mut">≤ {usd(e.weekly_allowance)}/week</div>
              </Card>
            ))}
          </div>

          <Card title="Orders">
            <ol className="flex flex-col gap-2">
              {directives.map((d, i) => (
                <li key={i} className="flex items-start gap-3 border-t border-line pt-2 first:border-0 first:pt-0">
                  <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${SEV_STYLE[d.severity]}`}>
                    {d.severity}
                  </span>
                  <div>
                    <div className="text-sm font-medium">{d.order}</div>
                    <div className="text-xs text-mut">{d.reason}</div>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </>
      )}
    </div>
  );
}
