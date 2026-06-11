# Personal Finance Dashboard (local-only)

Next.js drill-down UI over the personal-finance MCP server and `link_helper`.
Never deploy this — it assumes a trusted localhost, like `link_helper` itself.

## Run

Requires both backends:

    .venv/bin/python server.py                      # MCP server, :8000
    .venv/bin/uvicorn link_helper:app --port 8765   # Plaid Link / sync / CSV

Then:

    cd dashboard
    npm install
    npm run dev        # http://localhost:3000

Optional `.env.local` (see `.env.local.example`): `MCP_URL`, `LINK_HELPER_URL`.

## Architecture

- `/api/mcp/[tool]` → MCP client → `localhost:8000/mcp` (allowlisted tools; all analytics)
- `/api/link/*` → proxy → `localhost:8765` (Plaid Link token/exchange, sync, CSV import, status)

All business logic stays in the Python modules; this app renders tool output.

## Tests

    npm test           # vitest: formatters, allowlist, BFF routes
