# personal-finance-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org/downloads/)
[![MCP](https://img.shields.io/badge/MCP-read--only-brightgreen.svg)](https://modelcontextprotocol.io)

> **Unofficial.** This project is not affiliated with, endorsed by, or sponsored by Plaid Inc. "Plaid" is a trademark of Plaid Inc. This is a self-hosted client that talks to Plaid's API using credentials you supply.

A self-hosted, read-only MCP server that connects your banks, credit cards, loans, and brokerage accounts (via Plaid) to an MCP client like Claude Code. Ask questions about your own finances in plain English — no third-party aggregator (Monarch, Mint, etc.) involved.

## What you can ask

- "What's my total balance across all accounts?"
- "Show me transactions over $100 in the last 30 days."
- "Which subscriptions am I still paying for?"
- "How much did I spend on groceries last month?"
- "Any bank that needs re-authentication?"

Example session (illustrative):

```
you    : What did I spend on groceries last month?
claude : [calls get_transactions]
         $487.23 across 14 transactions. Top merchants:
         Whole Foods ($198), Trader Joe's ($156), Safeway ($89).

you    : Any subscriptions I'm still paying for?
claude : [calls get_recurring_transactions]
         7 active recurring outflows totaling $142/mo:
         Netflix ($15.99), Spotify ($11.99), NYT ($4), ...
```

## Hybrid architecture: live balances + history store

This fork adds a **Postgres history store** (managed, e.g. [Neon](https://neon.tech) — set `DATABASE_URL`) on top of the original live-only tools. Transactions are ingested via Plaid's `/transactions/sync` cursor flow, and dated balance / holdings / liabilities snapshots accumulate on every sync. That enables questions live Plaid calls can't answer: multi-year spending aggregations (no 2-year lookback cap), net worth over time, and arbitrary SQL — all with **zero Plaid calls** at question time. Current balances stay live.

```
Plaid API ──/transactions/sync──▶ Postgres (transactions, snapshots) ──▶ aggregate_spending,
        └──live /accounts/balance/get────────────────────────────────▶ get_net_worth      net_worth_history,
                                                                                           query_finances
```

Sync on demand (MCP tool) or on a schedule (cron) — no background daemon:

```bash
python sync.py                       # cron-able CLI; same effect as the sync_now tool
# crontab: 0 7 * * * cd /path/to/repo && .venv/bin/python sync.py >> sync.log 2>&1
```

## Tools

### History tools (Postgres-backed, this fork)

| Tool                    | What it does                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `sync_now`              | Pull new/changed/removed transactions (cursor flow) + record today's snapshots. Idempotent. |
| `get_net_worth`         | Live composed net worth by asset class: cash, investments, retirement (401k/IRA), credit, loans |
| `get_net_worth_history` | Net worth per snapshot date, from local snapshots — zero Plaid calls                   |
| `aggregate_spending`    | Spend by category/merchant, optionally by month, over any range — zero Plaid calls     |
| `query_finances`        | Escape hatch: single read-only SELECT against the history database (writes rejected)       |
| `describe_tables`       | Local schema with column notes and conventions — call before writing SQL               |
| `list_transactions`     | Raw stored transactions with filters (dates, category, merchant, amount) + paging — zero Plaid calls |
| `get_sync_status`       | Store freshness, table counts, and the Plaid-API call counter                          |
| `get_optimizer_score`   | The Optimizer game: month-to-date spend vs the hard monthly target, points, records    |

### Deep-insight tools (Postgres-backed, this fork)

All zero Plaid calls — agents can call these liberally.

| Tool                       | What it does                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `get_debt_analysis`        | Per-debt APR, utilization, monthly carrying cost, and payoff scenarios (months + interest) |
| `get_portfolio_analysis`   | Positions by symbol: weights, null-safe unrealized gains, cash-like vs invested, concentration |
| `get_income_analysis`      | Inflows classified into typed buckets (payroll/interest/p2p/transfers/…), savings rate     |
| `get_net_worth_trajectory` | Monthly net-worth change (snapshots or cashflow) with milestone ETA                        |
| `get_recurring_analysis`   | Locally-detected recurring streams with price history and creep flags                      |
| `get_merchant_profile`     | Lifetime story of one merchant (searches raw names too), trend + monthly series            |
| `compare_periods`          | Month-vs-month diff with category and merchant drivers, biggest movers first               |
| `get_financial_health`     | One-call orientation: net worth, runway, debt cost, savings rate, pace + attention flags   |
| `set_category_override`    | Durably fix a miscategorized merchant/transaction; reapplied after every sync              |
| `list_category_overrides`  | Show the category-correction rulebook                                                      |

### Original live tools

All 9 tools are read-only. Each returns `{<data>: [...], "warnings": [...]}` so one broken bank doesn't break the whole query.

| Tool                          | What it does                                                         |
| ----------------------------- | -------------------------------------------------------------------- |
| `list_accounts`               | Every account across every linked bank, with balances                |
| `get_balances`                | Live current + available balances (optionally filtered by account)   |
| `get_transactions`            | Transactions in a date range (up to 2 years back)                    |
| `search_transactions`         | Keyword search across merchant / name / counterparty                 |
| `get_recurring_transactions`  | Detected recurring inflow + outflow streams                          |
| `get_liabilities`             | Credit cards, student loans, mortgages with APRs and payment details |
| `get_investment_holdings`     | Current holdings with symbol + security metadata                     |
| `get_investment_transactions` | Buy / sell / dividend history in a date range                        |
| `get_institutions_status`     | Health of each linked bank (surfaces re-auth needs)                  |

## Sandbox quickstart (no real banks needed)

```bash
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # set PLAID_CLIENT_ID, PLAID_SECRET (sandbox), PLAID_ENV=sandbox, DATABASE_URL
python sandbox_link.py      # headless-links First Platypus Bank with transactions+investments+liabilities
python verify_e2e.py        # runs all tools, syncs twice, proves idempotency + zero-Plaid-call analytics
python server.py            # serve on http://localhost:8000/mcp
```

`PLAID_ENV=production` is a pure env-var change — link real banks with `link_helper.py` instead of `sandbox_link.py`.

## Quickstart

Requires Python 3.11+, a Plaid account (free Trial plan), and an MCP client.

### 1. Plaid setup

1. Sign up at https://dashboard.plaid.com/signup → choose the **Trial** plan (free, 10 Items).
2. **Team Settings → Products**: enable **Transactions**, **Liabilities**, **Investments**.
3. **Team Settings → API**: copy your `client_id` and production `secret`.

### 2. Install

```bash
git clone https://github.com/JosueM1109/personal-finance-mcp.git
cd personal-finance-mcp
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then fill in PLAID_CLIENT_ID and PLAID_SECRET
pytest -v              # sanity check
```

### 3. Link each bank

Run once per bank you want to connect:

```bash
uvicorn link_helper:app --port 8765
```

Open http://localhost:8765, click **Link a bank**, complete Plaid Link. The terminal prints a line like `PLAID_TOKEN_CHASE=access-prod-xxx...` — paste it into `.env` and repeat for each bank.

### 4. Run it

```bash
python server.py   # serves on http://localhost:8000/mcp
```

### 5. Add to Claude Code

```bash
claude mcp add --transport http personal-finance http://localhost:8000/mcp
```

Try "list my accounts" to confirm.

## Deployment

For a deployment you can use from anywhere:

- **AWS Lambda** (this fork's setup, ~$0/month): `./deploy/build_lambda.sh && ./deploy/deploy.sh`, then prove it with `python verify_remote.py` — stateless streamable HTTP behind a bearer-gated Function URL. Full walkthrough in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- **Docker** (included): `docker build -t personal-finance-mcp . && docker run --rm -p 8000:8000 --env-file .env personal-finance-mcp`
- **Any Python host** (Fly.io, Railway, Raspberry Pi + Tailscale, a VPS): set the env vars from `.env.example`, expose `/mcp` over HTTPS, gate it with auth.
- **Prefect Horizon** (what the author uses — $0 recurring cost): see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full walkthrough.

**Gate the endpoint.** An exposed MCP endpoint with your tokens leaks every linked account. Use OAuth 2.1, Cloudflare Access, or bind to a private network only.

## Security

- **Single-tenant.** One deployment per person. Don't share.
- **Read-only.** No tool mutates state at any institution. Don't add any that do. `sync_now` writes only to your own history database.
- **Tokens encrypted at rest, stored in the database.** Access tokens are Fernet-encrypted client-side and the ciphertext lives in the `plaid_tokens` table, so the server can run anywhere that reaches Postgres. The Fernet key never touches the database: it comes from `FERNET_KEY` (deployments) or a chmod-600 keyfile in `~/.config/personal-finance-mcp/`. DB access alone reveals nothing; the key alone reveals nothing. `plaid_tokens` is blocked from `query_finances`/`describe_tables`. Manage with `python secure_tokens.py list|add|remove|import`; `PLAID_TOKEN_*` env vars still override. Tokens are never logged or printed (`SecretStr` redaction everywhere).
- **You own the history database.** Data lives in your own Postgres (e.g. a Neon project under your account). Use a dedicated database, keep `sslmode=require` in `DATABASE_URL`, and don't share the connection string — it grants read/write to your full transaction history.
- **You own Plaid compliance.** You're the Plaid customer under your own account.

Before each deploy:

- [ ] `.env` never committed: `git log --all -- .env` returns nothing
- [ ] No real tokens in history: `git log -S'access-prod-' --all` returns only placeholders
- [ ] Auth gate in front of the MCP endpoint (or localhost-only)
- [ ] `HORIZON=1` (or similar) set in deployment env, blocking `link_helper.py` there
- [ ] Check `get_institutions_status()` every few weeks for re-auth needs

## Troubleshooting

**Tool returns empty despite real data.** Plaid products weren't enabled when you linked the bank. Re-link with Transactions + Liabilities + Investments active. The tool surfaces `PRODUCTS_NOT_SUPPORTED` in `warnings` when this is the cause.

**`get_institutions_status()` shows `re_auth_required`.** The bank's Plaid session expired. Run `link_helper.py` in update mode — your existing access token stays the same. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#handling-item_login_required-re-auth).

**Plaid Link shows a bank as "unsupported" (common with Amex).** Usually an `INSTITUTION_REGISTRATION_REQUIRED` issue — OAuth banks need per-institution registration in the Plaid dashboard first. See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

More issues: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Architecture

- [server.py](server.py) — FastMCP server: 9 original live tools + 6 local-history tools.
- [plaid_client.py](plaid_client.py) — Plaid SDK wrapper: `SecretStr` token redaction, 5-minute per-Item health cache, response shaping, structured error mapping, API call counter.
- [storage.py](storage.py) — Postgres schema + idempotent writes (transactions keyed by id, snapshots by date+account); Neon-ready via DATABASE_URL.
- [sync.py](sync.py) — `/transactions/sync` cursor flow + snapshot job; MCP tool and cron CLI share this.
- [analytics.py](analytics.py) — read-only query layer: spending aggregation, net-worth composition/history, validated SQL escape hatch.
- [secure_tokens.py](secure_tokens.py) — Fernet-encrypted token store + CLI.
- [sandbox_link.py](sandbox_link.py) — headless sandbox Item linking (sandbox only).
- [verify_e2e.py](verify_e2e.py) — one-command live verification of the acceptance criteria.
- [link_helper.py](link_helper.py) — Local-only FastAPI app for Plaid Link. Refuses to run if `HORIZON=1` is set.

Deeper dive (including why `/transactions/get` over `/transactions/sync`): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Scope is deliberately narrow: read-only, single-tenant, Plaid-backed.
