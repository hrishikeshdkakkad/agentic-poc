"""DuckDB storage layer for transaction history and snapshots.

All writes go through a single read-write connection per call; query tools
use a separate read-only connection (see ``open_readonly``). The DB file
location defaults to ./data/finance.duckdb and can be overridden with the
FINANCE_DB_PATH env var.

Plaid sign convention is preserved as-is: transaction ``amount`` is positive
for outflows (spending) and negative for inflows.
"""
from __future__ import annotations

import os
from datetime import date, datetime, timezone

import duckdb

DEFAULT_DB_PATH = os.path.join("data", "finance.duckdb")


def db_path() -> str:
    return os.environ.get("FINANCE_DB_PATH", DEFAULT_DB_PATH)


_SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    account_id TEXT PRIMARY KEY,
    item_key TEXT,
    institution TEXT,
    name TEXT,
    official_name TEXT,
    mask TEXT,
    type TEXT,
    subtype TEXT,
    currency TEXT,
    updated_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transactions (
    transaction_id TEXT PRIMARY KEY,
    account_id TEXT,
    item_key TEXT,
    date DATE,
    authorized_date DATE,
    amount DOUBLE,
    currency TEXT,
    merchant TEXT,
    name TEXT,
    category_primary TEXT,
    category_detailed TEXT,
    pending BOOLEAN,
    updated_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS balance_snapshots (
    snapshot_date DATE,
    snapshot_ts TIMESTAMP,
    account_id TEXT,
    item_key TEXT,
    institution TEXT,
    type TEXT,
    subtype TEXT,
    current DOUBLE,
    available DOUBLE,
    credit_limit DOUBLE,
    currency TEXT,
    PRIMARY KEY (snapshot_date, account_id)
);

CREATE TABLE IF NOT EXISTS holdings_snapshots (
    snapshot_date DATE,
    snapshot_ts TIMESTAMP,
    account_id TEXT,
    item_key TEXT,
    security_id TEXT,
    symbol TEXT,
    security_name TEXT,
    security_type TEXT,
    quantity DOUBLE,
    price DOUBLE,
    market_value DOUBLE,
    cost_basis DOUBLE,
    currency TEXT,
    PRIMARY KEY (snapshot_date, account_id, security_id)
);

CREATE TABLE IF NOT EXISTS liabilities_snapshots (
    snapshot_date DATE,
    snapshot_ts TIMESTAMP,
    account_id TEXT,
    item_key TEXT,
    liability_type TEXT,
    outstanding_balance DOUBLE,
    apr_percentage DOUBLE,
    interest_rate_percentage DOUBLE,
    minimum_payment_amount DOUBLE,
    next_payment_due_date DATE,
    is_overdue BOOLEAN,
    currency TEXT,
    PRIMARY KEY (snapshot_date, account_id, liability_type)
);

CREATE TABLE IF NOT EXISTS sync_state (
    item_key TEXT PRIMARY KEY,
    cursor TEXT,
    last_synced_at TIMESTAMP,
    tx_added BIGINT DEFAULT 0,
    tx_modified BIGINT DEFAULT 0,
    tx_removed BIGINT DEFAULT 0
);
"""


def open_db(path: str | None = None) -> duckdb.DuckDBPyConnection:
    """Open (creating if needed) the finance DB and ensure the schema exists."""
    p = path or db_path()
    parent = os.path.dirname(p)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = duckdb.connect(p)
    conn.execute(_SCHEMA)
    return conn


def open_readonly(path: str | None = None) -> duckdb.DuckDBPyConnection:
    """Open a read-only connection for query tools. The DB must exist."""
    p = path or db_path()
    if not os.path.exists(p):
        # Create the schema first so read-only queries against a fresh
        # install see empty tables instead of a missing-file error.
        open_db(p).close()
    return duckdb.connect(p, read_only=True)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def upsert_accounts(conn: duckdb.DuckDBPyConnection, item_key: str,
                    institution: str | None, raw_accounts: list[dict]) -> int:
    rows = [
        (
            a.get("account_id"),
            item_key,
            institution,
            a.get("name"),
            a.get("official_name"),
            a.get("mask"),
            str(a.get("type")) if a.get("type") is not None else None,
            str(a.get("subtype")) if a.get("subtype") is not None else None,
            (a.get("balances") or {}).get("iso_currency_code"),
            _now(),
        )
        for a in raw_accounts
        if a.get("account_id")
    ]
    if rows:
        conn.executemany(
            "INSERT OR REPLACE INTO accounts VALUES (?,?,?,?,?,?,?,?,?,?)", rows
        )
    return len(rows)


def _tx_row(raw: dict, item_key: str) -> tuple:
    pfc = raw.get("personal_finance_category") or {}
    d = raw.get("date")
    ad = raw.get("authorized_date")
    return (
        raw.get("transaction_id"),
        raw.get("account_id"),
        item_key,
        str(d) if d else None,
        str(ad) if ad else None,
        raw.get("amount"),
        raw.get("iso_currency_code"),
        raw.get("merchant_name") or raw.get("name"),
        raw.get("name"),
        pfc.get("primary"),
        pfc.get("detailed"),
        bool(raw.get("pending")),
        _now(),
    )


def apply_transactions_sync(
    conn: duckdb.DuckDBPyConnection,
    item_key: str,
    added: list[dict],
    modified: list[dict],
    removed: list[str],
    cursor: str,
) -> dict:
    """Apply one completed /transactions/sync pass atomically.

    Upserts added+modified by transaction_id, deletes removed, and persists
    the cursor — all in one DuckDB transaction so a crash never leaves the
    cursor ahead of the data. Re-running with the same payload is a no-op.
    """
    upserts = [
        _tx_row(t, item_key)
        for t in list(added) + list(modified)
        if t.get("transaction_id")
    ]
    conn.execute("BEGIN TRANSACTION")
    try:
        if upserts:
            conn.executemany(
                "INSERT OR REPLACE INTO transactions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                upserts,
            )
        if removed:
            conn.executemany(
                "DELETE FROM transactions WHERE transaction_id = ?",
                [(tid,) for tid in removed],
            )
        conn.execute(
            """
            INSERT INTO sync_state (item_key, cursor, last_synced_at, tx_added, tx_modified, tx_removed)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (item_key) DO UPDATE SET
                cursor = excluded.cursor,
                last_synced_at = excluded.last_synced_at,
                tx_added = sync_state.tx_added + excluded.tx_added,
                tx_modified = sync_state.tx_modified + excluded.tx_modified,
                tx_removed = sync_state.tx_removed + excluded.tx_removed
            """,
            (item_key, cursor, _now(), len(added), len(modified), len(removed)),
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return {"added": len(added), "modified": len(modified), "removed": len(removed)}


def get_cursor(conn: duckdb.DuckDBPyConnection, item_key: str) -> str | None:
    row = conn.execute(
        "SELECT cursor FROM sync_state WHERE item_key = ?", (item_key,)
    ).fetchone()
    return row[0] if row else None


def record_balance_snapshots(
    conn: duckdb.DuckDBPyConnection,
    item_key: str,
    institution: str | None,
    raw_accounts: list[dict],
    snapshot_date: date | None = None,
) -> int:
    sd = (snapshot_date or date.today()).isoformat()
    ts = _now()
    rows = []
    for a in raw_accounts:
        if not a.get("account_id"):
            continue
        bals = a.get("balances") or {}
        rows.append((
            sd, ts, a["account_id"], item_key, institution,
            str(a.get("type")) if a.get("type") is not None else None,
            str(a.get("subtype")) if a.get("subtype") is not None else None,
            bals.get("current"), bals.get("available"), bals.get("limit"),
            bals.get("iso_currency_code"),
        ))
    if rows:
        conn.executemany(
            "INSERT OR REPLACE INTO balance_snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
    return len(rows)


def record_holdings_snapshots(
    conn: duckdb.DuckDBPyConnection,
    item_key: str,
    raw_holdings: list[dict],
    securities_by_id: dict[str, dict],
    snapshot_date: date | None = None,
) -> int:
    sd = (snapshot_date or date.today()).isoformat()
    ts = _now()
    rows = []
    for h in raw_holdings:
        if not h.get("account_id"):
            continue
        sec = securities_by_id.get(h.get("security_id"), {})
        rows.append((
            sd, ts, h["account_id"], item_key,
            h.get("security_id") or "",
            sec.get("ticker_symbol"), sec.get("name"), sec.get("type"),
            h.get("quantity"), h.get("institution_price"),
            h.get("institution_value"), h.get("cost_basis"),
            h.get("iso_currency_code"),
        ))
    if rows:
        conn.executemany(
            "INSERT OR REPLACE INTO holdings_snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
    return len(rows)


def record_liabilities_snapshots(
    conn: duckdb.DuckDBPyConnection,
    item_key: str,
    liabilities: dict,
    balances_by_account: dict[str, dict],
    snapshot_date: date | None = None,
) -> int:
    """Snapshot liability detail joined with the account's current balance.

    ``liabilities`` is the raw ``liabilities`` object from /liabilities/get;
    ``balances_by_account`` maps account_id -> raw balances dict from the
    same response, used for outstanding_balance.
    """
    sd = (snapshot_date or date.today()).isoformat()
    ts = _now()
    rows = []

    def bal(account_id: str | None) -> tuple[float | None, str | None]:
        b = balances_by_account.get(account_id or "", {})
        return b.get("current"), b.get("iso_currency_code")

    for c in liabilities.get("credit") or []:
        aprs = c.get("aprs") or []
        apr_entry = next(
            (a for a in aprs if a.get("apr_type") == "purchase_apr"),
            aprs[0] if aprs else {},
        )
        outstanding, currency = bal(c.get("account_id"))
        due = c.get("next_payment_due_date")
        rows.append((
            sd, ts, c.get("account_id") or "", item_key, "credit",
            outstanding, apr_entry.get("apr_percentage"), None,
            c.get("minimum_payment_amount"),
            str(due) if due else None,
            c.get("is_overdue"), currency,
        ))
    for s in liabilities.get("student") or []:
        outstanding, currency = bal(s.get("account_id"))
        due = s.get("next_payment_due_date")
        rows.append((
            sd, ts, s.get("account_id") or "", item_key, "student",
            outstanding, None, s.get("interest_rate_percentage"),
            s.get("minimum_payment_amount"),
            str(due) if due else None,
            s.get("is_overdue"), currency,
        ))
    for m in liabilities.get("mortgage") or []:
        outstanding, currency = bal(m.get("account_id"))
        interest = m.get("interest_rate") or {}
        due = m.get("next_payment_due_date")
        rows.append((
            sd, ts, m.get("account_id") or "", item_key, "mortgage",
            outstanding, None, interest.get("percentage"),
            None,
            str(due) if due else None,
            None, currency,
        ))
    if rows:
        conn.executemany(
            "INSERT OR REPLACE INTO liabilities_snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
    return len(rows)
