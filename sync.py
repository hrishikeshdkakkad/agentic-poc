"""Ingestion: /transactions/sync cursor flow plus dated snapshots.

Used two ways:
- the ``sync_now`` MCP tool in server.py calls ``run_sync``
- ``python sync.py`` is a cron-able CLI entrypoint (no daemon)

Pages from /transactions/sync are accumulated in memory and written together
with the new cursor in one database transaction (see storage.apply_transactions_sync),
so an interrupted run resumes from the last durable cursor and re-runs are
idempotent. TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION restarts pagination
from that cursor, per Plaid's documented contract.
"""
from __future__ import annotations

import json
import logging
import sys
from datetime import date, timedelta

from plaid.exceptions import ApiException
from plaid.model.accounts_balance_get_request import AccountsBalanceGetRequest
from plaid.model.investments_holdings_get_request import InvestmentsHoldingsGetRequest
from plaid.model.liabilities_get_request import LiabilitiesGetRequest
from plaid.model.transactions_sync_request import TransactionsSyncRequest

import config_secrets
import storage
from plaid_client import (
    ItemHealth, SecretStr, all_items, build_api,
    fetch_investment_transactions, map_plaid_error,
)

_log = logging.getLogger("plaid_mcp.sync")

_MUTATION_ERROR = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"
_MAX_RESTARTS = 3

# Investments has no incremental cursor (unlike /transactions/sync), so each run
# pulls a date window and relies on the investment_transaction_id PK to dedup.
# Scheduled runs use a rolling window; --backfill-investments seeds deep history.
_INVEST_LOOKBACK_DAYS = 45          # rolling window vs the ~4h schedule
_INVEST_BACKFILL_DAYS = 730         # ~24 months: Plaid's maximum investments window


def investment_sync_window(backfill: bool, today: date | None = None) -> tuple[str, str]:
    """Return the ISO (start_date, end_date) for /investments/transactions/get.

    Scheduled runs pull a rolling 45-day window (generous overlap with the ~4h
    cadence; the overlap is free because the PK dedups). The one-shot backfill
    pulls ~24 months, Plaid's maximum.
    """
    end = today or date.today()
    span = _INVEST_BACKFILL_DAYS if backfill else _INVEST_LOOKBACK_DAYS
    return (end - timedelta(days=span)).isoformat(), end.isoformat()


def _sync_item_transactions(api, conn, env_key: str, token: SecretStr) -> dict:
    """Run the cursor flow to completion for one Item and persist results."""
    restarts = 0
    while True:
        cursor = storage.get_cursor(conn, env_key)
        added: list[dict] = []
        modified: list[dict] = []
        removed: list[str] = []
        try:
            while True:
                kwargs: dict = {"access_token": token.reveal(), "count": 500}
                if cursor:
                    kwargs["cursor"] = cursor
                resp = api.transactions_sync(TransactionsSyncRequest(**kwargs)).to_dict()
                added.extend(resp.get("added") or [])
                modified.extend(resp.get("modified") or [])
                removed.extend(
                    r.get("transaction_id")
                    for r in (resp.get("removed") or [])
                    if r.get("transaction_id")
                )
                cursor = resp.get("next_cursor")
                if not resp.get("has_more"):
                    break
            return storage.apply_transactions_sync(
                conn, env_key, added, modified, removed, cursor or ""
            )
        except ApiException as e:
            body: dict = {}
            try:
                parsed = json.loads(getattr(e, "body", "") or "{}")
                body = parsed if isinstance(parsed, dict) else {}
            except (ValueError, TypeError):
                pass
            if body.get("error_code") == _MUTATION_ERROR and restarts < _MAX_RESTARTS:
                restarts += 1
                _log.info("sync mutation during pagination, restarting item=%s", env_key)
                continue
            raise


def snapshot_item(api, conn, env_key: str, token: SecretStr, health: ItemHealth) -> tuple[dict, list[dict]]:
    """Append today's balance, holdings, and liabilities snapshots for one Item."""
    counts = {"balances": 0, "holdings": 0, "liabilities": 0}
    warnings: list[dict] = []

    resp = api.accounts_balance_get(
        AccountsBalanceGetRequest(access_token=token.reveal())
    ).to_dict()
    raw_accounts = resp.get("accounts") or []
    storage.upsert_accounts(conn, env_key, health.institution_name, raw_accounts)
    counts["balances"] = storage.record_balance_snapshots(
        conn, env_key, health.institution_name, raw_accounts
    )

    try:
        h_resp = api.investments_holdings_get(
            InvestmentsHoldingsGetRequest(access_token=token.reveal())
        ).to_dict()
        secs = {s["security_id"]: s for s in h_resp.get("securities") or []}
        counts["holdings"] = storage.record_holdings_snapshots(
            conn, env_key, h_resp.get("holdings") or [], secs
        )
    except ApiException as e:
        warnings.append({
            "institution": health.institution_name,
            **map_plaid_error(e, health.institution_name)["error"],
            "scope": "holdings",
        })

    try:
        l_resp = api.liabilities_get(
            LiabilitiesGetRequest(access_token=token.reveal())
        ).to_dict()
        balances_by_account = {
            a["account_id"]: (a.get("balances") or {})
            for a in l_resp.get("accounts") or []
            if a.get("account_id")
        }
        counts["liabilities"] = storage.record_liabilities_snapshots(
            conn, env_key, l_resp.get("liabilities") or {}, balances_by_account
        )
    except ApiException as e:
        warnings.append({
            "institution": health.institution_name,
            **map_plaid_error(e, health.institution_name)["error"],
            "scope": "liabilities",
        })

    return counts, warnings


def _sync_item_investments(
    api, conn, env_key: str, token: SecretStr, window: tuple[str, str]
) -> int:
    """Fetch and persist investment transactions for one Item over ``window``.

    Raises ApiException on Plaid failure (run_sync maps it to a warning with
    scope=investment_transactions), so an Item lacking the investments-transactions
    consent -- e.g. an investment-only item never authorized for it -- never sinks
    the run. Returns the number of rows written.
    """
    start, end = window
    rows = fetch_investment_transactions(api, token, start, end)
    return storage.record_investment_transactions(conn, env_key, rows)


def run_sync(api=None, db_url: str | None = None,
             investments_backfill: bool = False) -> dict:
    """Sync transactions and record snapshots for every healthy Item.

    Returns per-item results plus warnings for unhealthy Items or API errors.
    Safe to re-run: transaction upserts are keyed by transaction_id and
    snapshots by (date, account, ...), so duplicates cannot accumulate.
    """
    api = api or build_api()
    conn = storage.open_db(db_url)
    inv_window = investment_sync_window(investments_backfill)
    items_out: list[dict] = []
    warnings: list[dict] = []
    try:
        for env_key, token, health in all_items(api):
            if health.status != "healthy":
                warnings.append({
                    "institution": health.institution_name or env_key,
                    "status": health.status,
                    "reason": health.reason,
                })
                continue
            entry: dict = {"item_key": env_key, "institution": health.institution_name}
            try:
                entry["transactions"] = _sync_item_transactions(api, conn, env_key, token)
            except ApiException as e:
                warnings.append({
                    "institution": health.institution_name,
                    **map_plaid_error(e, health.institution_name)["error"],
                    "scope": "transactions_sync",
                })
                entry["transactions"] = None
            try:
                counts, snap_warnings = snapshot_item(api, conn, env_key, token, health)
                entry["snapshots"] = counts
                warnings.extend(snap_warnings)
            except ApiException as e:
                warnings.append({
                    "institution": health.institution_name,
                    **map_plaid_error(e, health.institution_name)["error"],
                    "scope": "snapshots",
                })
                entry["snapshots"] = None
            # Only items with an investment account have an investments product to
            # query; skip the rest to avoid pointless Plaid calls and warning noise.
            # snapshot_item upserted accounts just above, so this read is current.
            has_investments = conn.execute(
                "SELECT 1 FROM accounts WHERE item_key = %s AND type = 'investment' LIMIT 1",
                (env_key,),
            ).fetchone() is not None
            if has_investments:
                try:
                    entry["investment_transactions"] = _sync_item_investments(
                        api, conn, env_key, token, inv_window
                    )
                except ApiException as e:
                    warnings.append({
                        "institution": health.institution_name,
                        **map_plaid_error(e, health.institution_name)["error"],
                        "scope": "investment_transactions",
                    })
                    entry["investment_transactions"] = None
            items_out.append(entry)
        tags = storage.apply_tags(conn)  # keep rule-based tags (e.g. delivery) current
        storage.apply_overrides(conn)    # re-apply user category corrections post-sync
        total_tx = conn.execute("SELECT count(*) FROM transactions").fetchone()[0]
    finally:
        conn.close()
    return {"items": items_out, "total_transactions_stored": total_tx,
            "tags": tags, "warnings": warnings}


def lambda_handler(event=None, context=None) -> dict:
    """EventBridge Scheduler entrypoint: run one sync pass.

    Secrets are loaded from SSM (see config_secrets) before Plaid or the
    database is touched. A total failure (e.g. database unreachable) propagates
    so the schedule's retry kicks in; per-Item issues are captured as warnings
    by run_sync, not raised -- sync is idempotent, so the next scheduled run
    heals them. Token material is never logged or returned (warnings carry
    institution + Plaid error code/category only).
    """
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    config_secrets.load_into_env()
    if isinstance(event, dict) and event.get("dry_run"):
        # Non-mutating health check (used by CI smoke after deploy): prove the
        # config loaded from SSM and the history DB is reachable on the
        # read-only path, without running a sync.
        conn = storage.open_readonly()
        try:
            conn.execute("SELECT 1")
        finally:
            conn.close()
        _log.info("sync dry_run ok")
        return {"ok": True, "dry_run": True}
    backfill = isinstance(event, dict) and bool(event.get("investments_backfill"))
    if backfill:
        _log.info("one-shot investments backfill requested (~24 months)")
    result = run_sync(investments_backfill=backfill)
    items = result.get("items") or []
    warnings = result.get("warnings") or []
    _log.info(
        "sync complete: items=%d warnings=%d total_transactions=%s",
        len(items), len(warnings), result.get("total_transactions_stored"),
    )
    return {
        "ok": True,
        "items_synced": len(items),
        "warnings": warnings,
        "total_transactions_stored": result.get("total_transactions_stored"),
    }


def main() -> int:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass
    config_secrets.load_into_env()
    backfill = "--backfill-investments" in sys.argv
    if backfill:
        _log.info("investments backfill mode: pulling ~24 months of history")
    result = run_sync(investments_backfill=backfill)
    print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
