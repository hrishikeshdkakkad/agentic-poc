# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A self-hosted, **read-only**, **single-tenant** personal-finance MCP server (FastMCP) backed by Plaid. The read-only posture is a security property: no tool may mutate state at any institution. The only writes allowed are to the user's own Postgres history store (sync, CSV import, tags, category overrides, manual balance snapshots for accounts with no Plaid Item). See CONTRIBUTING.md for scope limits before adding tools.

A Next.js dashboard in `dashboard/` is the drill-down UI over the same data. It's deployed to Vercel behind **Cognito invitation-only OAuth with page-level RBAC** — i.e. multi-*user* access (invited family members, each scoped to specific pages) over a single-tenant *dataset*. The MCP server itself is unchanged by this; see **Dashboard auth & RBAC** below and `docs/AUTH-DEPLOYMENT.md`.

## Commands

```bash
.venv/bin/python -m pytest -q                      # full suite (pytest.ini sets testpaths=tests)
.venv/bin/python -m pytest tests/test_server.py -k name   # single test
.venv/bin/uvicorn asgi:app --port 8000 --reload     # MCP server → http://localhost:8000/mcp (asgi.py wraps server.py for hot reload)
.venv/bin/python server.py                          # MCP server, no hot reload (legacy; prefer asgi:app — a stale long-running process serves old code)
.venv/bin/uvicorn link_helper:app --port 8765       # local link dashboard: Plaid Link, sync-now, Apple Card CSV upload
cd dashboard && npm run dev                         # Next.js drill-down UI → http://localhost:3000 (needs both servers above)
cd dashboard && npm test                            # dashboard vitest suite; tests/test_dashboard_contract.py guards the tool allowlist
cd dashboard && vercel --prod --yes                 # deploy dashboard to Vercel (Cognito-gated; deploys working tree, not via git)
USER_POOL_ID=us-east-1_IefyP36vE ./deploy/invite.sh <email> <role>   # invite a user; role = admin | realestate-viewer

.venv/bin/python sync.py                            # manual sync (same code path as the sync_now tool)
.venv/bin/python verify_remote.py                   # prove the deployed Lambda works (all tools, auth negatives)
```

### Test database (important)

DB-backed tests need Postgres at `postgresql://finance:finance@127.0.0.1:5433/finance` (override via `TEST_DATABASE_URL`). Locally that's the `finance-test-pg` Docker container; CI runs a postgres:16 service on the same port. Two sharp edges:

- The `db` fixture **silently skips** when Postgres is unreachable — a green run may have skipped every DB test. CI has a reachability pre-check for this reason.
- The fixture **TRUNCATEs all tables**. Never point `TEST_DATABASE_URL` at a real database.

### Local process management

Both local servers are meant to run as launchd agents with uvicorn `--reload`
(plists tracked in `deploy/launchd/`): `com.personal-finance-mcp.dashboard`
(link_helper, :8765) and `com.personal-finance-mcp.server` (MCP via asgi.py,
:8000). Install: copy the plist to `~/Library/LaunchAgents/`, then
`launchctl bootstrap gui/$UID <plist>` and `launchctl kickstart -k gui/$UID/<label>`.
The plists exec the Homebrew python binary directly with PYTHONPATH pointing at
the venv — see the comment inside them before "simplifying" (TCC denies exec
through the .venv symlink under ~/Documents).

### Deploy

Push to `main` → GitHub Actions runs test → build → deploy (Lambda code via OIDC) → smoke. **Code deploys go through CI; env/config changes (env vars, secrets) deploy locally only** via `./deploy/build_lambda.sh && ./deploy/deploy.sh`, because `.env` and the Fernet key never reach GitHub. Lambda build quirks (psycopg version pin, plaid-python sdist handling) live in `deploy/build_lambda.sh` — don't "fix" them without reading the comments there.

**Two Lambdas, one artifact.** `personal-finance-mcp` (MCP server, public Function URL, bearer-gated) and `personal-finance-mcp-sync` (scheduled Plaid sync, handler `sync.lambda_handler`, no URL) ship from the same `deploy/lambda.zip`. The sync runs ~6×/day via an EventBridge Scheduler schedule (`rate(4 hours)`, 2 retries); CI updates both functions' code.

**Secrets are not plaintext env vars** (this is a shared AWS account with other admins). Both functions read config from an SSM SecureString (`/personal-finance-mcp/config`) encrypted by a customer-managed KMS key (`alias/personal-finance-mcp`) whose policy DENIES every principal except root and the two function roles — so the other account admins cannot decrypt the Plaid secret / Fernet key / DB URL (verified: a `kms:*` principal gets AccessDenied). `config_secrets.load_into_env()` fetches it at cold start; it is a no-op without `PFM_CONFIG_PARAM`, so `.env`/tests/local runs are unchanged. Local provisioning (run as the account owner): `deploy/setup_security.sh` (CMK + SSM + least-priv roles), `deploy/deploy_sync.sh` (sync fn + schedule), `deploy/migrate_server_secrets.sh` (strip the server's plaintext env after the SSM path is proven), `deploy/verify_security.sh` (assert the whole posture). `deploy/deploy.sh` now pushes secrets to SSM and sets only pointer env on the function.

### Dashboard auth & RBAC (Vercel)

The Next.js dashboard is deployed to Vercel (project `personal-finance-vault`, https://personal-finance-vault.vercel.app) behind **AWS Cognito** invitation-only OAuth (Auth.js v5 + Hosted UI) with **page-level RBAC**. The Lambda data planes are unchanged — the dashboard is just another bearer-holding MCP client. Full runbook: `docs/AUTH-DEPLOYMENT.md`.

- **RBAC lives in the Next.js layer, not the MCP server.** `dashboard/src/lib/rbac.ts` is the single source of truth (role→permission, page→permission, tool→permission maps; tested in `rbac.test.ts`). It's enforced server-side by `dashboard/src/lib/session.ts` in **every** `/api/**` route (deny-by-default; JSON 401/403) and by `dashboard/src/proxy.ts` for page access. The browser never holds the MCP bearer token or Neon creds — the Next.js server attaches them only *after* the RBAC check. The MCP Lambda stays single-token / full-access by design (also used by the claude.ai connector), so it must never be exposed to a viewer directly.
- **Roles = Cognito groups** (`admin`, `realestate-viewer`), carried in the `cognito:groups` ID-token claim. Only roles are stored in the session; permissions are recomputed from the map each request, so changing the map needs no re-login. Provision idempotently with `deploy/setup_cognito.sh` (pool `us-east-1_IefyP36vE`); invite/revoke with `deploy/invite.sh` / `deploy/cognito_helpers.sh`. No public sign-up.
- **Sharp edges:** `next-auth@beta` needs `dashboard/.npmrc` `legacy-peer-deps=true` on Next 16; the middleware MUST be `dashboard/src/proxy.ts` with a default export (Next 16 renamed `middleware.ts`→`proxy.ts`); Cognito CLI callback-url lists are **space-separated** (a comma-joined string becomes one malformed callback → OAuth `redirect_mismatch`). `query_finances`/`describe_tables` are **admin-only** (raw SQL can't be page-scoped), which makes `/transactions` admin-tier in v1. `/connections` is admin-only and Plaid *linking* stays local (`link_helper.py` never deploys; the cloud page only shows status + Sync via the MCP server). Vercel env (all server-only, never `NEXT_PUBLIC_`): `AUTH_SECRET`, `AUTH_URL`, `AUTH_COGNITO_ID/SECRET/ISSUER`, `COGNITO_HOSTED_DOMAIN`, `MCP_URL`, `MCP_AUTH_TOKEN`, `DATABASE_URL`.

## Architecture

Three data planes feed the MCP tools, and knowing which plane a tool reads from explains most behavior:

1. **Live Plaid** (`server.py` top half, via `plaid_client.py`): tools loop over every linked Item (env `PLAID_TOKEN_*` or the encrypted `plaid_tokens` table), call Plaid per Item, and shape responses.
2. **Postgres history store** (`storage.py` schema, `sync.py` cursor-based `/transactions/sync` ingest plus `_sync_item_investments` for `/investments/transactions/get`, `analytics.py` / `wealth.py` / `insights.py` queries): transactions, **investment transactions** (brokerage buys/sells/dividends/interest, keyed by `investment_transaction_id`), plus dated balance/holdings/liabilities snapshots. All analytics tools answer with **zero Plaid calls**. The live `get_investment_transactions` (plane 1) and the DB-backed `list_investment_transactions` share one shaper — `plaid_client.shape_investment_transaction` — so they never drift.
3. **Manual imports** (`apple_card.py` → `storage.import_transactions`): CSV-sourced accounts have **no Plaid Item**, so live-Plaid tools can't see them. `list_accounts` unions them in from the DB with `source: "csv_import"` (dedupe is by `item_key` against linked Plaid items — Plaid accounts are also mirrored in the DB, so dedupe by account would double-list). CSVs carry no balance, so these accounts have no `balance_snapshots` rows and are excluded from net-worth tools.

Cross-cutting contracts:

- **Warnings, not exceptions.** Every tool returns `{"<data>": [...], "warnings": [...]}`. One broken bank (re-auth, rate limit, DB down) becomes a warning entry; the rest of the answer still returns. Preserve this in new tools — never let one Item's failure raise.
- **Post-write pipeline.** After any transaction write (sync or import), `storage.apply_tags()` (rule engine in `tagging.py`) and `storage.apply_overrides()` (user category corrections in `category_overrides`) must re-run — Plaid re-upserts would otherwise undo user corrections. Any new write path must call both. These operate on the `transactions` table only; `investment_transactions` is a separate stream (no merchant/category) and is deliberately excluded.
- **Idempotency everywhere.** Transactions keyed by id (`ON CONFLICT DO NOTHING`), snapshots by (date, account), CSV import adds a date-coverage layer plus deterministic `ac_<sha1>` ids. Re-running sync or re-uploading an overlapping statement never double-counts. Investment transactions have **no Plaid cursor** — sync re-pulls a date window each run (rolling 45 days; full ~24-month backfill via `python sync.py --backfill-investments` or the sync Lambda event `{"investments_backfill": true}`) and dedups solely on the `investment_transaction_id` PK. Their `amount` is a cash-flow sign (positive = cash out / buys & fees, negative = cash in / sells, dividends, interest); the dashboard `<Money>` component renders the inflow side green.
- **Token secrecy.** Access tokens are wrapped in `SecretStr` (repr/str/format redacted) and Fernet-encrypted at rest; the key lives only in `FERNET_KEY` or `~/.config/personal-finance-mcp/fernet.key`, never in the DB. `plaid_tokens` is blocked from `query_finances`/`describe_tables`. Don't log, print, or return tokens.
- **Read-only SQL.** `storage.open_readonly()` enforces read-only per-transaction (`BEGIN ... READ ONLY`), deliberately not via libpq startup options — Neon's transaction pooler rejects those. Don't "simplify" this.
- **Two databases by design.** `DATABASE_URL` = history store (Neon); `PFM_TOKENS_DATABASE_URL` = token store (may be local-only so tokens never leave the machine). Tests pin both to the test DB. **Token-store divergence gotcha:** the Lambda has no `PFM_TOKENS_DATABASE_URL`, so it reads `plaid_tokens` from `DATABASE_URL` (Neon). An Item linked only into the local token store is invisible to the scheduled Lambda until its Fernet-encrypted `plaid_tokens` row is copied into Neon — so the local link dashboard can list more Items than the Lambda actually syncs. The ciphertext is portable because the same Fernet key backs both stores (local `fernet.key` is what `setup_security.sh` pushes to SSM).

Remote deployment: `lambda_app.py` wraps the same FastMCP app for AWS Lambda (Mangum, `stateless_http=True`) behind a constant-time bearer gate that accepts the token as an `Authorization` header **or** a `/t/<token>/mcp` path prefix (for claude.ai connectors, which can't send custom headers). `deploy/build/` is a build artifact — never edit it.

## Doc staleness warning

`docs/ARCHITECTURE.md` predates this fork in places (e.g. it claims `/transactions/get` is used over `/transactions/sync`; this fork uses the `/sync` cursor flow with cursors persisted in `sync_state`). Trust the code and README over that file.
