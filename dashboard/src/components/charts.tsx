"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { usd } from "@/lib/format";

/* Everything is driven by CSS variables, so charts re-theme with the app —
   no light/dark branches, no hard-coded hex. */
export const PALETTE = [
  "var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)",
  "var(--c6)", "var(--c7)", "var(--c8)", "var(--c9)", "var(--c10)",
];

const AXIS = {
  stroke: "var(--line)",
  tick: { fill: "var(--mut)", fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const;

const compact = (v: number) =>
  Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : `$${v}`;

/* ───────────────────────────  tooltip  ─────────────────────────────────── */

type TipPayload = { name?: string; value?: number; color?: string; dataKey?: string };
function ChartTooltip({
  active,
  payload,
  label,
  hideZero,
}: {
  active?: boolean;
  payload?: TipPayload[];
  label?: string;
  hideZero?: boolean;
}) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((p) => (hideZero ? Math.abs(Number(p.value)) > 0.005 : true));
  if (!rows.length) return null;
  return (
    <div className="min-w-[160px] rounded-[var(--radius)] border border-line-strong bg-elevated p-3 shadow-[var(--shadow-lg)]">
      {label && <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-mut">{label}</div>}
      <div className="space-y-1">
        {rows.map((p, i) => (
          <div key={i} className="flex items-center justify-between gap-4 text-[13px]">
            <span className="flex items-center gap-1.5 text-mut">
              <span className="h-2 w-2 rounded-[3px]" style={{ background: p.color }} />
              {String(p.name).replace(/_/g, " ")}
            </span>
            <span className="nums font-semibold text-txt">{usd(Number(p.value))}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const cursorFill = { fill: "var(--hover)", fillOpacity: 0.5 };

/* ───────────────────────────  net worth  ───────────────────────────────── */

export function NetWorthChart({
  data,
  height = 300,
}: {
  data: Array<{ date: string; assets: number; liabilities: number; net_worth: number }>;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <defs>
          <linearGradient id="nwFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.32} />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" {...AXIS} minTickGap={40} />
        <YAxis {...AXIS} tickFormatter={compact} width={52} />
        <Tooltip content={<ChartTooltip />} />
        <Area type="monotone" dataKey="assets" name="Assets" stroke="var(--green)" strokeWidth={1.5} fill="none" dot={false} isAnimationActive={false} />
        <Area type="monotone" dataKey="liabilities" name="Liabilities" stroke="var(--red)" strokeWidth={1.5} fill="none" dot={false} isAnimationActive={false} />
        <Area type="monotone" dataKey="net_worth" name="Net worth" stroke="var(--accent)" strokeWidth={2.5} fill="url(#nwFill)" dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* ───────────────────────────  stacked bars  ────────────────────────────── */

export function StackedMonthlyBars({
  data,
  series,
  onBarClick,
  height = 340,
}: {
  data: Array<Record<string, number | string>>;
  series: string[];
  onBarClick?: (group: string) => void;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }} barCategoryGap="22%">
        <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="month" {...AXIS} />
        <YAxis {...AXIS} tickFormatter={compact} width={52} />
        <Tooltip content={<ChartTooltip hideZero />} cursor={cursorFill} />
        {series.map((s, i) => (
          <Bar
            key={s}
            dataKey={s}
            name={s}
            stackId="m"
            fill={PALETTE[i % PALETTE.length]}
            radius={i === series.length - 1 ? [4, 4, 0, 0] : undefined}
            cursor={onBarClick ? "pointer" : undefined}
            onClick={() => onBarClick?.(s)}
            maxBarSize={56}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ───────────────────────────  donut  ───────────────────────────────────── */

export function AllocationDonut({
  data,
  height = 260,
  centerLabel,
  centerValue,
}: {
  data: Array<{ name: string; value: number }>;
  height?: number;
  centerLabel?: string;
  centerValue?: React.ReactNode;
}) {
  return (
    <div className="relative" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="62%"
            outerRadius="92%"
            paddingAngle={2}
            stroke="var(--card)"
            strokeWidth={2}
            isAnimationActive={false}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      {(centerLabel || centerValue) && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          {centerValue && <div className="nums text-xl font-semibold tracking-tight text-txt">{centerValue}</div>}
          {centerLabel && <div className="text-[11px] uppercase tracking-[0.08em] text-mut">{centerLabel}</div>}
        </div>
      )}
    </div>
  );
}

/** Legend chips for the donut, with values + share. */
export function DonutLegend({ data, total }: { data: Array<{ name: string; value: number }>; total: number }) {
  return (
    <div className="space-y-1.5">
      {data.map((d, i) => (
        <div key={d.name} className="flex items-center justify-between gap-3 text-[13px]">
          <span className="flex min-w-0 items-center gap-2 text-mut">
            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="truncate capitalize">{d.name.replace(/_/g, " ")}</span>
          </span>
          <span className="nums shrink-0 font-medium text-txt">
            {usd(d.value)} <span className="text-faint">· {total ? ((d.value / total) * 100).toFixed(0) : 0}%</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────────  income vs expense  ───────────────────────── */

export function IncomeExpenseBars({
  data,
  height = 300,
}: {
  data: Array<{ month: string; income: number; expenses: number; net: number }>;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }} barGap={4}>
        <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="month" {...AXIS} />
        <YAxis {...AXIS} tickFormatter={compact} width={52} />
        <Tooltip content={<ChartTooltip />} cursor={cursorFill} />
        <ReferenceLine y={0} stroke="var(--line-strong)" />
        <Bar dataKey="income" name="Income" fill="var(--green)" radius={[4, 4, 0, 0]} maxBarSize={40} isAnimationActive={false} />
        <Bar dataKey="expenses" name="Expenses" fill="var(--red)" radius={[4, 4, 0, 0]} maxBarSize={40} isAnimationActive={false} />
        <Line type="monotone" dataKey="net" name="Net" stroke="var(--accent)" strokeWidth={2} dot={false} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ───────────────────────────  sparkline  ───────────────────────────────── */

export function SparkLine({
  data,
  dataKey,
  height = 56,
  tone = "accent",
}: {
  data: Array<Record<string, number | string>>;
  dataKey: string;
  height?: number;
  tone?: "accent" | "green" | "red";
}) {
  const color = tone === "green" ? "var(--green)" : tone === "red" ? "var(--red)" : "var(--accent)";
  const id = `spark-${dataKey}-${tone}`;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.3} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Tooltip content={<ChartTooltip />} />
        <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} fill={`url(#${id})`} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
