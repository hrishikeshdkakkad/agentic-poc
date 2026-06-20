# Construction workspace: categories, copy-to-deals, and actuals

**Date:** 2026-06-17
**Goal:** Make the construction budget a workspace — add/remove/rename categories; copy a deal's budget to other deals; and log real-world ("actual") expenses against the budget (name, description, date, vendor, URL/receipt, amount, status) for planned-vs-actual tracking. Production-ready.

## Decisions

1. **Categories are derived from line items** (no separate list). Add category = append a blank line tagged with the new name; rename = retag all its items; delete = drop its items. The canonical `CONSTRUCTION_CATEGORIES` only supplies default order; user categories sort after.
2. **Copy budget** is a pure `Store` op `copyConstructionBudget(store, sourceId, targetIds)` → deep-clones the source's `constructionExpenses` into each target deal. The hook exposes `copyBudgetTo(targetIds)` which applies it and persists each target via `putDeal` (so other deals' budgets reach Neon).
3. **Actuals live in `inputs.actualExpenses`** (JSONB) — no DB schema / route / serializer change; rides the existing persistence path; the engine never reads them (no parity impact). Normalized + cloned like `constructionExpenses`.
4. **Receipts** are captured as a URL (document link) + a reference/invoice number — binary file upload needs blob storage and is out of scope for the local-DB architecture.

## Data model

```ts
type ActualExpense = {
  id: string;
  name: string;
  description?: string;
  amount: number;        // actual ₹ spent
  date: string;          // ISO YYYY-MM-DD ("" if unset)
  category?: string;     // links to a budget category
  expenseId?: string;    // optional link to a specific budget line item
  vendor?: string;
  method?: string;       // Bank transfer | UPI | Cash | Card | Cheque | Other
  reference?: string;    // invoice / receipt number
  url?: string;          // link to the receipt / invoice document
  status: "paid" | "pending" | "partial";
  createdAt: number;
};
// Inputs gains: actualExpenses: ActualExpense[]
```

## Modules

- `actuals-defaults.ts` (no imports): type, `PAYMENT_METHODS`, `ACTUAL_STATUSES`, `normalizeActualExpenses`, `blankActual`. (defaults.ts imports it.)
- `actuals.ts` (imports model/construction): `actualsTotal`, `plannedVsActual` (per-category budgeted/actual/variance + totals), `actualsForItem`.
- `construction.ts` += `renameCategory`, `removeCategory`, `addCategoryLine` (pure list transforms).
- `deals.ts` += `copyConstructionBudget(store, sourceId, targetIds)`.
- `defaults.ts`: `Inputs.actualExpenses`, `DEFAULTS.actualExpenses=[]`, normalize + clone.
- `use-deals-store.ts`: `actions.copyBudgetTo(ids)` + expose `deals`/`currentId` (already in `store`).

## UI

- `construction-editor.tsx` → tabbed workspace: **Budget** (line items + category rename/add/delete + "Copy to deals…" multiselect) and **Actuals** (rich add/edit form + list + planned-vs-actual rollup).
- `actuals-editor.tsx` (new): the Actuals tab content.
- `construction-panel.tsx`: add a "spent X% of budget" chip when actuals exist.
- `page.tsx`: pass `deals`, `currentId`, `onCopyBudgetTo` to the editor.

## Tests

`actuals.test.ts` (normalize coercion, plannedVsActual math, actualsForItem); extend `construction.test.ts` (renameCategory/removeCategory/addCategoryLine, copyConstructionBudget). Engine parity untouched (actuals ignored by the engine).

## Verification

`tsc --noEmit` + full vitest; live smoke (add/rename/delete category, copy to a deal, log an actual with all fields) persists to Neon; engine numbers unchanged.
