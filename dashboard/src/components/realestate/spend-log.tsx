"use client";

// First-class Spend log: rollup header + a virtualized DataCard ledger + planned-
// vs-actual + the relocated forecast. Add/edit go through ExpenseForm in a portal
// modal; only Save mutates the deal. Filters use pure filterActuals; free-text is
// the DataCard quick filter.

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ColDef } from "ag-grid-community";
import type { Inputs } from "@/lib/realestate/defaults";
import { ACTUAL_STATUSES, type ActualExpense, type ActualStatus } from "@/lib/realestate/actuals-defaults";
import { actualsByStatus, filterActuals, plannedVsActual } from "@/lib/realestate/actuals";
import { constructionByCategory } from "@/lib/realestate/construction";
import { compactInr, pctSpent } from "@/lib/realestate/format";
import { fmtDate } from "@/lib/format";
import { Badge, Button, Field, inputCls, cx } from "@/components/ui";
import { DataCard, numCol } from "@/components/data-grid";
import { ForecastPanel } from "@/components/realestate/forecast-panel";
import { PlannedVsActual } from "@/components/realestate/planned-vs-actual";
import { ExpenseForm } from "@/components/realestate/expense-form";

export function SpendLog({
  inputs,
  onChange,
  saveSlot,
}: {
  inputs: Inputs;
  onChange: (patch: Partial<Inputs>) => void;
  saveSlot?: React.ReactNode;
}) {
  const list = useMemo(() => inputs.actualExpenses ?? [], [inputs.actualExpenses]);
  const categories = useMemo(() => constructionByCategory(inputs).map((c) => c.category), [inputs]);
  const pva = plannedVsActual(inputs);
  const byStatus = actualsByStatus(list);

  const [catFilter, setCatFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<ActualStatus | "all">("all");
  const [editing, setEditing] = useState<ActualExpense | "new" | null>(null);

  const rows = useMemo(
    () => filterActuals(list, { category: catFilter, status: statusFilter }),
    [list, catFilter, statusFilter],
  );

  const save = (e: ActualExpense) => {
    const exists = list.some((a) => a.id === e.id);
    onChange({ actualExpenses: exists ? list.map((a) => (a.id === e.id ? e : a)) : [...list, e] });
    setEditing(null);
  };
  const remove = (id: string) => {
    onChange({ actualExpenses: list.filter((a) => a.id !== id) });
    setEditing(null);
  };

  const cols: ColDef[] = [
    { headerName: "Date", field: "date", width: 120, valueFormatter: (p) => (p.value ? fmtDate(String(p.value)) : "—") },
    { headerName: "Name", field: "name", flex: 2, minWidth: 160 },
    { headerName: "Category", field: "category", flex: 1, minWidth: 150, valueFormatter: (p) => (p.value ? String(p.value) : "Unassigned") },
    { headerName: "Vendor", field: "vendor", flex: 1, minWidth: 120 },
    { headerName: "Amount", field: "amount", valueFormatter: (p) => compactInr(Number(p.value)), ...numCol(), width: 120 } as ColDef,
    { headerName: "Status", field: "status", width: 110 },
  ];

  return (
    <div className="space-y-5">
      <div className="rounded-[var(--radius)] border border-line bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">Spent vs budget</div>
            <div className="nums mt-0.5 text-lg font-semibold text-txt">
              {compactInr(pva.totalActual)} <span className="text-[12px] font-normal text-mut">of {compactInr(pva.totalBudget)}</span>
            </div>
            <div className="mt-0.5 text-[11px] text-mut">
              paid {compactInr(byStatus.paid)} · pending {compactInr(byStatus.pending)} · partial {compactInr(byStatus.partial)}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {saveSlot}
            <Badge
              tone={pva.totalActual > pva.totalBudget ? "red" : pva.totalBudget > 0 && pva.totalActual / pva.totalBudget > 0.9 ? "amber" : "green"}
              dot
            >
              {pctSpent(pva.totalBudget > 0 ? pva.totalActual / pva.totalBudget : 0)} spent
            </Badge>
            <Button variant="primary" onClick={() => setEditing("new")}>
              + Add expense
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Category">
            <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)} className={cx(inputCls, "py-1.5")}>
              <option value="all">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value="Unassigned">Unassigned</option>
            </select>
          </Field>
          <Field label="Status">
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as ActualStatus | "all")} className={cx(inputCls, "py-1.5")}>
              <option value="all">All statuses</option>
              {ACTUAL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {list.length === 0 ? (
          <div className="rounded-[var(--radius)] border border-dashed border-line p-8 text-center">
            <div className="text-[13px] font-medium text-txt">No expenses logged yet</div>
            <div className="mt-1 text-[12px] text-mut">Record real spend against the budget to track planned vs actual.</div>
            <Button variant="secondary" onClick={() => setEditing("new")} className="mt-3">
              Log your first expense
            </Button>
          </div>
        ) : (
          <DataCard<ActualExpense>
            title="Spend log"
            rowData={rows}
            columnDefs={cols}
            exportName="spend-log"
            countLabel="expenses"
            getRowId={(p) => p.data.id}
            onRowClicked={(e) => setEditing(e.data)}
            height={420}
          />
        )}
      </div>

      <PlannedVsActual pva={pva} />
      <ForecastPanel inputs={inputs} />

      {editing &&
        createPortal(
          <div
            className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
            onClick={() => setEditing(null)}
          >
            <div
              className="w-full max-w-2xl rounded-[var(--radius-lg)] border border-line bg-card p-5 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-3 flex items-center justify-between">
                <div className="text-[13px] font-semibold text-txt">{editing === "new" ? "Add expense" : "Edit expense"}</div>
                {editing !== "new" && (
                  <button onClick={() => remove(editing.id)} className="text-[11px] font-medium text-mut transition-colors hover:text-red">
                    Delete
                  </button>
                )}
              </div>
              <ExpenseForm
                initial={editing === "new" ? undefined : editing}
                categories={categories}
                onSave={save}
                onCancel={() => setEditing(null)}
              />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
