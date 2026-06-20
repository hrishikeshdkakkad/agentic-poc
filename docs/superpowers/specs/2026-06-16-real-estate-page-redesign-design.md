# Real-estate page UI/UX redesign

**Date:** 2026-06-16
**Scope:** `dashboard/src/app/real-estate/page.tsx` and its `dashboard/src/components/realestate/*` components. **Presentation only** — no `dashboard/src/lib/realestate/*` engine logic changes, so `engine.test.ts` / `financing.test.ts` / `timeline.test.ts` stay green.

## Problem

The page reads as a settings form, not an answer. It opens with a rename text box + a 20-field input monolith on a fixed 320px left rail, while the numbers that matter (honest profit/ROE, the funding gap) are tiny right-aligned text or buried below the fold. The page's actual thesis — *headline returns are leverage-flattered; here's the honest number; here's how much you personally lose if it breaks* — is scattered across six equal-weight cards with no spine and no hierarchy.

## Decisions (locked with user)

1. **Layout:** Inputs move into a slide-over drawer; analysis owns full width; verdict hero on top; 2-col narrative grid below.
2. **Framing:** Hero **leads with the honest (corrected) number**; the flattering reported number appears small/struck-through as the "before." No global reported/corrected toggle (the timeline keeps its own local toggle for exploration).
3. **Downside vs Scenarios:** Keep separate, just regroup (lowest risk; no merge of `reality-panel` internals).

## Target architecture (top → bottom)

1. **Top bar** — `h1` deal name with inline rename + small switcher dropdown chip; New/Duplicate/Delete collapsed into a `⋯` overflow menu; compact USD-rate control; primary `Edit assumptions ▸` button (opens drawer). Subtitle carries key assumptions: `4-unit · 7,200 sqft · build ₹2,250 · sale ₹11,500 · breakeven ₹8,083/sqft`.
2. **Verdict hero** (`verdict-hero.tsx`, new) — full-width, accent-tinted, dominant. Honest base return as the big number (₹ Cr · ROE×) with reported ghost; funding status promoted to a prominent chip (`⚠ Gap …` amber / `Fully funded` green) beside Sources; one-line thesis (reported IRR → honest IRR · unlevered engine). **Absorbs the 4-card `KpiRow`** as a secondary honest stat strip (IRR · margin · breakeven, with reported ghosts).
3. **Your-exposure strip** — existing `ContextStrip`, kept but demoted to a slim band directly under the hero (different question: can your balance sheet absorb it).
4. **Labeled chapters** (new lightweight `SectionLabel` divider in `ui.tsx`) using full width:
   - **RETURNS — honest vs reported** → `RealityPanel` (full width; the proof behind the hero, incl. its downside ladder).
   - **DOWNSIDE & SENSITIVITY** → `Scenarios` + `Sensitivity` (2-col).
   - **CAPITAL OVER TIME** → `ProfitTimeline` + `CashFlowChart` (2-col), `FinancingCard` below.
5. **Assumptions drawer** — existing `Drawer` from `ui.tsx`; `InputPanel` content rendered inside (drop its own `Card` chrome). Live-updates (state already local). Invalid-inputs state still blocks metrics, shown in the canvas where the hero would be.

## File-change map

| File | Change |
|---|---|
| `app/real-estate/page.tsx` | New top bar, drawer open-state, hero + `SectionLabel` chapters, full-width grid; invalid-state handling preserved |
| `components/realestate/verdict-hero.tsx` | **New.** Honest-led hero; composes `result` + `computeReality(inputs)`; absorbs `KpiRow` |
| `components/ui.tsx` | Add small `SectionLabel` chapter-divider primitive |
| `components/realestate/input-panel.tsx` | Render inside `Drawer` (drop outer `Card`); exit-strategy/funding-mix editors unchanged |
| `components/realestate/kpi-row.tsx` | Removed (folded into hero) |
| `context-strip / reality-panel / scenarios / sensitivity / profit-timeline / cash-flow-chart / financing-card` | **Unchanged internals** — regrouped only |

## Non-goals
- No engine/model/format logic changes.
- No new data sources or MCP tools.
- No merge of downside ladder into Scenarios.

## Verification
- `cd dashboard && npm run build` (typecheck) passes; `npm test` (vitest) stays green.
- Manual: page renders at valid + invalid input states; drawer opens/edits/live-updates; hero shows honest-led numbers with reported ghosts; funding chip reflects gap/funded; dark + light themes; mobile width (drawer + stacked sections).
