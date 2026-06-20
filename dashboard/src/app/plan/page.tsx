"use client";

import { useTool } from "@/lib/hooks";
import { usd } from "@/lib/format";
import { Badge, Card, cx, ErrorBanner, KpiCard, SkeletonStats } from "@/components/ui";
import { IconAlert, IconCheck, IconPlan, IconSparkle } from "@/components/icons";

type Envelope = { key: string; budget: number; spent: number; remaining: number; weekly_allowance: number; state: "open" | "slow" | "closed" };
type Directive = { severity: "stop" | "slow" | "act" | "info"; envelope: string | null; order: string; reason: string; amount: number | null };
type PlanPayload = {
  plan: {
    month: string;
    mode: "NORMAL" | "TIGHT" | "DAMAGE_CONTROL";
    target: number;
    total_spent: number;
    headroom: number;
    rent: { reserve: number; posted: number | null; status: "posted" | "reserved" };
    envelopes: Envelope[];
    week: { days_left: number; weeks_left: number };
    projected_subs_monthly: number;
  } | null;
  directives: Directive[];
  warnings: string[];
};

const ENV_LABEL: Record<string, string> = { walmart: "Walmart", indian: "Indian store", subscriptions: "Subscriptions", other: "Everything else" };
const MODE_TONE: Record<string, "green" | "accent" | "red"> = { NORMAL: "green", TIGHT: "accent", DAMAGE_CONTROL: "red" };
const STATE_TONE: Record<string, "green" | "accent" | "red"> = { open: "green", slow: "accent", closed: "red" };
const SEV_TONE: Record<string, "red" | "accent" | "neutral"> = { stop: "red", slow: "accent", act: "accent", info: "neutral" };

function BurnBar({ spent, budget }: { spent: number; budget: number }) {
  const pct = budget > 0 ? (spent / budget) * 100 : 100;
  const color = pct >= 100 ? "bg-red" : pct > 60 ? "bg-amber" : "bg-green";
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-line">
      <div className={cx("h-full rounded-full transition-all", color)} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

export default function PlanPage() {
  const res = useTool<PlanPayload>("get_optimizer_plan");
  const plan = res.data?.plan;
  const directives = res.data?.directives ?? [];
  const warnings = res.data?.warnings ?? [];

  return (
    <div className="space-y-4">
      <ErrorBanner error={res.error} />
      {warnings.map((w, i) => (
        <div key={i} className="flex items-center gap-2 rounded-[var(--radius)] border border-[color-mix(in_oklab,var(--red)_40%,transparent)] bg-[var(--red-soft)] px-4 py-3 text-sm text-red">
          <IconAlert size={16} /> {w}
        </div>
      ))}

      {!res.data && !res.error ? <SkeletonStats n={3} /> : null}

      {plan && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={MODE_TONE[plan.mode]} dot>
              {plan.mode.replace("_", " ")}
            </Badge>
            <span className="text-sm text-mut">
              {plan.month} · {plan.week.days_left} days left · {plan.week.weeks_left} week(s)
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <KpiCard label="Spent" value={usd(plan.total_spent)} icon={<IconPlan size={15} />} footnote={`target ${usd(plan.target)}`} accent />
            <KpiCard label="Headroom" value={<span className={plan.headroom >= 0 ? "text-green" : "text-red"}>{usd(plan.headroom)}</span>} />
            <KpiCard label="Rent" value={usd(plan.rent.posted ?? plan.rent.reserve)} footnote={plan.rent.status === "posted" ? "posted" : "reserved — committed day 1"} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {plan.envelopes.map((e) => (
              <Card key={e.key} title={ENV_LABEL[e.key] ?? e.key} right={<Badge tone={STATE_TONE[e.state]}>{e.state}</Badge>}>
                <div className="nums text-2xl font-semibold tracking-tight text-txt">{usd(e.remaining)}</div>
                <div className="text-xs text-mut">left of {usd(e.budget)}</div>
                <BurnBar spent={e.spent} budget={e.budget} />
                <div className="mt-2 text-xs text-faint">{usd(e.spent)} spent · ≤ {usd(e.weekly_allowance)}/wk</div>
              </Card>
            ))}
          </div>

          <Card title="Orders" icon={<IconSparkle size={16} />}>
            {directives.length ? (
              <ol className="space-y-3">
                {directives.map((d, i) => (
                  <li key={i} className="flex items-start gap-3 border-t border-line pt-3 first:border-0 first:pt-0">
                    <Badge tone={SEV_TONE[d.severity]}>{d.severity}</Badge>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-txt">{d.order}</div>
                      <div className="text-xs text-mut">{d.reason}</div>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="flex items-center gap-2 text-sm text-mut">
                <IconCheck size={16} className="text-green" /> Nothing to do — you&apos;re on plan.
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
