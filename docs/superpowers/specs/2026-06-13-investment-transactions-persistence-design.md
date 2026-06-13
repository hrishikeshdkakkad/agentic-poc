# Investment Transactions Persistence — Design

Date: 2026-06-13
Status: Approved (scope: full incl. Fidelity re-consent; backfill: 24 months)

## Problem

The Postgres history store persists Plaid's **Transactions** product (depository +
credit cash-flow) and dated **holdings** snapshots, but never persists the
**Investments Transactions** product (brokerage buys/sells, dividends, interest,
RSU/transfer activity). `sync.py:snapshot_item()` calls `/investments/holdings/get`
every run but never `/investments/transactions/get`. The data is fetched live-only
by the `get_investment_transactions` tool and discarded.

Verified empirically (2026-06-13):
- `transactions` (426 rows) maps only to credit/checking/savings accounts; **zero**
  rows from any of the 11 investment accounts.
- Live `/investments/transactions/get` over 24 months returns **1,121 transactions**
  (Robinhood 716, SoFi 405): buy 463, sell 209, dividend 203, interest 95, plus
  margin expense / transfers / fees. 94 securities. No warnings. → already-authorized,
  cleanly persistable.
- Fidelity + Charles Schwab are investment-only items (no cash accounts, so
  `tx_added=0` is correct). They contribute 0 to the live feed and are not in the
  live tool's healthy-item set — the investments **transactions** subscription was
  never activated for them.

## Plaid semantics (researched)

- "Investments Transactions" is **not** a separate Link product — it is a separate
  *billing subscription* under the single `investments` product. Linking with
  `investments` activates **Holdings** only; the **Transactions** subscription
  activates on the first `/investments/transactions/get` call for an Item.
- `/investments/transactions/get` is **date-range + offset paginated** (no cursor),
  and **synchronous by default** (blocks until extraction completes; only
  `async_update=true` defers and fires `HISTORICAL_UPDATE`).
- Adding the product to an existing Item: Link **update mode** with
  `additional_consented_products=[investments]`; use `required_if_supported_products`
  at link time so future Items pre-consent.

## Design

Mirror the holdings writer's shape with the transactions table's idempotency.
No cursor exists for investments, so idempotency rides entirely on
`investment_transaction_id` as PRIMARY KEY + `ON CONFLICT DO UPDATE`. Re-pulling an
overlapping window can never double-count (same guarantee as `transactions` and the
`ac_<sha1>` CSV importer).

### Components

1. **`storage.py` — table + writer**
   ```sql
   CREATE TABLE IF NOT EXISTS investment_transactions (
       investment_transaction_id TEXT PRIMARY KEY,
       account_id TEXT, item_key TEXT, date DATE, name TEXT,
       type TEXT, subtype TEXT,
       amount DOUBLE PRECISION, quantity DOUBLE PRECISION,
       price DOUBLE PRECISION, fees DOUBLE PRECISION,
       security_id TEXT, symbol TEXT, security_name TEXT, security_type TEXT,
       currency TEXT, updated_at TIMESTAMPTZ
   );
   CREATE INDEX IF NOT EXISTS idx_inv_tx_date ON investment_transactions (date);
   CREATE INDEX IF NOT EXISTS idx_inv_tx_account ON investment_transactions (account_id);
   CREATE INDEX IF NOT EXISTS idx_inv_tx_symbol ON investment_transactions (symbol);
   ```
   `record_investment_transactions(conn, item_key, raw_txns, securities_by_id) -> int`
   — executemany upsert, mirrors `record_holdings_snapshots`.

2. **`plaid_client.py` — shared shaper**
   `shape_investment_transaction(raw, securities)` joins security metadata; reused by
   both the live tool and the sync writer (joins the existing `shape_holding`).

3. **`sync.py` — ingest step**
   `_sync_item_investments(api, conn, env_key, token, window)` calls
   `/investments/transactions/get` (offset pagination) over a date window and persists.
   Wrapped in try/except `ApiException` → `warning(scope="investment_transactions")`,
   so a Fidelity `ACCESS_NOT_GRANTED`/consent error is a warning, never a crash
   (preserves the warnings-not-exceptions contract). Called from `run_sync` after
   `_sync_item_transactions`.

   **Window policy** (`investment_sync_window(backfill: bool)`): scheduled runs pull a
   rolling `[today−45d, today]`; the one-shot backfill pulls `[today−730d, today]`
   (Plaid max). Rolling window overlaps generously vs the ~4h cadence; upsert dedups.
   `run_sync(..., investments_backfill=False)`; `python sync.py --backfill-investments`
   sets it True. *Knob owned by the user: the 45-day lookback.*

4. **`server.py` — exposure**
   - Add `investment_transactions` to `get_sync_status` table counts.
   - New DB-backed `list_investment_transactions(start_date, end_date, account_id?, type?)`
     tool — zero Plaid calls, mirrors `list_transactions`.
   - Refactor the live `get_investment_transactions` impl to reuse the shared shaper.

5. **`analytics.py` — discoverability**
   Add an `investment_transactions` entry to `describe_tables()` descriptions.
   `query_finances` already permits it (denylist only blocks `plaid_tokens`).

6. **`link_helper.py` — Fidelity/Schwab re-consent**
   - New links: add `required_if_supported_products=[investments]`.
   - Existing items: update-mode variant passing
     `additional_consented_products=[investments]` so Fidelity/Schwab re-consent
     without a full relink. User completes the Link flow in the local dashboard; the
     next sync's `/investments/transactions/get` then succeeds.

### Explicitly out of scope

- `apply_tags()` / `apply_overrides()` do **not** extend to investment transactions —
  those operate on `transactions` (merchant/category). Investment transactions have no
  merchant or category; they are a separate stream, intentionally outside that pipeline.
- No webhook listener: synchronous default means call-and-store suffices for a
  scheduled Lambda.

## Testing (TDD)

- `record_investment_transactions`: insert, re-run same window → no duplicates; upsert
  updates mutated fields.
- `shape_investment_transaction`: security join, missing-security fallback.
- `_sync_item_investments`: integration with a fake Plaid api (paginated response) →
  rows persisted; ApiException → warning, no raise.
- Window policy: backfill vs rolling bounds.
- Exposure: `query_finances` can SELECT the table; `describe_tables` documents it;
  `get_sync_status` counts it.

## Rollout

The one-shot 24-month backfill must run where the prod secrets live (this repo
checkout has none):
- **Deployed (recommended):** invoke the sync Lambda once with
  `{"investments_backfill": true}` (lambda_handler reads the flag). Scheduled runs
  thereafter use the rolling 45-day window automatically.
- **Local:** `python sync.py --backfill-investments` from an environment with the
  prod `.env` (Plaid creds + Neon `DATABASE_URL` + token store).

Steps:
1. Implement + tests green locally. ✅ (209 passed)
2. Merge → CI deploys both Lambdas (server + sync) from the same artifact.
3. Invoke the sync Lambda once with `{"investments_backfill": true}` → seeds 24
   months for already-authorized items (Robinhood, SoFi) into prod Neon.
4. Re-consent Fidelity + Schwab: POST `/create-link-token`
   `{"update_access_token": "<token>", "add_investments": true}` from the local
   Link dashboard, complete Plaid Link, then re-invoke the backfill. Sync logs a
   `scope=investment_transactions` warning for any item still lacking consent —
   not a failure.

### Operational note: token-store divergence (discovered 2026-06-13)

`get_institutions_status` (running MCP server) lists only Chase/Robinhood/SoFi,
yet `sync_state` + `holdings_snapshots` show Fidelity and Charles Schwab were
synced for holdings the same day. The MCP server's `load_tokens()` and the sync
process's token set diverge — Fidelity/Schwab tokens are present for the sync but
absent from the queried server. Reconcile the token store (encrypted `plaid_tokens`
+ `PLAID_TOKEN_*`) so live tools and analytics agree on the linked items; otherwise
the live `get_investment_transactions`/`get_investment_holdings` keep skipping
Fidelity/Schwab even after their investments consent is granted.
