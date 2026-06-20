# Comprehensive construction expenses for /real-estate

**Date:** 2026-06-17
**Goal:** Replace the coarse build-cost inputs (`constructionRate`/`extrasRate`) with an insanely comprehensive, itemized construction-expense breakdown — in the data model, engine, UI, and persistence — structured for later agentic computation, and get `/real-estate` production-ready.

## Problem

Build cost is a single blended figure: `buildSubtotal = (constructionRate + extrasRate) × builtUp`. There's no line-item visibility (what the ₹2.05 Cr build actually buys), no cash-flow timing per item, and nothing an agent can reason over ("which category is over-budget? what hits in M6?").

## Decisions

1. **Itemized expenses become the build-cost source of truth.** New `Inputs.constructionExpenses: ConstructionExpense[]`. `buildSubtotal(i)` derives from `Σ amounts` when present, else falls back to the coarse formula. Editing line items drives the economics.
2. **Parity is preserved by construction.** The default SMV itemization is an exact **decomposition of ₹2,05,20,000** (= the current `(2250+600)×7200`). So `totalCost` stays `59,626,000` and `engine.test.ts` passes unchanged. A test asserts `Σ(DEFAULT_CONSTRUCTION_EXPENSES) === 20_520_000`.
3. **Migration scales, never shifts.** `normalizeConstructionExpenses` injects the template scaled to each deal's coarse build subtotal when a deal has no items — so existing deals keep their exact economics while gaining the breakdown. User-edited items are kept as-is (validated).
4. **`contingencyPct` and the coarse rates stay.** Contingency remains a separate % on `buildSubtotal`. `constructionRate`/`extrasRate` are retained as the sensitivity-grid axis basis and the fallback; they're no longer the primary editor.
5. **Cash-flow timing per item.** Each expense carries a `month` on the CF grid (0,3,…,24) — used now for a by-phase breakdown and later for timeline integration + agentic computation.

## Data model

```ts
type ConstructionExpense = {
  id: string;
  category: string;   // one of CONSTRUCTION_CATEGORIES
  item: string;
  qty: number;        // descriptive (0/1 when lumpsum)
  unit: string;       // sqft|cum|kg|MT|nos|rmt|point|lumpsum|...
  rate: number;       // ₹/unit (descriptive)
  amount: number;     // ₹ — AUTHORITATIVE total
  month: number;      // CF grid month incurred (0,3,…,24)
  notes?: string;
};
```

18 categories (preliminaries, professional & approvals, earthwork & substructure, RCC concrete / reinforcement / formwork, masonry, plastering, waterproofing, flooring & tiling, doors & windows, plumbing & sanitary, electrical, painting, kitchen & joinery, railings & metalwork, external & site development, miscellaneous), ~114 line items, summing to exactly **₹2,05,20,000**.

## Engine integration (surgical)

- `model.ts`: add `constructionExpensesTotal(i)`; change `buildSubtotal` to derive from it when `constructionExpenses?.length`. Everything else (contingency, totalCost, sensitivity, netFlows) unchanged.
- New `construction.ts` (pure): `constructionTotal`, `byCategory`, `byPhase`, `perSqft`, `reconciliation(i)` (itemized vs coarse build subtotal), validation helpers — the agentic-ready aggregations.
- `defaults.ts`: `Inputs.constructionExpenses`, `DEFAULTS` includes the template, `normalizeConstructionExpenses` (coerce + scale-on-inject), `cloneInputs` deep-clones the array.

## UI

- **Input drawer → Build section:** replace the 3 rate fields with an itemized editor grouped by category (add/edit/delete line items: item, qty, unit, rate, amount, month), keep `contingencyPct`.
- **Main page:** new `construction-panel.tsx` — total + per-sqft, a by-category bar breakdown, a by-phase (month) strip, and a reconciliation badge (itemized vs build budget). Placed under a new "CONSTRUCTION BUDGET" `SectionLabel`.
- Subtitle build figure becomes derived (`buildSubtotal/builtUp`).

## Persistence

No DB schema change — `constructionExpenses` rides inside the existing `inputs` JSONB. Migration to Neon already proven; this just adds a key.

## Non-goals (explicitly later)

- Agentic computation/optimization over the line items (this lays the structured groundwork).
- Re-coupling the sensitivity grid axis to the itemized total (kept coarse for now).

## Verification

- `Σ(DEFAULT_CONSTRUCTION_EXPENSES) === 20_520_000`; `engine.test.ts` green unchanged (parity); new `construction.test.ts` green; `npm run build` + full vitest; persistence round-trips the new field; manual smoke on `/real-estate`.
