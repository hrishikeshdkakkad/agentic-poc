"use client";

// Read-only construction-budget breakdown for the main page: total + blended
// per-sqft, spend by category, and the cash-flow-month draw schedule. Pure
// presentation over ./construction; build economics live in the engine.

import type { Inputs } from "@/lib/realestate/defaults";
import {
  constructionByCategory,
  constructionByPhase,
  constructionPerSqft,
  constructionReconciliation,
  constructionTotal,
} from "@/lib/realestate/construction";
import { cr, rate, pctSpent } from "@/lib/realestate/format";
import { actualsTotal } from "@/lib/realestate/actuals";
import { meaningfulActualsCount } from "@/lib/realestate/actuals-defaults";
import { Badge, Button, Card } from "@/components/ui";

export function ConstructionPanel({
  inputs,
  onEdit,
}: {
  inputs: Inputs;
  onEdit: (origin: { x: number; y: number }) => void;
}) {
  const total = constructionTotal(inputs);
  const cats = constructionByCategory(inputs);
  const phases = constructionByPhase(inputs);
  const recon = constructionReconciliation(inputs);
  const itemCount = inputs.constructionExpenses?.length ?? 0;
  const spent = actualsTotal(inputs);
  const hasActuals = meaningfulActualsCount(inputs.actualExpenses ?? []) > 0;
  const maxCat = Math.max(1, ...cats.map((c) => c.amount));
  const maxPhase = Math.max(1, ...phases.map((p) => p.amount));

  return (
    <Card
      title="Construction budget"
      subtitle={`${itemCount} line items · ${cr(total)} · ${rate(constructionPerSqft(inputs))}/sqft`}
      right={
        <div className="flex items-center gap-2">
          {hasActuals && (
            <Badge tone={spent > total ? "red" : spent / total > 0.9 ? "amber" : "green"} dot>
              {pctSpent(total > 0 ? spent / total : 0)} spent
            </Badge>
          )}
          <Badge tone={recon.matched ? "green" : "amber"} dot>
            {recon.matched
              ? "reconciled"
              : `${recon.variance > 0 ? "+" : "−"}${cr(Math.abs(recon.variance))} vs budget`}
          </Badge>
          <Button size="sm" variant="secondary" onClick={(e) => onEdit({ x: e.clientX, y: e.clientY })}>
            Edit budget
          </Button>
        </div>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        {/* spend by category */}
        <div>
          <div className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">
            By category
          </div>
          <div className="space-y-2">
            {cats.map((c) => (
              <div key={c.category}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[12.5px] text-txt">{c.category}</span>
                  <span className="nums shrink-0 text-[11.5px] text-mut">
                    {cr(c.amount)} · {(c.pct * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${(c.amount / maxCat) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* draw schedule by cash-flow month */}
        <div>
          <div className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">
            Draw schedule (by build month)
          </div>
          <div className="flex items-stretch gap-1.5" style={{ height: 130 }}>
            {phases.map((p) => (
              <div key={p.month} className="flex flex-1 flex-col items-center gap-1">
                <span className="nums text-[9px] text-faint">{(p.amount / 1e5).toFixed(0)}</span>
                <div className="flex w-full flex-1 items-end">
                  <div
                    className="w-full rounded-t bg-accent"
                    style={{ height: `${Math.max(4, (p.amount / maxPhase) * 100)}%` }}
                    title={`M${p.month}: ${cr(p.amount)}`}
                  />
                </div>
                <span className="text-[9px] text-faint">M{p.month}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-faint">
            Bars are ₹ lakh per build month, from each line item&apos;s dated month — an informational
            schedule only. The cash-flow model spreads the build evenly across five draws (M6–M18),
            so the J-curve doesn&apos;t move when a line item&apos;s month changes.
          </p>
        </div>
      </div>
    </Card>
  );
}
