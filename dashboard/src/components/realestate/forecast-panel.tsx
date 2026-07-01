"use client";

// Plan vs live forecast (Estimate-at-Completion). The forecast runs the SAME
// honest engine on a budget rebuilt from actuals (forecastInputs), so profit /
// ROE / IRR move exactly as committed spend diverges from plan. Below the KPIs,
// an EAC-by-line grid shows where the forecast departs from the budget.

import { useState } from "react";
import type { ColDef } from "ag-grid-community";
import type { Inputs } from "@/lib/realestate/defaults";
import { buildSubtotal } from "@/lib/realestate/model";
import { computeReality } from "@/lib/realestate/reality";
import { forecastInputs, eacByCategory, type ForecastBasis } from "@/lib/realestate/forecast";
import { cr, pct, mult, inr, compactInr } from "@/lib/realestate/format";
import { KpiCard, Card, Segmented, SectionLabel } from "@/components/ui";
import { DataCard, numCol, makeBarCell, ChipCell } from "@/components/data-grid";
import { RupeeDelta } from "@/components/realestate/rs-delta";

type Row = {
  category: string;
  budget: number;
  committed: number;
  eac: number;
  variance: number; // eac − budget
  pctSpent: number; // committed / budget %, capped 999; 999 = unbudgeted/over, 0 = none
  unbudgeted: boolean;
};

const inrFmt = (p: { value: number | null | undefined }) =>
  p.value == null ? "—" : inr(Number(p.value));

export function ForecastPanel({ inputs }: { inputs: Inputs }) {
  const [basis, setBasis] = useState<ForecastBasis>("committed");

  const plan = computeReality(inputs);
  const fcInputs = forecastInputs(inputs, basis);
  const fc = computeReality(fcInputs);
  const planBuild = buildSubtotal(inputs);
  const fcBuild = buildSubtotal(fcInputs);

  // Only categories with real committed spend belong in the EAC grid (budget-only
  // rows would just restate the plan). Σ over the FULL set still reconciles to the
  // forecast build — that invariant is asserted at the lib level, not the view.
  const rows: Row[] = eacByCategory(inputs, basis)
    .filter((r) => r.committed > 0)
    .map((r) => ({
      category: r.category,
      budget: r.budget,
      committed: r.committed,
      eac: r.eac,
      variance: r.eac - r.budget,
      // Unbudgeted committed spend has no budget to be a fraction of — it's entirely
      // over plan, so flag it as over (>100) rather than a tidy 100% on-target bar.
      pctSpent: r.budget > 0 ? Math.min(999, (r.committed / r.budget) * 100) : r.committed > 0 ? 999 : 0,
      unbudgeted: r.unbudgeted,
    }));
  const committedTotal = rows.reduce((s, r) => s + r.committed, 0);

  const cols: ColDef[] = [
    { headerName: "Category", field: "category", cellRenderer: ChipCell, flex: 2, minWidth: 200 },
    { headerName: "Budget", field: "budget", valueFormatter: inrFmt, ...numCol(), width: 130 } as ColDef,
    { headerName: "Committed", field: "committed", valueFormatter: inrFmt, ...numCol(), width: 140 } as ColDef,
    { headerName: "EAC", field: "eac", valueFormatter: inrFmt, ...numCol(), width: 130 } as ColDef,
    {
      headerName: "Variance",
      field: "variance",
      valueFormatter: inrFmt,
      cellClassRules: { "ag-cell-neg": (p) => Number(p.value) > 0, "ag-cell-pos": (p) => Number(p.value) < 0 },
      ...numCol(),
      width: 120,
    } as ColDef,
    { headerName: "Spent", field: "pctSpent", cellRenderer: makeBarCell("pctSpent"), width: 130, sortable: true },
  ];

  return (
    <div className="space-y-4">
      <SectionLabel note="actuals-to-date + remaining budget, run through the same engine">
        Forecast vs plan
      </SectionLabel>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="min-w-0 text-[12px] text-mut">
          Committed so far <span className="nums text-txt">{compactInr(committedTotal)}</span> · build EAC{" "}
          <span className="nums text-txt">{cr(fcBuild)}</span> vs plan{" "}
          <span className="nums text-txt">{cr(planBuild)}</span>
        </p>
        <Segmented<ForecastBasis>
          size="sm"
          layoutId="forecast-basis"
          value={basis}
          onChange={setBasis}
          options={[
            { value: "committed", label: "Committed" },
            { value: "paid", label: "Paid only" },
          ]}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          label="Forecast net profit"
          value={cr(fc.dilution.profit)}
          delta={<RupeeDelta value={fc.dilution.profit - plan.dilution.profit} unit="inr" />}
          footnote={`plan ${cr(plan.dilution.profit)}`}
          accent
        />
        <KpiCard
          label="Forecast ROE"
          value={mult(fc.dilution.roe)}
          delta={<RupeeDelta value={fc.dilution.roe - plan.dilution.roe} unit="x" />}
          footnote={`plan ${mult(plan.dilution.roe)}`}
        />
        <KpiCard
          label="Forecast IRR"
          value={pct(fc.correctedIrr)}
          delta={<RupeeDelta value={fc.correctedIrr - plan.correctedIrr} unit="pct" />}
          footnote={`plan ${pct(plan.correctedIrr)}`}
        />
        <KpiCard
          label="Forecast build cost"
          value={cr(fcBuild)}
          delta={<RupeeDelta value={fcBuild - planBuild} unit="inr" invert />}
          footnote={`plan ${cr(planBuild)}`}
        />
      </div>

      {rows.length > 0 ? (
        <DataCard<Row>
          title="Estimate at completion — by category"
          subtitle={`${rows.length} categories · EAC = max(budget, committed)`}
          rowData={rows}
          columnDefs={cols}
          exportName="eac-by-category"
          countLabel="categories"
          getRowId={(p) => p.data.category}
          height={460}
        />
      ) : (
        <Card title="No actuals logged yet" subtitle="forecast equals the plan until you log expenses">
          <p className="text-[12px] text-faint">
            Log real expenses in the construction budget&rsquo;s Actuals tab and assign each to a
            budget category; the forecast will re-derive profit, ROE and IRR from what you&rsquo;ve
            actually committed plus the remaining budget.
          </p>
        </Card>
      )}
    </div>
  );
}
