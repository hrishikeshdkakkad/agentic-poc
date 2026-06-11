# Next.js Personal-Finance Dashboard — Design

Date: 2026-06-11
Status: Approved for implementation (autonomous session; decisions documented in lieu of interactive approval)

## Goal

Port the `link_helper.py` inline-HTML dashboard to a local-only Next.js app and extend it
into a deep drill-down view of the entire personal-finance picture. The existing
uvicorn/launchd `link_helper` process is **kept as-is and unmodified** — it remains the
backend for Plaid Link, sync-now, and CSV import.

## Non-goals

- No deployment. The app runs locally (`npm run dev`), like `link_helper`.
- No new write paths to institutions (read-only posture preserved).
- No changes to `link_helper.py`, `server.py`, or any Python module.
- No auth (localhost, single-tenant, same trust boundary as `link_helper`).

## Architecture

```
Next.js app (dashboard/, localhost:3000)
 ├── /api/mcp/[tool]  ──MCP client (streamable HTTP)──▶  MCP server  localhost:8000/mcp
 │      (allowlisted tool names; all analytics & data)   (server.py, FastMCP)
 └── /api/link/*      ──plain HTTP proxy──────────────▶  link_helper localhost:8765
        (status, create-link-token, exchange, sync, import-apple-card)
```

**Why MCP as the data plane** (chosen over direct Postgres or a new FastAPI BFF):

- Zero duplication of `analytics.py` / `wealth.py` / `insights.py` / `gamify.py` logic.
- The read-only SQL contract (`open_readonly`, `plaid_tokens` blocked) is enforced by the
  Python layer; the dashboard cannot weaken it.
- `query_finances` (validated read-only SELECT) covers any drill-down a named tool
  doesn't, without schema reimplementation in TypeScript.
- The dashboard dogfoods the product: it is an MCP client of the personal-finance MCP.

**Failure behavior:** the repo's "warnings, not exceptions" contract carries over. If the
MCP server or link_helper is unreachable, API routes return `{ error }` with a clear
message; pages render a banner and whatever data they have, never a crash page.

## Components

### BFF layer (`dashboard/src/app/api/`)

- `api/mcp/[tool]/route.ts` — POST `{ args }`. Validates `tool` against an allowlist
  (the read tools plus `sync_now`, `set_category_override`, `query_finances`), calls the
  MCP server via a cached singleton `@modelcontextprotocol/sdk` client, returns the
  tool's structured JSON. Reconnects on stale-session errors.
- `api/link/[...path]/route.ts` — proxies GET/POST to `http://localhost:8765/<path>`
  for the five link_helper endpoints (allowlisted paths). Streams the raw body for CSV
  upload.

Env via `dashboard/.env.local` (optional overrides): `MCP_URL` (default
`http://localhost:8000/mcp`), `LINK_HELPER_URL` (default `http://localhost:8765`).

### Client data layer (`dashboard/src/lib/`)

- `api.ts` — typed `callTool(name, args)` and `linkFetch(path, init)` helpers.
- `hooks.ts` — SWR hooks per tool (`useNetWorth`, `useTransactions(filters)`, …).
- `format.ts` — currency/date/percent formatters (single source for display rules).
- `types.ts` — TypeScript shapes mirroring tool responses (warnings array everywhere).

### Pages (App Router)

| Route | Content | Tools used |
|---|---|---|
| `/` Overview | Net worth headline + class breakdown, financial-health score, Optimizer game card, link/sync status strip, this-month spending vs last | `get_net_worth`, `get_financial_health`, `get_optimizer_score`, link `/api/status`, `aggregate_spending` |
| `/accounts` | All accounts grouped by institution & class; click an account → balance history chart + its transactions | `list_accounts`, `get_balances`, `query_finances` (balance_snapshots series), `list_transactions` |
| `/transactions` | Full explorer: date range, account, category, merchant search, amount range, tag filters; pagination; row expand → details + "fix category" inline (creates a merchant/transaction override) | `list_transactions`, `search_transactions`, `set_category_override`, `list_category_overrides` |
| `/spending` | Drill-down: month → category → merchant → transactions; stacked monthly chart; period compare (A vs B) | `aggregate_spending`, `compare_periods`, `list_transactions` |
| `/net-worth` | History line chart (assets/liabilities/net), per-class series, milestone trajectory projection | `get_net_worth_history`, `get_net_worth_trajectory`, `query_finances` |
| `/investments` | Holdings table (qty, price, value, cost basis, gain), allocation donut, portfolio analysis, recent investment transactions | `get_investment_holdings`, `get_portfolio_analysis`, `get_investment_transactions` |
| `/debt` | Liabilities by account (APR, min payment, due, overdue), payoff-schedule simulator with monthly-payment input | `get_liabilities`, `get_debt_analysis` |
| `/cash-flow` | Income analysis by month/source; recurring streams with cadence/next-expected; recurring analysis | `get_income_analysis`, `get_recurring_analysis`, `get_recurring_transactions` |
| `/connections` | Port of the existing UI: institutions + link health badges, Plaid Link (new + re-auth update mode), Sync now with result detail, Apple Card CSV upload | link_helper proxy endpoints |

A merchant drawer (opened from transactions/spending rows) shows `get_merchant_profile`.

### UI conventions

- Dark theme carried over from the existing dashboard palette (`#0f1115` bg, card/line/
  accent variables) so the two UIs feel related.
- Every page surfaces the `warnings: []` array from tool responses in a dismissible
  banner — one broken bank never blanks a page.
- Charts: Recharts (line, stacked bar, donut). Tables: plain accessible HTML with
  sticky headers; no heavyweight grid dependency.
- Money formatting respects the Plaid sign convention (amount > 0 = outflow) and flips
  it for display where users expect spend-positive.

## Error handling

- BFF returns `502` with `{ error, service: "mcp" | "link_helper" }` when an upstream is
  down; hooks expose `error` and pages show a service-down banner with the launchd hint.
- MCP tool-level `{ error: {...} }` payloads (e.g. invalid SQL) pass through untouched.
- The MCP client singleton reconnects once on transport failure before surfacing.

## Testing

- Vitest unit tests for `format.ts` (sign convention, currency) and the tool allowlist.
- BFF route tests with mocked MCP client (tool dispatch, allowlist rejection,
  upstream-down 502).
- Existing Python suite untouched; CI unaffected (dashboard has its own `package.json`;
  no workflow changes in this phase).

## Run book

```bash
cd dashboard && npm install && npm run dev   # localhost:3000
# requires: .venv/bin/python server.py (MCP, :8000) and uvicorn link_helper:app --port 8765
```

A `dashboard/README.md` documents this plus an optional launchd plist example
(mirroring the user's existing setup) — but installing launchd jobs is left to the user.
