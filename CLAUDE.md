# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A self-hosted, **read-only**, **single-tenant** personal-finance MCP server (FastMCP) backed by Plaid. The read-only posture is a security property: no tool may mutate state at any institution. The only writes allowed are to the user's own Postgres history store (sync, CSV import, tags, category overrides, manual balance snapshots for accounts with no Plaid Item). See CONTRIBUTING.md for scope limits before adding tools.

## Commands

```bash
.venv/bin/python -m pytest -q                      # full suite (pytest.ini sets testpaths=tests)
.venv/bin/python -m pytest tests/test_server.py -k name   # single test
.venv/bin/uvicorn asgi:app --port 8000 --reload     # MCP server → http://localhost:8000/mcp (asgi.py wraps server.py for hot reload)
.venv/bin/python server.py                          # MCP server, no hot reload (legacy; prefer asgi:app — a stale long-running process serves old code)
.venv/bin/uvicorn link_helper:app --port 8765       # local link dashboard: Plaid Link, sync-now, Apple Card CSV upload
cd dashboard && npm run dev                         # Next.js drill-down UI → http://localhost:3000 (needs both servers above)
cd dashboard && npm test                            # dashboard vitest suite; tests/test_dashboard_contract.py guards the tool allowlist

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

## Architecture

Three data planes feed the MCP tools, and knowing which plane a tool reads from explains most behavior:

1. **Live Plaid** (`server.py` top half, via `plaid_client.py`): tools loop over every linked Item (env `PLAID_TOKEN_*` or the encrypted `plaid_tokens` table), call Plaid per Item, and shape responses.
2. **Postgres history store** (`storage.py` schema, `sync.py` cursor-based `/transactions/sync` ingest, `analytics.py` / `wealth.py` / `insights.py` queries): transactions plus dated balance/holdings/liabilities snapshots. All analytics tools answer with **zero Plaid calls**.
3. **Manual imports** (`apple_card.py` → `storage.import_transactions`): CSV-sourced accounts have **no Plaid Item**, so live-Plaid tools can't see them. `list_accounts` unions them in from the DB with `source: "csv_import"` (dedupe is by `item_key` against linked Plaid items — Plaid accounts are also mirrored in the DB, so dedupe by account would double-list). CSVs carry no balance, so these accounts have no `balance_snapshots` rows and are excluded from net-worth tools.

Cross-cutting contracts:

- **Warnings, not exceptions.** Every tool returns `{"<data>": [...], "warnings": [...]}`. One broken bank (re-auth, rate limit, DB down) becomes a warning entry; the rest of the answer still returns. Preserve this in new tools — never let one Item's failure raise.
- **Post-write pipeline.** After any transaction write (sync or import), `storage.apply_tags()` (rule engine in `tagging.py`) and `storage.apply_overrides()` (user category corrections in `category_overrides`) must re-run — Plaid re-upserts would otherwise undo user corrections. Any new write path must call both.
- **Idempotency everywhere.** Transactions keyed by id (`ON CONFLICT DO NOTHING`), snapshots by (date, account), CSV import adds a date-coverage layer plus deterministic `ac_<sha1>` ids. Re-running sync or re-uploading an overlapping statement never double-counts.
- **Token secrecy.** Access tokens are wrapped in `SecretStr` (repr/str/format redacted) and Fernet-encrypted at rest; the key lives only in `FERNET_KEY` or `~/.config/personal-finance-mcp/fernet.key`, never in the DB. `plaid_tokens` is blocked from `query_finances`/`describe_tables`. Don't log, print, or return tokens.
- **Read-only SQL.** `storage.open_readonly()` enforces read-only per-transaction (`BEGIN ... READ ONLY`), deliberately not via libpq startup options — Neon's transaction pooler rejects those. Don't "simplify" this.
- **Two databases by design.** `DATABASE_URL` = history store (Neon); `PFM_TOKENS_DATABASE_URL` = token store (may be local-only so tokens never leave the machine). Tests pin both to the test DB.

Remote deployment: `lambda_app.py` wraps the same FastMCP app for AWS Lambda (Mangum, `stateless_http=True`) behind a constant-time bearer gate that accepts the token as an `Authorization` header **or** a `/t/<token>/mcp` path prefix (for claude.ai connectors, which can't send custom headers). `deploy/build/` is a build artifact — never edit it.

## Doc staleness warning

`docs/ARCHITECTURE.md` predates this fork in places (e.g. it claims `/transactions/get` is used over `/transactions/sync`; this fork uses the `/sync` cursor flow with cursors persisted in `sync_state`). Trust the code and README over that file.
