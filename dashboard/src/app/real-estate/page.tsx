"use client";

import { useMemo, useState } from "react";
import { validateInputs, type Inputs } from "@/lib/realestate/defaults";
import { compute, marketUnits, prebuyRevenue, Strategy } from "@/lib/realestate/model";
import { cr, rate } from "@/lib/realestate/format";
import { constructionPerSqft, constructionTotal } from "@/lib/realestate/construction";
import { forecastInputs } from "@/lib/realestate/forecast";
import { meaningfulActualsCount } from "@/lib/realestate/actuals-defaults";
import { costTrace, revenueTrace, netProfitTrace, irrTrace } from "@/lib/realestate/trace";
import { useDealsStore } from "@/lib/realestate/use-deals-store";
import { DealSwitcher } from "@/components/realestate/deal-switcher";
import { VerdictHero } from "@/components/realestate/verdict-hero";
import { Scenarios } from "@/components/realestate/scenarios";
import { Sensitivity } from "@/components/realestate/sensitivity";
import { NetBreakdown } from "@/components/realestate/net-breakdown";
import { CashFlowChart } from "@/components/realestate/cash-flow-chart";
import { ProfitTimeline } from "@/components/realestate/profit-timeline";
import { FinancingCard } from "@/components/realestate/financing-card";
import { InputPanel } from "@/components/realestate/input-panel";
import { ConstructionPanel } from "@/components/realestate/construction-panel";
import { ConstructionEditor } from "@/components/realestate/construction-editor";
import { SpendLog } from "@/components/realestate/spend-log";
import { BaselineBar } from "@/components/realestate/baseline-bar";
import { TraceTree } from "@/components/realestate/provenance-tree";
import { Badge, Button, Card, Drawer, NumberInput, SectionLabel, Segmented, cx, inputCls } from "@/components/ui";
import { IconChevronRight } from "@/components/icons";

type Basis = "plan" | "forecast";

export default function RealEstatePage() {
  const { store, current, hydrated, status, actions } = useDealsStore();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [spendOpen, setSpendOpen] = useState(false);
  const [budgetOrigin, setBudgetOrigin] = useState<{ x: number; y: number } | null>(null);
  const [basis, setBasis] = useState<Basis>("plan");
  const openBudget = (origin: { x: number; y: number }) => {
    setBudgetOrigin(origin);
    setBudgetOpen(true);
  };

  const { inputs, strategy, usdRate } = current;
  const actualsCount = meaningfulActualsCount(inputs.actualExpenses ?? []);
  const inputIssues = useMemo(() => validateInputs(inputs), [inputs]);
  // The analytical panels render on the active basis: the plan inputs, or a
  // forecast budget rebuilt from actuals (committed). Editors always mutate the
  // real plan inputs — viewInputs is a derived, never-persisted view. Memoized so
  // toggling a drawer or editing the FX rate doesn't re-run the whole engine.
  const viewInputs = useMemo(
    () => (basis === "forecast" ? forecastInputs(inputs) : inputs),
    [inputs, basis],
  );
  const result = useMemo(
    () => (inputIssues.length ? null : compute(viewInputs, strategy)),
    [viewInputs, strategy, inputIssues.length],
  );
  // The four provenance trees are pure derivations of viewInputs (each solves or
  // walks the engine), so memoize them rather than rebuilding every render.
  const traces = useMemo(
    () => ({
      cost: costTrace(viewInputs),
      netProfit: netProfitTrace(viewInputs),
      revenue: revenueTrace(viewInputs),
      irr: irrTrace(viewInputs, { corrected: true }),
    }),
    [viewInputs],
  );
  const fixedRevenue = prebuyRevenue(inputs);
  const hasPrebuy = marketUnits(inputs) < inputs.units;

  const onInputChange = (patch: Partial<Inputs>) => actions.updateInputs(patch);
  const onStrategy = (next: Strategy) => actions.setStrategy(next);
  const onUsdRate = (r: number) => actions.setUsdRate(r);

  const subtitle = result
    ? `${inputs.units}-unit · ${result.builtUp.toLocaleString("en-IN")} sqft · build ${rate(constructionPerSqft(inputs))} · sale ${rate(inputs.baseSaleRate)} · breakeven ${rate(result.breakeven)}/sqft`
    : "fix assumptions to compute metrics";

  return (
    <div className="space-y-5">
      {/* top bar: title + switcher (left) · USD rate + edit (right) */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <DealSwitcher
            deals={store.deals}
            currentId={store.currentId}
            onSelect={(id) => actions.select(id)}
            onCreate={() => actions.create("New deal")}
            onRename={(name) => actions.rename(name)}
            onDuplicate={() => actions.duplicate()}
            onDelete={() => actions.remove()}
          />
          <p className="mt-1.5 px-2 text-[13px] text-mut">{subtitle}</p>
        </div>

        <div className="flex items-center gap-3">
          <SaveStatus status={status} hydrated={hydrated} onRetry={() => actions.retry()} />
          <label className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">
            ₹/$
            <NumberInput
              value={usdRate}
              onChange={(n) => onUsdRate(Math.max(1, n))}
              className={cx(inputCls, "w-20 text-right")}
            />
          </label>
          <Button variant="secondary" onClick={() => setSpendOpen(true)}>
            Spend log{actualsCount ? ` (${actualsCount})` : ""}
          </Button>
          <Button variant="primary" onClick={() => setDrawerOpen(true)}>
            Edit assumptions
            <IconChevronRight size={15} />
          </Button>
        </div>
      </div>

      {result ? (
        <>
          {/* current vs the pinned baseline */}
          <BaselineBar
            inputs={viewInputs}
            baseline={current.baseline}
            strategy={strategy}
            onPin={(name) => actions.pinBaseline(name)}
            onClear={() => actions.clearBaseline()}
          />

          {/* basis toggle: plan vs the forecast rebuilt from actuals */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Segmented<Basis>
              layoutId="basis"
              value={basis}
              onChange={setBasis}
              options={[
                { value: "plan", label: "Plan" },
                { value: "forecast", label: "Forecast" },
              ]}
            />
            {basis === "forecast" && (
              <Badge tone="amber" dot>
                Forecast basis · actuals-to-date + remaining budget
              </Badge>
            )}
          </div>

          {/* the verdict — leads with the honest number, on the active basis */}
          <VerdictHero inputs={viewInputs} result={result} usdRate={usdRate} />

          <SectionLabel note="what if the market turns">Downside &amp; sensitivity</SectionLabel>
          <div className="grid gap-4 xl:grid-cols-2">
            <Scenarios inputs={viewInputs} usdRate={usdRate} />
            <Sensitivity inputs={viewInputs} />
          </div>
          <NetBreakdown inputs={viewInputs} usdRate={usdRate} />

          <SectionLabel note="every figure traced to the rupee — expand any line">
            Derivation
          </SectionLabel>
          <div className="grid gap-4 xl:grid-cols-2">
            <Card title="Total cost" subtitle="land + build + contingency + interest carry">
              <TraceTree node={traces.cost} />
            </Card>
            <Card title="Net profit" subtitle="revenue − cost − capital-partner returns">
              <TraceTree node={traces.netProfit} />
            </Card>
            <Card title="Revenue" subtitle="market + bridge + pre-bought units">
              <TraceTree node={traces.revenue} />
            </Card>
            <Card title="Corrected IRR" subtitle="solved on the levered cash-flow series">
              <TraceTree node={traces.irr} defaultOpenDepth={0} />
            </Card>
          </div>

          <SectionLabel note="when money moves, what debt costs">Capital over time</SectionLabel>
          <div className="grid gap-4 xl:grid-cols-2">
            <ProfitTimeline inputs={viewInputs} usdRate={usdRate} />
            <CashFlowChart result={result} usdRate={usdRate} />
          </div>
          <FinancingCard inputs={viewInputs} />

          <SectionLabel note="where the build money goes">Construction budget</SectionLabel>
          <ConstructionPanel inputs={inputs} onEdit={openBudget} />

          <p className="text-[11px] leading-relaxed text-faint">
            Deal assumptions are saved to your database — switch deals from the title bar, edit them
            in the assumptions drawer.{" "}
            {hasPrebuy && (
              <>Pre-bought units are counted at the {cr(fixedRevenue)} their buyers actually pay, not full market.{" "}</>
            )}
            Every figure recomputes live as you move a lever or edit the budget; expand any line in the
            Derivation cards to trace it to the rupee, switch to Forecast to fold in actuals, and pin a
            baseline to measure drift.
          </p>
        </>
      ) : (
        <Card
          title="Deal assumptions need correction"
          subtitle="metrics are blocked to avoid impossible output"
          right={
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => actions.reset()}>
                Reset deal
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setDrawerOpen(true)}>
                Edit assumptions
              </Button>
            </div>
          }
        >
          <ul className="space-y-2 text-[13px] text-amber">
            {inputIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </Card>
      )}

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Assumptions"
        subtitle={current.name}
        width="26rem"
      >
        <InputPanel
          inputs={inputs}
          onChange={onInputChange}
          strategy={strategy}
          onStrategy={onStrategy}
          onReset={() => actions.reset()}
          onEditBudget={(origin) => {
            setDrawerOpen(false);
            openBudget(origin);
          }}
        />
      </Drawer>

      <Drawer
        open={budgetOpen}
        onClose={() => setBudgetOpen(false)}
        title="Construction budget"
        subtitle={`${current.name} · ${cr(constructionTotal(inputs))}`}
        width="min(82rem, 95vw)"
        variant="sheet"
        origin={budgetOrigin}
      >
        <ConstructionEditor
          inputs={inputs}
          onChange={onInputChange}
          deals={store.deals}
          currentId={store.currentId}
          onCopyBudgetTo={(ids) => actions.copyBudgetTo(ids)}
        />
      </Drawer>

      <Drawer
        open={spendOpen}
        onClose={() => setSpendOpen(false)}
        title="Spend log"
        subtitle={current.name}
        width="min(72rem, 95vw)"
        variant="sheet"
      >
        <SpendLog
          inputs={inputs}
          onChange={onInputChange}
          saveSlot={<SaveStatus status={status} hydrated={hydrated} onRetry={() => actions.retry()} />}
        />
      </Drawer>
    </div>
  );
}

function SaveStatus({
  status,
  hydrated,
  onRetry,
}: {
  status: "idle" | "saving" | "saved" | "error";
  hydrated: boolean;
  onRetry: () => void;
}) {
  if (!hydrated) return <span className="text-[11px] text-faint">Loading…</span>;
  if (status === "saving") return <span className="text-[11px] text-faint">Saving…</span>;
  if (status === "saved") return <span className="text-[11px] text-mut">Saved</span>;
  if (status === "error")
    return (
      <button onClick={onRetry} className="text-[11px] font-medium text-amber underline">
        Save failed — Retry
      </button>
    );
  return null;
}
