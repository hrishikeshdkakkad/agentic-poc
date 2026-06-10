"""Postgres storage layer for transaction history and snapshots (Neon-ready).

Set DATABASE_URL to any Postgres connection string — for Neon:
    postgresql://USER:PASSWORD@ep-xxx-xxx.aws.neon.tech/finance?sslmode=require

Writes use short-lived connections opened per call; query tools use a
read-only connection (``open_readonly``) whose transactions are forced
read-only server-side.

Plaid sign convention is preserved as-is: transaction ``amount`` is positive
for outflows (spending) and negative for inflows.
"""
from __future__ import annotations

import os
from datetime import date, datetime, timezone

import psycopg


def database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL is not set. Point it at your Postgres database, "
            "e.g. a Neon connection string ending in ?sslmode=require"
        )
    return url


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
    updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS transactions (
    transaction_id TEXT PRIMARY KEY,
    account_id TEXT,
    item_key TEXT,
    date DATE,
    authorized_date DATE,
    amount DOUBLE PRECISION,
    currency TEXT,
    merchant TEXT,
    name TEXT,
    category_primary TEXT,
    category_detailed TEXT,
    pending BOOLEAN,
    updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions (date);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions (category_primary);

CREATE TABLE IF NOT EXISTS balance_snapshots (
    snapshot_date DATE,
    snapshot_ts TIMESTAMPTZ,
    account_id TEXT,
    item_key TEXT,
    institution TEXT,
    type TEXT,
    subtype TEXT,
    current DOUBLE PRECISION,
    available DOUBLE PRECISION,
    credit_limit DOUBLE PRECISION,
    currency TEXT,
    PRIMARY KEY (snapshot_date, account_id)
);

CREATE TABLE IF NOT EXISTS holdings_snapshots (
    snapshot_date DATE,
    snapshot_ts TIMESTAMPTZ,
    account_id TEXT,
    item_key TEXT,
    security_id TEXT,
    symbol TEXT,
    security_name TEXT,
    security_type TEXT,
    quantity DOUBLE PRECISION,
    price DOUBLE PRECISION,
    market_value DOUBLE PRECISION,
    cost_basis DOUBLE PRECISION,
    currency TEXT,
    PRIMARY KEY (snapshot_date, account_id, security_id)
);

CREATE TABLE IF NOT EXISTS liabilities_snapshots (
    snapshot_date DATE,
    snapshot_ts TIMESTAMPTZ,
    account_id TEXT,
    item_key TEXT,
    liability_type TEXT,
    outstanding_balance DOUBLE PRECISION,
    apr_percentage DOUBLE PRECISION,
    interest_rate_percentage DOUBLE PRECISION,
    minimum_payment_amount DOUBLE PRECISION,
    next_payment_due_date DATE,
    is_overdue BOOLEAN,
    currency TEXT,
    PRIMARY KEY (snapshot_date, account_id, liability_type)
);

CREATE TABLE IF NOT EXISTS sync_state (
    item_key TEXT PRIMARY KEY,
    cursor TEXT,
    last_synced_at TIMESTAMPTZ,
    tx_added BIGINT DEFAULT 0,
    tx_modified BIGINT DEFAULT 0,
    tx_removed BIGINT DEFAULT 0
);
"""

_schema_ensured: set[str] = set()


def open_db(url: str | None = None) -> psycopg.Connection:
    """Open a read-write connection, creating the schema on first use."""
    u = url or database_url()
    conn = psycopg.connect(u, autocommit=True)
    if u not in _schema_ensured:
        conn.execute(_SCHEMA)
        _schema_ensured.add(u)
    return conn


def open_readonly(url: str | None = None) -> psycopg.Connection:
    """Open a connection whose transactions are read-only server-side."""
    u = url or database_url()
    if u not in _schema_ensured:
        open_db(u).close()
    return psycopg.connect(
        u, autocommit=True, options="-c default_transaction_read_only=on"
    )


def _now() -> datetime:
    return datetime.now(timezone.utc)


def upsert_accounts(conn: psycopg.Connection, item_key: str,
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
        conn.cursor().executemany(
            """
            INSERT INTO accounts VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (account_id) DO UPDATE SET
                item_key = EXCLUDED.item_key,
                institution = EXCLUDED.institution,
                name = EXCLUDED.name,
                official_name = EXCLUDED.official_name,
                mask = EXCLUDED.mask,
                type = EXCLUDED.type,
                subtype = EXCLUDED.subtype,
                currency = EXCLUDED.currency,
                updated_at = EXCLUDED.updated_at
            """,
            rows,
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


_TX_UPSERT = """
INSERT INTO transactions VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
ON CONFLICT (transaction_id) DO UPDATE SET
    account_id = EXCLUDED.account_id,
    item_key = EXCLUDED.item_key,
    date = EXCLUDED.date,
    authorized_date = EXCLUDED.authorized_date,
    amount = EXCLUDED.amount,
    currency = EXCLUDED.currency,
    merchant = EXCLUDED.merchant,
    name = EXCLUDED.name,
    category_primary = EXCLUDED.category_primary,
    category_detailed = EXCLUDED.category_detailed,
    pending = EXCLUDED.pending,
    updated_at = EXCLUDED.updated_at
"""


def apply_transactions_sync(
    conn: psycopg.Connection,
    item_key: str,
    added: list[dict],
    modified: list[dict],
    removed: list[str],
    cursor: str,
) -> dict:
    """Apply one completed /transactions/sync pass atomically.

    Upserts added+modified by transaction_id, deletes removed, and persists
    the cursor — all in one Postgres transaction so a crash never leaves the
    cursor ahead of the data. Re-running with the same payload is a no-op.
    """
    upserts = [
        _tx_row(t, item_key)
        for t in list(added) + list(modified)
        if t.get("transaction_id")
    ]
    with conn.transaction():
        cur = conn.cursor()
        if upserts:
            cur.executemany(_TX_UPSERT, upserts)
        if removed:
            cur.executemany(
                "DELETE FROM transactions WHERE transaction_id = %s",
                [(tid,) for tid in removed],
            )
        cur.execute(
            """
            INSERT INTO sync_state (item_key, cursor, last_synced_at, tx_added, tx_modified, tx_removed)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (item_key) DO UPDATE SET
                cursor = EXCLUDED.cursor,
                last_synced_at = EXCLUDED.last_synced_at,
                tx_added = sync_state.tx_added + EXCLUDED.tx_added,
                tx_modified = sync_state.tx_modified + EXCLUDED.tx_modified,
                tx_removed = sync_state.tx_removed + EXCLUDED.tx_removed
            """,
            (item_key, cursor, _now(), len(added), len(modified), len(removed)),
        )
    return {"added": len(added), "modified": len(modified), "removed": len(removed)}


def get_cursor(conn: psycopg.Connection, item_key: str) -> str | None:
    row = conn.execute(
        "SELECT cursor FROM sync_state WHERE item_key = %s", (item_key,)
    ).fetchone()
    return row[0] if row else None


def record_balance_snapshots(
    conn: psycopg.Connection,
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
        conn.cursor().executemany(
            """
            INSERT INTO balance_snapshots VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (snapshot_date, account_id) DO UPDATE SET
                snapshot_ts = EXCLUDED.snapshot_ts,
                item_key = EXCLUDED.item_key,
                institution = EXCLUDED.institution,
                type = EXCLUDED.type,
                subtype = EXCLUDED.subtype,
                current = EXCLUDED.current,
                available = EXCLUDED.available,
                credit_limit = EXCLUDED.credit_limit,
                currency = EXCLUDED.currency
            """,
            rows,
        )
    return len(rows)


def record_holdings_snapshots(
    conn: psycopg.Connection,
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
        conn.cursor().executemany(
            """
            INSERT INTO holdings_snapshots VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (snapshot_date, account_id, security_id) DO UPDATE SET
                snapshot_ts = EXCLUDED.snapshot_ts,
                item_key = EXCLUDED.item_key,
                symbol = EXCLUDED.symbol,
                security_name = EXCLUDED.security_name,
                security_type = EXCLUDED.security_type,
                quantity = EXCLUDED.quantity,
                price = EXCLUDED.price,
                market_value = EXCLUDED.market_value,
                cost_basis = EXCLUDED.cost_basis,
                currency = EXCLUDED.currency
            """,
            rows,
        )
    return len(rows)


def record_liabilities_snapshots(
    conn: psycopg.Connection,
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
        conn.cursor().executemany(
            """
            INSERT INTO liabilities_snapshots VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (snapshot_date, account_id, liability_type) DO UPDATE SET
                snapshot_ts = EXCLUDED.snapshot_ts,
                item_key = EXCLUDED.item_key,
                outstanding_balance = EXCLUDED.outstanding_balance,
                apr_percentage = EXCLUDED.apr_percentage,
                interest_rate_percentage = EXCLUDED.interest_rate_percentage,
                minimum_payment_amount = EXCLUDED.minimum_payment_amount,
                next_payment_due_date = EXCLUDED.next_payment_due_date,
                is_overdue = EXCLUDED.is_overdue,
                currency = EXCLUDED.currency
            """,
            rows,
        )
    return len(rows)
