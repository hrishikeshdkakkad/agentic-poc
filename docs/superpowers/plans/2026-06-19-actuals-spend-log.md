# Spend Log — Actuals UX Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote real-spend logging out of the Construction budget drawer into a first-class, scalable "Spend log" surface with explicit draft-then-Save.

**Architecture:** A new `SpendLog` drawer (opened from the page header) composes a rollup header, a virtualized `DataCard` ledger, a planned-vs-actual table, and the relocated `ForecastPanel`. Mutations go through a focused `ExpenseForm` holding a local draft committed only on Save. All branching logic lives in pure, TDD-tested lib helpers; the budget drawer reverts to pure planning.

**Tech Stack:** Next.js 16 (React, client components), TypeScript, ag-grid (via existing `DataCard`), Vitest (node env), the real-estate `Inputs` model + `actualExpenses` JSONB.

## Global Constraints

- **Category-join only.** Actuals link to budget **categories**, never `expenseId`. (Prior decision.)
- **Engine untouched.** No edits to `model.ts`/`reality.ts`/`net.ts`/`timeline.ts`; parity-locked numbers must not move.
- **Money formatting:** actual/spent/committed amounts use `compactInr` (or `inr`), never `cr`; spent-share uses `pctSpent`.
- **No new dependencies.** Reuse `DataCard`, `Drawer`, `NumberInput`, `Field`, `Badge`, `Button`, `cx`, `inputCls`.
- **Testing convention (repo):** pure logic is TDD'd with Vitest (node env, no jsdom). Components have **no unit tests**; they are verified by `tsc --noEmit` + `eslint` + `npm run build` + manual smoke. Keep ALL conditional logic in tested helpers so components stay thin wiring.
- **Keep green:** the existing full Vitest suite (203 tests) and `tsc --noEmit` (exit 0) must stay green after every task.
- **Branch:** we are on `main` with the earlier (uncommitted) actuals-sync fix in the tree — Task 0 branches and commits it first.

---

### Task 0: Branch + commit the pending actuals-sync fix

**Files:** none new — commits existing working-tree changes (forecast/actuals-defaults/format + 4 components + 3 test files) and the spec/plan docs.

- [ ] **Step 1: Create a feature branch**

```bash
cd /Users/hrishikeshkakkad/Documents/agentic-poc
git checkout -b feature/spend-log-actuals-ux
```

- [ ] **Step 2: Verify the tree is green before committing**

Run: `cd dashboard && npx vitest run && npx tsc --noEmit`
Expected: `Tests 203 passed (23)`, `tsc` exit 0.

- [ ] **Step 3: Commit the fix + design docs**

```bash
cd /Users/hrishikeshkakkad/Documents/agentic-poc
git add dashboard/src/lib/realestate/forecast.ts dashboard/src/lib/realestate/actuals-defaults.ts dashboard/src/lib/realestate/format.ts \
  dashboard/src/lib/realestate/forecast.test.ts dashboard/src/lib/realestate/actuals.test.ts dashboard/src/lib/realestate/format.test.ts \
  dashboard/src/components/realestate/forecast-panel.tsx dashboard/src/components/realestate/actuals-editor.tsx \
  dashboard/src/components/realestate/construction-editor.tsx dashboard/src/components/realestate/construction-panel.tsx \
  docs/superpowers/specs/2026-06-19-actuals-spend-log-ux-design.md docs/superpowers/plans/2026-06-19-actuals-spend-log.md
git commit -m "fix(real-estate): category-join forecast + sharp actuals formatting + blank-row pruning

Forecast now joins actuals to the budget by category (the only link the UI sets),
so the EAC view agrees with the spent-vs-budget rollup. Small actuals render via
compactInr/pctSpent instead of vanishing to Cr; blank rows are pruned on persist.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1: `actualsByStatus` helper

**Files:**
- Modify: `dashboard/src/lib/realestate/actuals.ts`
- Test: `dashboard/src/lib/realestate/actuals.test.ts`

**Interfaces:**
- Produces: `actualsByStatus(list: readonly ActualExpense[] | undefined): { paid: number; pending: number; partial: number }`

- [ ] **Step 1: Write the failing test**

In `actuals.test.ts`, extend the existing actuals-defaults import to add the type, the `./actuals` import to add `actualsByStatus`, and append this block after the `blank-actual hygiene` describe:

```ts
// add to the existing import from "./actuals":
//   import { actualsTotal, plannedVsActual, actualsForItem, actualsByStatus } from "./actuals";
// add a type import:
import type { ActualExpense } from "./actuals-defaults";

describe("actualsByStatus", () => {
  const a = (status: ActualExpense["status"], amount: number, id: string): ActualExpense =>
    ({ id, name: "x", amount, date: "", status, createdAt: 0 });
  it("sums amounts per status", () => {
    expect(
      actualsByStatus([a("paid", 100, "1"), a("pending", 50, "2"), a("partial", 25, "3"), a("paid", 100, "4")]),
    ).toEqual({ paid: 200, pending: 50, partial: 25 });
  });
  it("defaults to zeros for empty or undefined", () => {
    expect(actualsByStatus([])).toEqual({ paid: 0, pending: 0, partial: 0 });
    expect(actualsByStatus(undefined)).toEqual({ paid: 0, pending: 0, partial: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/lib/realestate/actuals.test.ts -t actualsByStatus`
Expected: FAIL — `actualsByStatus is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `actuals.ts`, widen the actuals-defaults import to include `ActualStatus`, and append:

```ts
// import line becomes:
//   import type { ActualExpense, ActualStatus } from "./actuals-defaults";

export type ActualsStatusTotals = Record<ActualStatus, number>;

/** Σ actual amounts grouped by settlement status (for the spend-log rollup). */
export function actualsByStatus(list: readonly ActualExpense[] | undefined): ActualsStatusTotals {
  const t: ActualsStatusTotals = { paid: 0, pending: 0, partial: 0 };
  for (const a of list ?? []) t[a.status] += a.amount || 0;
  return t;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/lib/realestate/actuals.test.ts`
Expected: PASS (all actuals tests green).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/realestate/actuals.ts dashboard/src/lib/realestate/actuals.test.ts
git commit -m "feat(real-estate): actualsByStatus rollup helper"
```

---

### Task 2: `filterActuals` helper

**Files:**
- Modify: `dashboard/src/lib/realestate/actuals.ts`
- Test: `dashboard/src/lib/realestate/actuals.test.ts`

**Interfaces:**
- Consumes: `ActualExpense`, `ActualStatus` from `./actuals-defaults`.
- Produces: `filterActuals(list: readonly ActualExpense[], f: { category?: string; status?: ActualStatus | "all" }): ActualExpense[]` — `"all"`/empty passes through; missing category matches `"Unassigned"`.

- [ ] **Step 1: Write the failing test**

Append to `actuals.test.ts` (add `filterActuals` to the `./actuals` import):

```ts
describe("filterActuals", () => {
  const rows: ActualExpense[] = [
    { id: "1", name: "a", amount: 1, date: "", status: "paid", category: "Electrical", createdAt: 0 },
    { id: "2", name: "b", amount: 1, date: "", status: "pending", category: "Plumbing & sanitary", createdAt: 0 },
    { id: "3", name: "c", amount: 1, date: "", status: "paid", createdAt: 0 }, // no category → Unassigned
  ];
  it("passes everything through on 'all'/empty", () => {
    expect(filterActuals(rows, { category: "all", status: "all" })).toHaveLength(3);
    expect(filterActuals(rows, {})).toHaveLength(3);
  });
  it("filters by category, treating missing category as Unassigned", () => {
    expect(filterActuals(rows, { category: "Electrical" }).map((r) => r.id)).toEqual(["1"]);
    expect(filterActuals(rows, { category: "Unassigned" }).map((r) => r.id)).toEqual(["3"]);
  });
  it("filters by status", () => {
    expect(filterActuals(rows, { status: "pending" }).map((r) => r.id)).toEqual(["2"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/lib/realestate/actuals.test.ts -t filterActuals`
Expected: FAIL — `filterActuals is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `actuals.ts`:

```ts
/** Pre-filter the ledger by category and/or status before it reaches the grid.
 * Free-text search is handled by the DataCard quick filter, not here. */
export function filterActuals(
  list: readonly ActualExpense[],
  f: { category?: string; status?: ActualStatus | "all" },
): ActualExpense[] {
  return list.filter((x) => {
    if (f.category && f.category !== "all" && (x.category || "Unassigned") !== f.category) return false;
    if (f.status && f.status !== "all" && x.status !== f.status) return false;
    return true;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/lib/realestate/actuals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/realestate/actuals.ts dashboard/src/lib/realestate/actuals.test.ts
git commit -m "feat(real-estate): filterActuals (category/status) helper"
```

---

### Task 3: `PlannedVsActual` component (extract from actuals-editor)

**Files:**
- Create: `dashboard/src/components/realestate/planned-vs-actual.tsx`

**Interfaces:**
- Consumes: `plannedVsActual` (type), `compactInr`, `pctSpent`, `cx`.
- Produces: `<PlannedVsActual pva={ReturnType<typeof plannedVsActual>} />`.

- [ ] **Step 1: Create the component**

```tsx
"use client";

// Per-category budgeted-vs-actual table for the Spend log. Pure presentation over
// plannedVsActual; money renders sharp via compactInr (small actuals stay visible).

import type { plannedVsActual } from "@/lib/realestate/actuals";
import { compactInr } from "@/lib/realestate/format";
import { cx } from "@/components/ui";

export function PlannedVsActual({ pva }: { pva: ReturnType<typeof plannedVsActual> }) {
  const rows = pva.rows.filter((r) => r.actual > 0);
  return (
    <div className="rounded-[var(--radius)] border border-line bg-card p-4">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">
        Planned vs actual (by category)
      </div>
      {rows.length ? (
        <div className="overflow-hidden rounded-[var(--radius-sm)] border border-line">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="bg-surface text-left text-mut">
                <th className="px-3 py-1.5 font-medium">Category</th>
                <th className="px-3 py-1.5 text-right font-medium">Budgeted</th>
                <th className="px-3 py-1.5 text-right font-medium">Actual</th>
                <th className="px-3 py-1.5 text-right font-medium">Variance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.category} className="border-t border-line">
                  <td className="px-3 py-1.5 text-txt">{r.category}</td>
                  <td className="nums px-3 py-1.5 text-right text-mut">{compactInr(r.budgeted)}</td>
                  <td className="nums px-3 py-1.5 text-right text-txt">{compactInr(r.actual)}</td>
                  <td
                    className={cx(
                      "nums px-3 py-1.5 text-right font-medium",
                      r.variance > 0 ? "text-red" : "text-green",
                    )}
                  >
                    {r.variance > 0 ? "+" : ""}
                    {compactInr(r.variance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-[12px] text-faint">No actuals logged against budget categories yet.</div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `cd dashboard && npx tsc --noEmit && npx eslint src/components/realestate/planned-vs-actual.tsx`
Expected: `tsc` exit 0; eslint reports no errors for this file.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/realestate/planned-vs-actual.tsx
git commit -m "feat(real-estate): PlannedVsActual table component"
```

---

### Task 4: `ExpenseForm` component (draft-then-Save)

**Files:**
- Create: `dashboard/src/components/realestate/expense-form.tsx`

**Interfaces:**
- Consumes: `ACTUAL_STATUSES`, `PAYMENT_METHODS`, `blankActual`, `isBlankActual`, `ActualExpense`, `ActualStatus` from `@/lib/realestate/actuals-defaults`; `Button`, `Field`, `inputCls`, `NumberInput`, `cx` from `@/components/ui`.
- Produces: `<ExpenseForm initial?={ActualExpense} categories={string[]} onSave={(e: ActualExpense) => void} onCancel={() => void} />`. Holds a local draft; `onSave` fires only when valid (`!isBlankActual`).

- [ ] **Step 1: Create the component**

```tsx
"use client";

// Focused add/edit form for a single logged expense. Holds a DRAFT in local state;
// nothing is emitted until Save (and Save is blocked while the draft is blank), so
// abandoned/cancelled entries never reach the deal — no phantom rows by construction.

import { useState } from "react";
import {
  ACTUAL_STATUSES,
  PAYMENT_METHODS,
  blankActual,
  isBlankActual,
  type ActualExpense,
  type ActualStatus,
} from "@/lib/realestate/actuals-defaults";
import { Button, Field, inputCls, NumberInput, cx } from "@/components/ui";

export function ExpenseForm({
  initial,
  categories,
  onSave,
  onCancel,
}: {
  initial?: ActualExpense;
  categories: string[];
  onSave: (e: ActualExpense) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ActualExpense>(initial ?? blankActual(categories[0]));
  const set = <K extends keyof ActualExpense>(k: K, v: ActualExpense[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const error = isBlankActual(draft) ? "Add an amount or a name before saving." : null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Field label="Name" className="col-span-2 sm:col-span-3">
          <input
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. TMT steel — order 1"
            className={cx(inputCls, "w-full py-1.5")}
            autoFocus
          />
        </Field>
        <Field label="Amount ₹">
          <NumberInput value={draft.amount} onChange={(n) => set("amount", n)} className={cx(inputCls, "w-full py-1.5 text-right")} />
        </Field>
        <Field label="Date">
          <input type="date" value={draft.date} onChange={(e) => set("date", e.target.value)} className={cx(inputCls, "w-full py-1.5")} />
        </Field>
        <Field label="Status">
          <select value={draft.status} onChange={(e) => set("status", e.target.value as ActualStatus)} className={cx(inputCls, "w-full py-1.5")}>
            {ACTUAL_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Category">
          <select value={draft.category ?? ""} onChange={(e) => set("category", e.target.value)} className={cx(inputCls, "w-full py-1.5")}>
            <option value="">Unassigned</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
            {draft.category && !categories.includes(draft.category) && <option value={draft.category}>{draft.category}</option>}
          </select>
        </Field>
        <Field label="Vendor / paid to">
          <input value={draft.vendor ?? ""} onChange={(e) => set("vendor", e.target.value)} className={cx(inputCls, "w-full py-1.5")} />
        </Field>
        <Field label="Method">
          <select value={draft.method ?? ""} onChange={(e) => set("method", e.target.value)} className={cx(inputCls, "w-full py-1.5")}>
            <option value="">—</option>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </Field>
        <Field label="Reference / invoice #">
          <input value={draft.reference ?? ""} onChange={(e) => set("reference", e.target.value)} className={cx(inputCls, "w-full py-1.5")} />
        </Field>
        <Field label="Receipt / invoice URL" className="col-span-2 sm:col-span-3">
          <input value={draft.url ?? ""} onChange={(e) => set("url", e.target.value)} placeholder="https://…" className={cx(inputCls, "w-full py-1.5")} />
        </Field>
        <Field label="Notes" className="col-span-2 sm:col-span-3">
          <textarea value={draft.description ?? ""} onChange={(e) => set("description", e.target.value)} rows={2} className={cx(inputCls, "w-full py-1.5")} />
        </Field>
      </div>
      <div className="flex items-center justify-end gap-2">
        {error && <span className="mr-auto text-[11px] text-mut">{error}</span>}
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={!!error} onClick={() => onSave(draft)}>Save</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `cd dashboard && npx tsc --noEmit && npx eslint src/components/realestate/expense-form.tsx`
Expected: `tsc` exit 0; eslint no errors for this file.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/realestate/expense-form.tsx
git commit -m "feat(real-estate): ExpenseForm draft-then-save"
```

---

### Task 5: `SpendLog` surface component

**Files:**
- Create: `dashboard/src/components/realestate/spend-log.tsx`

**Interfaces:**
- Consumes: `actualsByStatus`, `filterActuals`, `plannedVsActual` (`@/lib/realestate/actuals`); `constructionByCategory`; `compactInr`, `pctSpent`; `fmtDate` (`@/lib/format`); `DataCard`, `numCol` (`@/components/data-grid`); `ForecastPanel`, `PlannedVsActual`, `ExpenseForm`; `ACTUAL_STATUSES`, `ActualExpense`, `ActualStatus`.
- Produces: `<SpendLog inputs={Inputs} onChange={(patch: Partial<Inputs>) => void} saveSlot?={React.ReactNode} />`.

- [ ] **Step 1: Create the component**

```tsx
"use client";

// First-class Spend log: rollup header + a virtualized DataCard ledger + planned-
// vs-actual + the relocated forecast. Add/edit go through ExpenseForm in a portal
// modal; only Save mutates the deal. Filters use pure filterActuals; free-text is
// the DataCard quick filter.

import { useEffect, useMemo, useState } from "react";
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
  const list = inputs.actualExpenses ?? [];
  const categories = useMemo(() => constructionByCategory(inputs).map((c) => c.category), [inputs]);
  const pva = plannedVsActual(inputs);
  const byStatus = actualsByStatus(list);

  const [catFilter, setCatFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<ActualStatus | "all">("all");
  const [editing, setEditing] = useState<ActualExpense | "new" | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

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
            <Button variant="primary" onClick={() => setEditing("new")}>+ Add expense</Button>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Category">
            <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)} className={cx(inputCls, "py-1.5")}>
              <option value="all">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
              <option value="Unassigned">Unassigned</option>
            </select>
          </Field>
          <Field label="Status">
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as ActualStatus | "all")} className={cx(inputCls, "py-1.5")}>
              <option value="all">All statuses</option>
              {ACTUAL_STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </Field>
        </div>

        {list.length === 0 ? (
          <div className="rounded-[var(--radius)] border border-dashed border-line p-8 text-center">
            <div className="text-[13px] font-medium text-txt">No expenses logged yet</div>
            <div className="mt-1 text-[12px] text-mut">Record real spend against the budget to track planned vs actual.</div>
            <Button variant="secondary" onClick={() => setEditing("new")} className="mt-3">Log your first expense</Button>
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

      {mounted &&
        editing &&
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
```

- [ ] **Step 2: Typecheck + lint**

Run: `cd dashboard && npx tsc --noEmit && npx eslint src/components/realestate/spend-log.tsx`
Expected: `tsc` exit 0; eslint no errors for this file.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/realestate/spend-log.tsx
git commit -m "feat(real-estate): SpendLog surface (ledger + rollup + forecast + form)"
```

---

### Task 6: Wire into the page; strip the budget Actuals tab; delete actuals-editor

**Files:**
- Modify: `dashboard/src/app/real-estate/page.tsx`
- Modify: `dashboard/src/components/realestate/construction-editor.tsx`
- Delete: `dashboard/src/components/realestate/actuals-editor.tsx`

**Interfaces:**
- Consumes: `SpendLog` (Task 5), `meaningfulActualsCount` (`@/lib/realestate/actuals-defaults`).

- [ ] **Step 1: Strip the Actuals tab from `construction-editor.tsx`**

Replace the import block lines (the `actuals-defaults` import added in the prior fix + the `ActualsEditor` import + the `Segmented` member of the ui import) and the tabbed `ConstructionEditor` body. Specifically:

Remove these two import lines:
```tsx
import { meaningfulActualsCount } from "@/lib/realestate/actuals-defaults";
import { ActualsEditor } from "@/components/realestate/actuals-editor";
```
Change the ui import to drop `Segmented`:
```tsx
import { Badge, Button, NumberInput, inputCls, cx } from "@/components/ui";
```
Replace the whole `ConstructionEditor` function (the one with `const [tab, setTab]` … through its closing `}`) with:
```tsx
export function ConstructionEditor({
  inputs,
  onChange,
  deals,
  currentId,
  onCopyBudgetTo,
}: {
  inputs: Inputs;
  onChange: (patch: Partial<Inputs>) => void;
  deals: Deal[];
  currentId: string;
  onCopyBudgetTo: (ids: string[]) => void;
}) {
  // The construction drawer is now pure planning — real spend lives in the Spend log.
  return (
    <BudgetTab inputs={inputs} onChange={onChange} deals={deals} currentId={currentId} onCopyBudgetTo={onCopyBudgetTo} />
  );
}
```

- [ ] **Step 2: Delete the dead editor**

```bash
git rm dashboard/src/components/realestate/actuals-editor.tsx
```

- [ ] **Step 3: Wire `SpendLog` into `page.tsx`**

(a) Imports — remove the ForecastPanel import (it now lives inside SpendLog) and add SpendLog + the count helper:
```tsx
// delete:
//   import { ForecastPanel } from "@/components/realestate/forecast-panel";
// add:
import { SpendLog } from "@/components/realestate/spend-log";
import { meaningfulActualsCount } from "@/lib/realestate/actuals-defaults";
```
(b) State — add beside the other `useState` declarations (after line 33 `const [budgetOpen, …]`):
```tsx
const [spendOpen, setSpendOpen] = useState(false);
```
(c) Count — after `const { inputs, strategy, usdRate } = current;`:
```tsx
const actualsCount = meaningfulActualsCount(inputs.actualExpenses ?? []);
```
(d) Header button — in the top-bar action group, immediately before the `Edit assumptions` `<Button>`:
```tsx
<Button variant="secondary" onClick={() => setSpendOpen(true)}>
  Spend log{actualsCount ? ` (${actualsCount})` : ""}
</Button>
```
(e) Remove the page-level forecast panel — delete this line:
```tsx
<ForecastPanel inputs={inputs} />
```
(f) Add the Spend log Drawer — immediately after the closing `</Drawer>` of the Construction budget drawer (after line 250):
```tsx
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
```

- [ ] **Step 4: Typecheck, full suite, lint**

Run:
```bash
cd dashboard && npx tsc --noEmit && npx vitest run && npx eslint src/app/real-estate/page.tsx src/components/realestate/construction-editor.tsx src/components/realestate/spend-log.tsx
```
Expected: `tsc` exit 0; Vitest all green (≥208 tests); eslint reports no NEW errors (the two pre-existing `construction-editor.tsx` warnings at the `useMemo`/`useEffect` are unchanged and acceptable).

- [ ] **Step 5: Production build**

Run: `cd dashboard && npm run build`
Expected: build completes (exit 0). If it needs env vars locally, note it and rely on tsc+vitest as the gate.

- [ ] **Step 6: Manual smoke (browser)**

- `/real-estate` header shows **"Spend log (N)"**; click → drawer opens.
- "+ Add expense" → form modal → fill amount + name → **Save** → row appears in the ledger; header shows **Saved**; "Spent vs budget" updates with sharp ₹ (e.g. ₹10,000, "<1% spent").
- Click a row → edit → Save updates it; Delete removes it.
- Search/sort/paginate the ledger; category/status filters narrow it.
- Open **Edit budget** → the **Actuals tab is gone** (planning only).

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/app/real-estate/page.tsx dashboard/src/components/realestate/construction-editor.tsx
git commit -m "feat(real-estate): first-class Spend log; budget drawer is planning-only"
```

---

## Self-Review

**Spec coverage:**
- Own-surface IA → Task 5 (`SpendLog`) + Task 6 (header button, drawer, strip Actuals tab). ✓
- Draft-then-Save + no phantom rows → Task 4 (`ExpenseForm`, `isBlankActual` gate; draft local until Save). ✓
- Scale (search/sort/filter/paginate/export/virtualize) → Task 5 `DataCard` + Task 2 `filterActuals`. ✓
- Save feedback in the drawer → Task 6 `saveSlot={<SaveStatus…/>}`. ✓
- Status rollup → Task 1 `actualsByStatus`. ✓
- Forecast relocated → Task 5 renders `ForecastPanel`; Task 6 removes it from the page. ✓
- Sharp money/percent → `compactInr`/`pctSpent` throughout. ✓
- Engine untouched / keep-green → no engine files; Task 6 runs the full suite. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `actualsByStatus → Record<ActualStatus, number>`; `filterActuals(list, {category?, status?: ActualStatus|"all"})`; `ExpenseForm` props and `SpendLog` `save/remove` use `ActualExpense.id` (string) consistently; `SpendLog` passes `pva` to `PlannedVsActual` matching `ReturnType<typeof plannedVsActual>`. ✓
