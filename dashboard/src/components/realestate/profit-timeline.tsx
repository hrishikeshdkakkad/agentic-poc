"use client";

// The development "J-curve": cumulative levered cash to your equity over the
// deal's life — how deep your money is in, for how long, and when you cross into
// profit — with the loan interest accruing alongside. Reported leaves the loan
// in your pocket; corrected repays it (and any capital partners) at exit, so the
// gap between the two endpoints is leverage, not profit.

import { useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Inputs } from "@/lib/realestate/defaults";
import { profitTimeline } from "@/lib/realestate/timeline";
import { financingSummary } from "@/lib/realestate/financing";
import { compactInr, cr, lakh, inrToUsd } from "@/lib/realestate/format";
import { Card, Segmented, cx } from "@/components/ui";

const AXIS = {
  stroke: "var(--line)",
  tick: { fill: "var(--mut)", fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const;

type View = "reported" | "corrected";
type Row = { month: number; cum: number; interest: number; stress?: number };

function Tip({
  active,
  payload,
  usdRate,
}: {
  active?: boolean;
  payload?: Array<{ payload?: Row }>;
  usdRate: number;
}) {
  const row = active ? payload?.[0]?.payload : undefined;
  if (!row) return null;
  return (
    <div className="rounded-[var(--radius)] border border-line-strong bg-elevated p-3 text-[13px] shadow-[var(--shadow-lg)]">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-mut">
        Month {row.month}
      </div>
      <div className="nums font-semibold">
        <span className={cx(row.cum >= 0 ? "text-green" : "text-red")}>
          {row.cum >= 0 ? "+" : "−"}
          {cr(Math.abs(row.cum))}
        </span>{" "}
        <span className="text-faint">· {inrToUsd(row.cum, usdRate)}</span>
      </div>
      <div className="text-[11px] text-mut">cumulative position</div>
      <div className="nums mt-1.5 text-[12px] text-amber">{cr(row.interest)} interest paid</div>
    </div>
  );
}

export function ProfitTimeline({ inputs, usdRate }: { inputs: Inputs; usdRate: number }) {
  const [view, setView] = useState<View>("reported");
  const corrected = view === "corrected";
  const t = profitTimeline(inputs, { corrected });

  // Floating-rate stress: the same J-curve recomputed with +2% on the loan rate.
  const floating = inputs.rateType === "floating";
  const STRESS = 0.02;
  const tStress = floating
    ? profitTimeline({ ...inputs, loanRate: inputs.loanRate + STRESS }, { corrected })
    : null;

  const fin = financingSummary(inputs);

  const data: Row[] = t.months.map((m, i) => ({
    month: m,
    cum: t.cumCash[i],
    interest: t.cumInterest[i],
    stress: tStress ? tStress.cumCash[i] : undefined,
  }));

  // Split the J-curve fill/stroke at the zero line: green above, red below.
  // Include the stress curve and y=0 so the axis frames both and the zero line.
  const ys = data.flatMap((d) => (d.stress != null ? [d.cum, d.stress] : [d.cum]));
  const rawMax = Math.max(0, ...ys);
  const rawMin = Math.min(0, ...ys);
  const pad = (rawMax - rawMin) * 0.08 || 1;
  const top = rawMax + pad;
  const bottom = rawMin - pad;
  // The gradient offset must land exactly on y=0, so the YAxis domain is pinned to
  // [bottom, top] (below) and `off` is computed from the SAME bounds — recharts'
  // default "nice" domain would otherwise desync the colour split from the zero line.
  const off = rawMax <= 0 ? 0 : rawMin >= 0 ? 1 : top / (top - bottom);

  return (
    <Card
      title="Profit & interest over time"
      subtitle={
        inputs.repayment === "fullEMI"
          ? `cumulative position — full EMI ${lakh(fin.emi)}/mo · base case`
          : "cumulative position — interest-only carry · base case"
      }
      right={
        <Segmented<View>
          size="sm"
          layoutId="timeline-view"
          value={view}
          onChange={setView}
          options={[
            { value: "reported", label: "Reported" },
            { value: "corrected", label: "Corrected" },
          ]}
        />
      }
    >
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={data} margin={{ top: 14, right: 14, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id="ptlFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset={off} stopColor="var(--green)" stopOpacity={0.32} />
              <stop offset={off} stopColor="var(--red)" stopOpacity={0.32} />
            </linearGradient>
            <linearGradient id="ptlStroke" x1="0" y1="0" x2="0" y2="1">
              <stop offset={off} stopColor="var(--green)" stopOpacity={1} />
              <stop offset={off} stopColor="var(--red)" stopOpacity={1} />
            </linearGradient>
          </defs>

          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            type="number"
            dataKey="month"
            domain={[0, 24]}
            ticks={t.months}
            tickFormatter={(m) => `M${m}`}
            {...AXIS}
          />
          <YAxis domain={[bottom, top]} tickFormatter={(v) => compactInr(Number(v))} width={58} {...AXIS} />
          <Tooltip content={<Tip usdRate={usdRate} />} cursor={{ stroke: "var(--line-strong)" }} />

          <ReferenceLine y={0} stroke="var(--line-strong)" />

          <Area
            type="monotone"
            dataKey="cum"
            baseValue={0}
            stroke="url(#ptlStroke)"
            strokeWidth={2}
            fill="url(#ptlFill)"
            dot={false}
            isAnimationActive={false}
          />
          {floating && (
            <Line
              type="monotone"
              dataKey="stress"
              stroke="var(--faint)"
              strokeWidth={1.25}
              strokeDasharray="2 3"
              dot={false}
              isAnimationActive={false}
            />
          )}
          <Line
            type="monotone"
            dataKey="interest"
            stroke="var(--amber)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={false}
          />

          {t.breakevenMonth != null && (
            <ReferenceLine
              x={t.breakevenMonth}
              stroke="var(--accent)"
              strokeDasharray="3 3"
              label={{
                value: `break-even M${t.breakevenMonth.toFixed(1)}`,
                position: "insideTopRight",
                fill: "var(--accent)",
                fontSize: 10,
              }}
            />
          )}

          {t.peakCapitalAtRisk > 0 && (
            <ReferenceDot
              x={t.months[t.troughIndex]}
              y={t.cumCash[t.troughIndex]}
              r={4}
              fill="var(--red)"
              stroke="var(--card)"
              strokeWidth={2}
            />
          )}

          <ReferenceDot
            x={24}
            y={t.exitValue}
            r={4}
            fill={t.exitValue >= 0 ? "var(--green)" : "var(--red)"}
            stroke="var(--card)"
            strokeWidth={2}
          />
        </ComposedChart>
      </ResponsiveContainer>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-faint">
        <span>
          {/* peak === 0 means the position never dips below zero — "−₹0.00 Cr at M0"
              would read as a real trough, so say what actually happened. */}
          Peak capital at risk{" "}
          {t.peakCapitalAtRisk > 0 ? (
            <>
              <span className="nums font-semibold text-red">−{cr(t.peakCapitalAtRisk)}</span>
              {" "}at M{t.months[t.troughIndex]}
            </>
          ) : (
            <span className="font-semibold text-green">none — never cash-negative</span>
          )}
          {t.breakevenMonth != null && <> · surfaces ~M{t.breakevenMonth.toFixed(1)}</>} · exit{" "}
          <span className={cx("nums font-semibold", t.exitValue >= 0 ? "text-green" : "text-red")}>
            {cr(t.exitValue)}
          </span>
        </span>
        <span className="nums text-amber">{cr(t.totalInterest)} interest paid</span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-faint">
        Cumulative levered cash to your equity. <span className="text-mut">Reported</span> leaves the loan
        in your account; <span className="text-mut">Corrected</span> repays{" "}
        {inputs.repayment === "fullEMI" ? "the balance still owed" : "the loan"} and any capital partners
        at exit — the drop between the two endpoints is leverage, not profit. The trough is the most you
        have at risk at once, and for how long.
        {floating && " Dashed grey traces the curve at +2% on the (floating) loan rate."}
      </p>
    </Card>
  );
}
