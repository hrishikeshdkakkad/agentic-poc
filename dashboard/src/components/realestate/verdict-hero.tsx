"use client";

// The verdict band — the page's single most important statement: the real base
// return on the sponsor's equity, after the loan and any capital partners are
// repaid and the funding gap is bridged. One figure — no reported/levered ghost.

import type { Inputs } from "@/lib/realestate/defaults";
import type { ModelResult } from "@/lib/realestate/model";
import { computeReality } from "@/lib/realestate/reality";
import { cr, pct, mult, rate, inrToUsd } from "@/lib/realestate/format";
import { Badge } from "@/components/ui";

function MiniStat({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">{label}</div>
      <div className="nums mt-1 text-lg font-semibold tracking-tight text-txt">{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-mut">{sub}</div>}
    </div>
  );
}

export function VerdictHero({
  inputs,
  result,
  usdRate,
}: {
  inputs: Inputs;
  result: ModelResult;
  usdRate: number;
}) {
  const r = computeReality(inputs);
  const funded = result.gap <= 0;

  return (
    <section className="relative overflow-hidden rounded-[var(--radius-lg)] border border-line-strong bg-card p-5 shadow-[var(--shadow-sm)] sm:p-6">
      <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-[var(--accent-soft)] blur-3xl" />

      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        {/* the real headline — one figure */}
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-faint">
            Base return <span className="text-mut">· after loan &amp; partners repaid</span>
          </div>
          <div className="nums mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[32px] font-semibold leading-none tracking-tight text-txt sm:text-[40px]">
              {cr(r.dilution.profit)}
            </span>
            <span className="text-[20px] font-semibold leading-none tracking-tight text-accent sm:text-[24px]">
              {mult(r.dilution.roe)}
            </span>
            <span className="text-[13px] text-faint">· {inrToUsd(r.dilution.profit, usdRate)}</span>
          </div>
        </div>

        {/* funding status */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 lg:flex-col lg:items-end">
          <Badge tone={funded ? "green" : "amber"} dot>
            {funded ? "Fully funded" : `Gap ${cr(result.gap)} · ${inrToUsd(result.gap, usdRate)}`}
          </Badge>
          <div className="text-right text-[11px] text-mut">
            Sources <span className="nums text-txt">{cr(result.sources)}</span>{" "}
            <span className="text-faint">· {inrToUsd(result.sources, usdRate)}</span>
          </div>
        </div>
      </div>

      {/* secondary stat strip */}
      <div className="relative mt-6 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-5 sm:grid-cols-3">
        <MiniStat label="Net margin" value={pct(r.dilution.margin)} sub="of revenue" />
        <MiniStat
          label="Breakeven"
          value={`${rate(result.breakeven)}/sqft`}
          sub={`base sale ${rate(inputs.baseSaleRate)}`}
        />
      </div>

      {/* what makes this the real figure */}
      <p className="relative mt-4 text-[12px] leading-relaxed text-mut">
        The real return on your <span className="nums text-txt">{cr(inputs.equity)}</span> equity —
        after the loan and any capital partners are repaid, the funding gap is bridged, and proceeds
        are converted to USD.
      </p>
    </section>
  );
}
