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
