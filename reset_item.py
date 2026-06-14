"""Safely retire a Plaid Item and reset its local state for a fresh re-link.

Re-linking is the only way to deepen an existing Item's transaction history
(days_requested is immutable once set). This helper removes the old Item at
Plaid, backs up and wipes its local rows, and clears its token from both the
local and Neon stores, leaving a clean slate to re-link with days_requested=730.

See docs/superpowers/specs/2026-06-13-item-reset-helper-design.md.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

import storage
import secure_tokens
import plaid_client
from plaid.exceptions import ApiException
from plaid.model.item_remove_request import ItemRemoveRequest

# Tables keyed by item_key. Ordered child-first (snapshots/investments before
# accounts) for readable backups; the wipe also removes transaction_tags, which
# are keyed by transaction_id rather than item_key (handled separately).
_ITEM_TABLES = (
    "balance_snapshots",
    "holdings_snapshots",
    "liabilities_snapshots",
    "investment_transactions",
    "accounts",
    "transactions",
    "sync_state",
)

_BACKUP_DIR = "resets"


@dataclass
class ResetResult:
    env_key: str
    institution: str | None
    deleted: dict = field(default_factory=dict)
    backup_path: str | None = None
    plaid_removed: str = "skipped"   # "removed" | "already_absent" | "skipped"
    token_cleared: list = field(default_factory=list)
    dry_run: bool = False


def preview_reset(env_key: str, *, db_url: str | None = None) -> dict:
    """Return per-table row counts for this item_key. No mutation."""
    key = secure_tokens._norm(env_key)
    conn = storage.open_readonly(db_url)
    try:
        counts = {
            "transaction_tags": conn.execute(
                "SELECT count(*) FROM transaction_tags t "
                "JOIN transactions x ON t.transaction_id = x.transaction_id "
                "WHERE x.item_key = %s",
                (key,),
            ).fetchone()[0]
        }
        for table in _ITEM_TABLES:
            counts[table] = conn.execute(
                f"SELECT count(*) FROM {table} WHERE item_key = %s", (key,)
            ).fetchone()[0]
    finally:
        conn.close()
    return counts


def _rows(conn, sql: str, params: tuple) -> list[dict]:
    cur = conn.execute(sql, params)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def _backup(env_key: str, db_url: str | None, now) -> str:
    key = secure_tokens._norm(env_key)
    conn = storage.open_readonly(db_url)
    try:
        tables = {
            "transaction_tags": _rows(
                conn,
                "SELECT t.* FROM transaction_tags t "
                "JOIN transactions x ON t.transaction_id = x.transaction_id "
                "WHERE x.item_key = %s",
                (key,),
            )
        }
        for table in _ITEM_TABLES:
            tables[table] = _rows(
                conn, f"SELECT * FROM {table} WHERE item_key = %s", (key,)
            )
    finally:
        conn.close()
    data = {"env_key": key, "backed_up_at": now.isoformat(), "tables": tables}
    os.makedirs(_BACKUP_DIR, exist_ok=True)
    path = os.path.join(_BACKUP_DIR, f"{key}-{now:%Y-%m-%d-%H%M%S}.json")
    with open(path, "w") as fh:
        json.dump(data, fh, indent=2, default=str)
    return path


def _is_item_not_found(exc: ApiException) -> bool:
    try:
        body = json.loads(getattr(exc, "body", "") or "{}")
    except (ValueError, TypeError):
        return False
    return isinstance(body, dict) and body.get("error_code") == "ITEM_NOT_FOUND"


def _institution(key: str, db_url: str | None) -> str | None:
    conn = storage.open_readonly(db_url)
    try:
        row = conn.execute(
            "SELECT institution FROM accounts WHERE item_key = %s LIMIT 1", (key,)
        ).fetchone()
    finally:
        conn.close()
    return row[0] if row else None


def _wipe(key: str, db_url: str | None) -> dict:
    conn = storage.open_db(db_url)
    deleted: dict = {}
    try:
        with conn.transaction():
            cur = conn.execute(
                "DELETE FROM transaction_tags WHERE transaction_id IN "
                "(SELECT transaction_id FROM transactions WHERE item_key = %s)",
                (key,),
            )
            deleted["transaction_tags"] = cur.rowcount
            for table in _ITEM_TABLES:
                cur = conn.execute(
                    f"DELETE FROM {table} WHERE item_key = %s", (key,)
                )
                deleted[table] = cur.rowcount
    finally:
        conn.close()
    return deleted


def reset_item(env_key: str, *, confirm: bool = False, api=None,
               db_url: str | None = None, tokens_url: str | None = None,
               now=None) -> ResetResult:
    from datetime import datetime

    key = secure_tokens._norm(env_key)
    db_url = db_url or storage.database_url()
    tokens_url = tokens_url or secure_tokens._tokens_db_url() or db_url

    if os.environ.get(f"PLAID_TOKEN_{key}"):
        raise RuntimeError(
            f"{key} token is env-var-backed; unset PLAID_TOKEN_{key} and retry"
        )

    token = plaid_client.load_tokens().get(key)
    if token is None:
        raise RuntimeError(
            f"no token for {key}: unknown or already-cleared connection"
        )

    institution = _institution(key, db_url)
    preview = preview_reset(key, db_url=db_url)

    if not confirm:
        return ResetResult(key, institution, deleted=preview, dry_run=True)

    now = now or datetime.now()
    backup_path = _backup(key, db_url, now)

    api = api or plaid_client.build_api()
    try:
        api.item_remove(ItemRemoveRequest(access_token=token.reveal()))
        plaid_removed = "removed"
    except ApiException as exc:
        if not _is_item_not_found(exc):
            raise  # abort: local data + token untouched
        plaid_removed = "already_absent"

    deleted = _wipe(key, db_url)

    cleared: list = []
    for url in dict.fromkeys([tokens_url, db_url]):  # dedupe, keep order
        if secure_tokens.remove_token(key, url=url):
            cleared.append(url)

    return ResetResult(key, institution, deleted=deleted,
                       backup_path=backup_path, plaid_removed=plaid_removed,
                       token_cleared=cleared)


def reset_all(*, confirm: bool = False, api=None, db_url: str | None = None,
              tokens_url: str | None = None, now=None) -> list:
    api = api or plaid_client.build_api()
    results = []
    for key in list(plaid_client.load_tokens().keys()):
        results.append(
            reset_item(key, confirm=confirm, api=api, db_url=db_url,
                       tokens_url=tokens_url, now=now)
        )
    return results
