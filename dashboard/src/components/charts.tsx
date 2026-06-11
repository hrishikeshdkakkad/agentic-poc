"use client";

import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { usd } from "@/lib/format";

const AXIS = { stroke: "#262b33", tick: { fill: "#9aa3b2", fontSize: 12 } };
const TOOLTIP = {
  contentStyle: { background: "#181b21", border: "1px solid #262b33", borderRadius: 8 },
  labelStyle: { color: "#9aa3b2" },
};
const PALETTE = ["#4c8bf5", "#2ecc71", "#f5a623", "#ff5b5b", "#a78bfa", "#34d399",
                 "#f472b6", "#60a5fa", "#fbbf24", "#9aa3b2"];

export function NetWorthChart({ data }: {
  data: Array<{ date: string; assets: number; liabilities: number; net_worth: number }>;
}) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={data}>
        <CartesianGrid stroke="#262b33" strokeDasharray="3 3" />
        <XAxis dataKey="date" {...AXIS} />
        <YAxis {...AXIS} tickFormatter={(v: number) => usd(v)} width={90} />
        <Tooltip {...TOOLTIP} formatter={(v) => usd(Number(v))} />
        <Legend />
        <Area type="monotone" dataKey="assets" stroke="#2ecc71" fill="#2ecc71" fillOpacity={0.08} />
        <Area type="monotone" dataKey="liabilities" stroke="#ff5b5b" fill="#ff5b5b" fillOpacity={0.08} />
        <Area type="monotone" dataKey="net_worth" stroke="#4c8bf5" fill="#4c8bf5" fillOpacity={0.15} strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Stacked monthly bars; series = distinct group names. onBarClick gets the group name. */
export function StackedMonthlyBars({ data, series, onBarClick }: {
  data: Array<Record<string, number | string>>; series: string[];
  onBarClick?: (group: string) => void;
}) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      <BarChart data={data}>
        <CartesianGrid stroke="#262b33" strokeDasharray="3 3" />
        <XAxis dataKey="month" {...AXIS} />
        <YAxis {...AXIS} tickFormatter={(v: number) => usd(v)} width={90} />
        <Tooltip {...TOOLTIP} formatter={(v) => usd(Number(v))} />
        <Legend />
        {series.map((s, i) => (
          <Bar key={s} dataKey={s} stackId="m" fill={PALETTE[i % PALETTE.length]}
            cursor={onBarClick ? "pointer" : undefined}
            onClick={() => onBarClick?.(s)} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function AllocationDonut({ data }: { data: Array<{ name: string; value: number }> }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" innerRadius={60} outerRadius={95} stroke="none">
          {data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
        </Pie>
        <Tooltip {...TOOLTIP} formatter={(v) => usd(Number(v))} />
        <Legend />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function IncomeExpenseBars({ data }: {
  data: Array<{ month: string; income: number; expenses: number; net: number }>;
}) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data}>
        <CartesianGrid stroke="#262b33" strokeDasharray="3 3" />
        <XAxis dataKey="month" {...AXIS} />
        <YAxis {...AXIS} tickFormatter={(v: number) => usd(v)} width={90} />
        <Tooltip {...TOOLTIP} formatter={(v) => usd(Number(v))} />
        <Legend />
        <Bar dataKey="income" fill="#2ecc71" />
        <Bar dataKey="expenses" fill="#ff5b5b" />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function SparkLine({ data, dataKey }: {
  data: Array<Record<string, number | string>>; dataKey: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={60}>
      <LineChart data={data}>
        <Line type="monotone" dataKey={dataKey} stroke="#4c8bf5" dot={false} strokeWidth={2} />
        <Tooltip {...TOOLTIP} formatter={(v) => usd(Number(v))} />
      </LineChart>
    </ResponsiveContainer>
  );
}
