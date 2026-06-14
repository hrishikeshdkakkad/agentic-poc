# Item Reset Helper — Design

**Date:** 2026-06-13
**Status:** Approved (pending spec review)

## Problem

Plaid's `/transactions/sync` seeds an Item's transaction history once, at link
time, bounded by `transactions.days_requested` (default 90 days). This value is
**immutable once Transactions is on the Item** — it cannot be raised by re-auth
or update mode. We now request `days_requested=730` for *new* links
(`link_helper.py`), but the six existing Items keep their shallow ~90-day seed.

The only way to get 24 months of history on an existing connection is to remove
it and re-link it as a **fresh Item** (new `access_token`, new Plaid
`account_id`s). Today that is a fragile manual process with three traps:

1. The old Item keeps **billing at Plaid** unless explicitly removed
   (`/item/remove`); the repo has no removal path.
2. The `sync_state` cursor is bound to the old token — left in place, the new
   Item is fed a stale cursor and never syncs.
3. Re-linking mints **new `account_id`s**, orphaning old rows. Because
   `analytics.net_worth_history` sums `balance_snapshots` by date with **no join
   to `accounts`**, orphaned snapshots double-count net worth on overlap dates.

This helper makes the reset safe, consistent, and repeatable for any or all
connections.

## Goals

- One command/button to retire an Item at Plaid and reset its local state to a
  clean slate, ready for a fresh re-link that pulls 730 days.
- **Correctness first:** no partial state, no orphans, no double-counting; every
  destructive step is preceded by a recoverable one.
- Works for a single connection or all of them.

## Non-goals

- Performing the Plaid Link flow itself (stays interactive in the browser at
  `:8765`). The helper resets; the user re-links.
- Preserving point-in-time snapshot history across the reset (see Decision 1).
- Account-identity continuity / remapping new `account_id`s to old ones (YAGNI;
  snapshot history is currently ~6 days deep).

## Decisions (from brainstorming)

1. **Snapshot history → full clean wipe + JSON backup.** Delete *all* rows for
   the item, including the non-refetchable balance/holdings/liabilities
   snapshots, after dumping them to a timestamped JSON backup. Chosen over
   "preserve snapshots" (transient net-worth double-count = inconsistency) and
   "account-identity continuity" (over-engineered for ~6 days of history).
   Rationale: a clean slate is internally *consistent*; lossy ≠ inconsistent,
   and the backup makes the loss recoverable.
2. **Plaid `/item/remove` → yes, remove at Plaid first** to stop billing and
   truly free the Item. On failure, abort before touching local data.
   `ITEM_NOT_FOUND` is treated as already-removed and proceeds.
3. **Interface → CLI + dashboard button.** A `reset_item.py` CLI (mirrors the
   `secure_tokens.py` style) plus a "Reset & re-link" control on the `:8765`
   Connections page.

## Architecture

A single shared core module, **`reset_item.py`**, owns all logic. The CLI and
the `link_helper` dashboard endpoint are thin wrappers. This mirrors the
codebase's existing "one shared shaper" pattern (`shape_investment_transaction`
is shared by the live and DB tools so they cannot drift). Putting the logic in
`storage.py` would mix a Plaid `/item/remove` concern into the storage layer;
duplicating it across CLI and UI would invite drift. One module → one test
target → one source of truth.

### Module API (`reset_item.py`)

```
preview_reset(env_key, *, db_url=None) -> dict
    # row counts per table for item_key; no mutation. The dry run.

reset_item(env_key, *, confirm=False, api=None, db_url=None,
           tokens_url=None, now=None) -> ResetResult
    # full ordered sequence; confirm=False returns the preview only.

reset_all(*, confirm=False, api=None, db_url=None, tokens_url=None,
          now=None) -> list[ResetResult]
    # loops load_tokens() keys; one backup file per item.

restore_from_backup(path, *, db_url=None) -> dict
    # re-inserts backed-up DATA rows (not the token). Honors recoverability.
```

`ResetResult` carries: `env_key`, `institution`, `deleted` (per-table counts),
`backup_path`, `plaid_removed` (bool / "already_absent"), and `token_cleared`
(stores cleared).

### The ordered, multi-store sequence (`reset_item`)

Refined so the only irreversible action happens *after* every recoverable one:

1. **Resolve & validate.** Normalize `env_key` via `secure_tokens._norm`
   (strips `PLAID_TOKEN_`, uppercases). Load the token from the token store. No
   token → raise (`unknown or already-cleared connection`). Resolve institution
   name for logging/result.
2. **Preview.** Count rows per `item_key` table. If `confirm=False`, return the
   preview and stop.
3. **Backup first (read-only).** `SELECT *` for `item_key` across the 7 data
   tables → write `resets/<KEY>-<YYYY-MM-DD-HHMMSS>.json`. If the write fails →
   abort; nothing has changed. **The token row is excluded** (encrypted secret,
   useless after removal — never written to disk).
4. **Plaid `/item/remove`** (irreversible). `ItemRemoveRequest(access_token=…)`.
   On `ITEM_NOT_FOUND` → treat as already-removed, continue. On any other
   failure → **abort; local data still intact**.
5. **Atomic local wipe.** A single Neon (`DATABASE_URL`) transaction deletes from
   all 7 `item_key` tables:
   `accounts, transactions, investment_transactions, balance_snapshots,
   holdings_snapshots, liabilities_snapshots, sync_state`. Plus
   `transaction_tags` rows for this item's transactions (tags are keyed by
   `transaction_id`, so they are deleted in the same transaction *before* the
   `transactions` rows, to avoid orphan tags). One transaction → no partial
   state.
6. **Clear the token from BOTH stores.** `secure_tokens.remove_token` against the
   local store (`PFM_TOKENS_DATABASE_URL`) **and** Neon (`DATABASE_URL`)
   `plaid_tokens`. Mandatory under the two-database design, or the Lambda keeps
   syncing a removed Item from the Neon copy.
7. **Report.** Per-table deleted counts, backup path, next step ("re-link at
   :8765").

### Correctness guarantees

- **Scope is strictly `WHERE item_key = %s`.** `category_overrides`
  (institution-independent rules) is never touched. Other items' rows in every
  table are untouched — verified by an explicit test.
- **No orphan tags.** `transaction_tags` for the item are deleted in the same
  transaction as its `transactions`.
- **Idempotent / re-runnable.** `ITEM_NOT_FOUND` proceeds; `DELETE … WHERE` and
  token removal are naturally idempotent. A re-run after interruption converges.
- **Recoverable.** The JSON backup of all data rows enables `restore_from_backup`
  (re-inserts data only; the Item is gone at Plaid, so the token is not
  restored — restored rows are read-only history).

### Two-database map (why each store is touched)

- History data (7 tables): Neon `DATABASE_URL` only.
- Token (`plaid_tokens`): local `PFM_TOKENS_DATABASE_URL` **and** Neon copy.
- Plaid `/item/remove`: uses the token loaded in step 1.

## Interface

### CLI (`python reset_item.py …`)

```
python reset_item.py CHASE             # dry-run preview (counts, no changes)
python reset_item.py CHASE --confirm   # execute the reset
python reset_item.py --all --confirm   # reset every connection (preview first)
python reset_item.py restore resets/CHASE-2026-06-13-104500.json
```

`--all` prints a full preview and requires `--confirm`. Mirrors the
`secure_tokens.py` argparse style.

### Dashboard

- `POST /reset-item {env_key}` in `link_helper.py` → calls
  `reset_item(env_key, confirm=True)`.
- Add `reset-item` to the Next.js `/api/link/[...path]` proxy allowlist
  (`dashboard/src/app/api/link/[...path]/route.ts`).
- Connections page: a per-bank **"Reset & re-link"** button → confirm modal
  (names the bank, warns it removes the Plaid Item and wipes local history with a
  backup) → `POST /reset-item` → on success, chain into the existing Link flow.

## Testing (correctness is the priority)

Against the test Postgres `db` fixture, Plaid mocked:

- **Happy path + isolation guard:** seed all 7 tables + token for `CHASE` and an
  untouched `SOFI`. Reset `CHASE` → assert every `CHASE` row gone, token gone
  from **both** stores, backup file written with correct row contents, and
  **every `SOFI` row intact** (the consistency guard).
- **Abort on Plaid failure:** `item_remove` raises a non-`ITEM_NOT_FOUND` error
  → assert **nothing** deleted (rows + token + no orphan state).
- **Dry run:** `confirm=False` → preview counts correct, zero deletions.
- **Already-removed:** `item_remove` raises `ITEM_NOT_FOUND` → proceeds to wipe.
- **No orphan tags:** seed `transaction_tags` for `CHASE` txns → gone after reset.
- **Restore:** `restore_from_backup` re-inserts the data rows.
- **`--all`:** every connection reset, one backup per item.
- **link_helper endpoint:** `POST /reset-item` (mocked `api`) returns the result;
  proxy allowlist test (dashboard vitest) includes `reset-item`.

## Housekeeping

- `resets/` added to `.gitignore` (contains financial data: balances,
  transactions).
- No schema changes. No new dependencies.

## Risks & mitigations

- **Irreversible Plaid removal.** Mitigated by ordering (backup before remove)
  and dry-run-by-default.
- **Multi-store, non-transactional across Plaid + 2 DBs.** Mitigated by ordering
  (irreversible step late), idempotent re-runs, and the backup.
- **Net-worth history shape during a staggered `--all`.** Resetting banks on
  different days makes `net_worth_history` jagged mid-migration. Acceptable:
  snapshot history is ~6 days deep now and rebuilds forward; documented in the
  CLI output.
- **Env-var-sourced tokens.** `load_tokens()` also honors `PLAID_TOKEN_*` env
  vars, which cannot be cleared by `remove_token` (they live in the environment,
  not `plaid_tokens`). The helper detects this case and **refuses with a clear
  message** ("token is env-var-backed; unset `PLAID_TOKEN_<KEY>` and retry")
  rather than removing the Item at Plaid while leaving a token the next process
  would re-load. In this deployment all six tokens are DB-stored, so this is a
  guard, not a common path.
