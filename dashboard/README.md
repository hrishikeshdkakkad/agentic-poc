# Personal Finance Dashboard (local-only)

Next.js drill-down UI over the personal-finance MCP server and `link_helper`.
Never deploy this — it assumes a trusted localhost, like `link_helper` itself.

## Interface

- **Design system** — token-driven dark/light theming. Raw CSS variables live in
  `:root` / `[data-theme="light"]` (`globals.css`) and are mapped to Tailwind v4 via
  `@theme inline`, so utilities like `bg-card` re-theme at runtime with zero markup
  changes. A pre-paint `<head>` script (`components/theme.tsx`) sets the theme before
  first paint to avoid flashes. Geist Sans/Mono; tabular figures everywhere money lives.
- **App shell** (`components/app-shell.tsx`) — grouped nav rail (source of truth:
  `components/nav.tsx`), sticky top bar, global Sync with SWR revalidation, and a
  **⌘K command palette** (`components/command-palette.tsx`) to jump pages / sync / toggle theme.
- **Data grids** — data-heavy pages use **ag-grid** through one themed wrapper
  (`components/data-grid.tsx`): sort / filter / column resize / quick-search / CSV export,
  plus finance cell renderers (money with cash-flow sign, gains, chips, tags, share bars).
  The grid's `data-ag-theme-mode` follows the app theme attribute, so it re-themes in lockstep.
- **Charts** (`components/charts.tsx`) — recharts styled entirely through CSS variables
  (so they follow the theme), with gradient fills and a custom tooltip. Entry animations are
  disabled for instant, reliable rendering.
- **Primitives** (`components/ui.tsx`) — Card, KpiCard, Drawer, Button, Segmented, Badge,
  skeleton loaders, empty states. UI/UX only — no tool calls or data shapes changed.

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
