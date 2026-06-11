# Personal Finance Dashboard (local-only)

Next.js drill-down UI over the personal-finance MCP server and `link_helper`.
Never deploy this — it assumes a trusted localhost, like `link_helper` itself.

## Run

Requires both backends:

    .venv/bin/uvicorn asgi:app --port 8000 --reload   # MCP server
    .venv/bin/uvicorn link_helper:app --port 8765     # Plaid Link / sync / CSV

(or as launchd jobs — plists in `deploy/launchd/`)

Then:

    cd dashboard
    npm install
    npm run dev        # http://localhost:3000

Optional `.env.local` (see `.env.local.example`): `MCP_URL`, `LINK_HELPER_URL`.

## Pages

- `/` — net worth, runway/savings/flags, Optimizer pace, link & sync status
- `/accounts` — accounts by institution; expand for balance history + latest transactions
- `/transactions` — full explorer: date/account/category/merchant/amount filters, tags,
  merchant profile drawer, inline category fixes (writes `category_overrides`)
- `/spending` — stacked monthly categories, totals by category/merchant, month-vs-month compare;
  every bar and row links into the explorer
- `/net-worth` — snapshot history chart, 30-day change, milestone trajectory
- `/investments` — positions, allocation, concentration, on-demand live activity
- `/debt` — carried debts, utilization, payoff scenarios + payment simulator, live liability detail
- `/cash-flow` — income vs expenses, income sources/buckets, recurring streams with price-change flags
- `/connections` — port of the original link_helper UI: Plaid Link, sync now, Apple Card CSV import

## Architecture

- `/api/mcp/[tool]` → MCP client → `localhost:8000/mcp` (allowlisted tools; all analytics)
- `/api/link/*` → proxy → `localhost:8765` (Plaid Link token/exchange, sync, CSV import, status)

All business logic stays in the Python modules; this app renders tool output.

## Tests

    npm test           # vitest: formatters, allowlist, BFF routes
