"use client";

// Pin a named baseline (an "approved" snapshot of the inputs) and see the live
// deal measured against it — headline-metric deltas plus the budget categories
// that moved. The baseline persists on the deal (sibling JSONB column).

import { useState } from "react";
import type { Baseline } from "@/lib/realestate/deals";
import type { Inputs } from "@/lib/realestate/defaults";
import type { Strategy } from "@/lib/realestate/model";
import { compareMetrics, compareBudget, type MetricDelta } from "@/lib/realestate/compare";
import { cr, pct, mult, rate } from "@/lib/realestate/format";
import { Button, Card, cx, inputCls } from "@/components/ui";
import { RupeeDelta } from "@/components/realestate/rs-delta";

const fmt = (m: MetricDelta) =>
  m.unit === "pct" ? pct(m.current) : m.unit === "x" ? mult(m.current) : m.unit === "rate" ? rate(m.current) : cr(m.current);

function PinForm({ onPin }: { onPin: (name: string) => void }) {
  const [name, setName] = useState("Approved budget");
  return (
    <Card
      title="No baseline pinned"
      subtitle="pin the current assumptions to measure drift against an approved case"
      right={
        <div className="flex items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Baseline name"
            className={cx(inputCls, "w-44")}
          />
          <Button variant="primary" size="sm" onClick={() => onPin(name.trim() || "Baseline")}>
            Pin baseline
          </Button>
        </div>
      }
    >
      <p className="text-[12px] text-faint">
        Once pinned, every headline metric and budget category shows current vs the baseline, so you
        can see exactly how far the live deal has drifted.
      </p>
    </Card>
  );
}

export function BaselineBar({
  inputs,
  baseline,
  strategy,
  onPin,
  onClear,
}: {
  inputs: Inputs;
  baseline: Baseline | undefined;
  strategy: Strategy;
  onPin: (name: string) => void;
  onClear: () => void;
}) {
  if (!baseline) return <PinForm onPin={onPin} />;

  const metrics = compareMetrics(inputs, baseline.inputs, strategy);
  const budgetMoves = compareBudget(inputs, baseline.inputs).filter((b) => b.delta !== 0);
  const pinned = new Date(baseline.pinnedAt).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  return (
    <Card
      title={`vs baseline · ${baseline.name}`}
      subtitle={`pinned ${pinned} · current measured against the approved snapshot`}
      right={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => onPin(baseline.name)}>
            Re-pin to current
          </Button>
          <Button size="sm" variant="secondary" onClick={onClear}>
            Clear
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
        {metrics.map((m) => (
          <div key={m.key} className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">
              {m.label}
            </div>
            <div className="nums mt-1 text-[15px] font-semibold tracking-tight text-txt">{fmt(m)}</div>
            <div className="mt-1">
              {m.delta === 0 ? (
                <span className="text-[11px] text-faint">unchanged</span>
              ) : (
                <RupeeDelta value={m.delta} unit={m.unit} invert={m.lowerIsBetter} />
              )}
            </div>
          </div>
        ))}
      </div>

      {budgetMoves.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">
            Budget moves ({budgetMoves.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {budgetMoves.map((b) => (
              <span
                key={b.category}
                className={cx(
                  "nums rounded-full border px-2.5 py-1 text-[11px] font-medium",
                  b.delta > 0 ? "border-line text-red" : "border-line text-green",
                )}
                title={`${b.category}: ${cr(b.baseline)} → ${cr(b.current)}`}
              >
                {b.category} {b.delta > 0 ? "+" : "−"}
                {cr(Math.abs(b.delta))}
              </span>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
