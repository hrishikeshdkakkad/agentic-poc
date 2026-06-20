# Spend Log — Actuals UX Redesign

- **Date:** 2026-06-19
- **Surface:** `dashboard/` → `/real-estate`
- **Status:** Design approved (direction); spec under review
- **Related:** follows the 2026-06-19 actuals↔budget sync + sharpness fix (forecast category-join, `compactInr`/`pctSpent`, blank-row pruning).

## Problem

Real-spend logging ("actuals") is buried as a second tab inside the **Construction budget** drawer, which conflates two different jobs — *planning the budget* vs *tracking real spend*. Three concrete failures:

1. **IA confusion** — "why is actual coming in budgets?" Actuals live under a drawer titled "Construction budget."
2. **No save confidence** — logging is silent 700 ms autosave; the only `SaveStatus` indicator is in the page top bar (`page.tsx:95`), which the drawer covers. There is no explicit Save.
3. **Doesn't scale** — `ActualsEditor` renders `list.map()` of full form-cards: no search, sort, filter, pagination, or virtualization. Unusable past a few dozen entries.

## Goals

- Promote actuals to a **first-class "Spend log"** surface, separate from budget planning.
- An **explicit add/save** flow with unambiguous confirmation; phantom blank rows structurally impossible.
- A **scalable** ledger: search / sort / filter / paginate / export / virtualize.
- Reuse the engine + tested lib unchanged; parity and the 203 existing tests stay green.

## Non-goals (out of scope)

- Per-budget-line (`expenseId`) tracking — actuals join by **category** (prior decision).
- Moving `actualExpenses` out of the deal's JSONB into its own table (only needed at 10k+ rows).
- Receipt upload/storage (we keep the existing receipt **URL** field).
- Any change to the honest engine or its parity-locked numbers.

## Decisions

- **IA:** own surface (user choice). Spend log opens from a **"Spend log (N)"** button in the page header; the Construction budget drawer becomes **pure planning** (Actuals tab removed).
- **Save model:** **draft-then-Save** (Approach A). "+ Add expense" / row-click opens a focused form holding a *draft*; **Save** validates then commits; **Cancel** discards. Nothing is written until Save.
- **Scale ("50k"):** interpreted as *many entries* → the ledger is a `DataCard` (ag-grid: search/filter/sort/paginate/export/virtualize, all built-in). Honest ceiling: actuals are a JSONB array on the single deal row, so the practical limit is JSONB size (ample for a project's spend), not the grid. *(Assumed from "lets go" — flag if you meant a single ₹50k expense.)*
- **Forecast placement:** move `ForecastPanel` (plan-vs-forecast KPIs + EAC-by-category grid) into the Spend log, since it is entirely actuals-derived. The page keeps its headline Plan|Forecast basis toggle. *(Assumed — flag if you want it left on the page.)*

## Architecture & components

**New**

- `components/realestate/spend-log.tsx` — `SpendLog`: the surface. Composes the rollup header, the ledger `DataCard`, the planned-vs-actual table, and `ForecastPanel`. Props: `{ inputs, onChange(patch), status, onRetry }` (+ deals/currentId if needed). Hosts the add/edit form state.
- `components/realestate/expense-form.tsx` — `ExpenseForm`: draft-state form (name, amount, date, status, category, vendor, method, reference, receipt URL, notes). `onSave(expense)` / `onCancel()`. Validates: `amount > 0` **or** a non-empty name; surfaces inline errors; never emits a blank.
- `lib/realestate/actuals.ts` (extend) — `actualsByStatus(list)` → `{ paid, pending, partial }` sums for the rollup line. Pure; TDD.

**Changed**

- `components/realestate/construction-editor.tsx` — remove the `Segmented` tab + `ActualsEditor`; `ConstructionEditor` renders `BudgetTab` directly. Pure planning.
- `app/real-estate/page.tsx` — add the "Spend log (N)" header button (N = `meaningfulActualsCount`) + a second `Drawer` hosting `SpendLog`; relocate `ForecastPanel` into it.
- `components/realestate/actuals-editor.tsx` — retired/folded: its `PvaRollup` rollup logic moves into `SpendLog`; the form-card editor is replaced by the `DataCard` ledger + `ExpenseForm`.

**Reused as-is**

- `DataCard`/`DataGrid` (search, pagination `[25,50,100,200]`, column filters, CSV export, virtualization, row-click), `Drawer` (portal-fixed), `SaveStatus`, `NumberInput`, `Badge`/`Button`/`Field`.
- Tested lib: `plannedVsActual`, `actualsTotal`, `eacByCategory`, `forecast`, `isBlankActual`, `meaningfulActualsCount`, `normalizeActualExpenses`, `compactInr`, `inr`, `pctSpent`.

## Layout

```
Spend log · SMV Layout                                  [ Saved ✓ ]   ✕
Spent ₹4.1L of ₹2.03 Cr · <1% spent   ·  paid ₹3.0L · pending ₹1.1L
                                                       [ + Add expense ]
──────────────────────────────────────────────────────────────────────
🔍 search…     category ▾   status ▾                        ⤓ Export CSV
┌ Date    Name             Category       Vendor   Amount    Status  ⋯
│ 19 Jun  Loan processing  Preliminaries  HDFC     ₹10,000   paid   ✎ 🗑
│ … (DataCard / ag-grid: sortable · filterable · paginated · virtualized)
──────────────────────────────────────────────────────────────────────
Planned vs actual (by category)            budgeted │ actual │ variance
Forecast (EAC by category) …  [moved here from the page]
```

Add/Edit form (focused panel/modal over the drawer):
```
Add expense                                                         ✕
Name [__________]   Amount ₹ [______]   Date [______]   Status [paid ▾]
Category [Preliminaries ▾]   Vendor [______]   Method [UPI ▾]
Reference [______]   Receipt URL [______]   Notes [____________]
                                              [ Cancel ]   [ Save ]
```

## Data flow

1. `ExpenseForm` Save → `onChange({ actualExpenses: [...list, draft] })` (or replace on edit) → `useDealsStore.updateInputs` → debounced `putDeal` → Neon.
2. Save status (`saving → saved → error+retry`) renders in the **Spend log drawer header** via the existing `SaveStatus`.
3. Delete → confirm → `onChange({ actualExpenses: list.filter(...) })`.
4. Money renders via `compactInr`/`inr`; share via `pctSpent`. Category-join everywhere (rollup + forecast already aligned).

## Error handling & edge cases

- **Validation:** block Save unless `amount > 0` or a name is present; inline message; focus the offending field.
- **Save failure:** `SaveStatus` shows error + Retry (store already keeps a per-deal `failed` map).
- **Phantom rows:** impossible — drafts are local until Save; `normalizeActualExpenses` still prunes any legacy blanks on load.
- **Empty state:** ledger shows "No expenses logged yet" + a primary "+ Add expense".
- **Category options:** budget categories + any existing actual categories; "Unassigned" allowed (counts as unbudgeted in forecast).
- **Receipt URL:** render as an "Open ↗" link in a cell/row detail.

## Testing (TDD)

- `actualsByStatus` — paid/pending/partial sums (incl. empty, mixed). **Red→green.**
- `ExpenseForm` validation — rejects blank, accepts amount-only or name-only; Cancel emits nothing.
- Reuse existing green suites (`plannedVsActual`, `eacByCategory`, blank-row hygiene, `pctSpent`).
- Manual/visual: drawer opens from header; add → Saved ✓; search/sort/paginate; budget drawer no longer shows Actuals; parity script + full vitest green.

## Rollout

- Pure refactor of an existing feature; no migration. Existing `actualExpenses` render unchanged in the new ledger. Legacy phantom blank rows self-heal on next load/save (already shipped).
