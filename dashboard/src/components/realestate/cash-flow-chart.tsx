"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ModelResult } from "@/lib/realestate/model";
import { compactInr, cr, inrToUsd } from "@/lib/realestate/format";
import { Card } from "@/components/ui";

const AXIS = {
  stroke: "var(--line)",
  tick: { fill: "var(--mut)", fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const;

type TipPayload = { value?: number; payload?: { month: string } };
function Tip({ active, payload, usdRate }: { active?: boolean; payload?: TipPayload[]; usdRate: number }) {
  if (!active || !payload?.length) return null;
  const v = Number(payload[0].value);
  return (
    <div className="rounded-[var(--radius)] border border-line-strong bg-elevated p-3 text-[13px] shadow-[var(--shadow-lg)]">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-mut">
        {payload[0].payload?.month}
      </div>
      <div className="nums font-semibold text-txt">
        {v >= 0 ? "+" : "−"}
        {cr(Math.abs(v))} <span className="text-faint">· {inrToUsd(Math.abs(v), usdRate)}</span>
      </div>
      <div className="text-[11px] text-mut">{v > 0 ? "cash in" : v < 0 ? "cash out" : "no flow"}</div>
    </div>
  );
}

/** Levered net cash flow per quarter (base case), the series the IRR runs on. */
export function CashFlowChart({ result, usdRate }: { result: ModelResult; usdRate: number }) {
  const base = result.scenarios.base;
  const data = result.months.map((m, i) => ({ month: `M${m}`, cf: base.netFlows[i] }));

  return (
    <Card title="Levered cash flow" subtitle="net ₹ per quarter — base case (loan + investor tranches counted as inflows)">
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="month" {...AXIS} />
          <YAxis {...AXIS} tickFormatter={(v) => compactInr(Number(v))} width={56} />
          <Tooltip content={<Tip usdRate={usdRate} />} cursor={{ fill: "var(--hover)", fillOpacity: 0.5 }} />
          <ReferenceLine y={0} stroke="var(--line-strong)" />
          <Bar dataKey="cf" radius={[3, 3, 0, 0]} maxBarSize={42} isAnimationActive={false}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.cf >= 0 ? "var(--green)" : "var(--red)"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
}
