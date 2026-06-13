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

-- Investment activity from /investments/transactions/get (brokerage buys/sells,
-- dividends, interest, fees, transfers). A SEPARATE stream from `transactions`
-- (depository/credit cash-flow): different schema, no merchant/category, so
-- apply_tags()/apply_overrides() deliberately do NOT touch it. Plaid offers no
-- cursor for this product, so idempotency rides on investment_transaction_id
-- (PK): re-pulling an overlapping date window upserts, never duplicates.
CREATE TABLE IF NOT EXISTS investment_transactions (
    investment_transaction_id TEXT PRIMARY KEY,
    account_id TEXT,
    item_key TEXT,
    date DATE,
    name TEXT,
    type TEXT,
    subtype TEXT,
    amount DOUBLE PRECISION,
    quantity DOUBLE PRECISION,
    price DOUBLE PRECISION,
    fees DOUBLE PRECISION,
    security_id TEXT,
    symbol TEXT,
    security_name TEXT,
    security_type TEXT,
    currency TEXT,
    updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_inv_tx_date ON investment_transactions (date);
CREATE INDEX IF NOT EXISTS idx_inv_tx_account ON investment_transactions (account_id);
CREATE INDEX IF NOT EXISTS idx_inv_tx_symbol ON investment_transactions (symbol);

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

-- Plaid access tokens, Fernet-encrypted client-side before insert.
-- The Fernet key never touches the database (see secure_tokens.py), so the
-- connection string alone cannot reveal tokens. Excluded from query_finances
-- and describe_tables.
CREATE TABLE IF NOT EXISTS plaid_tokens (
    env_key TEXT PRIMARY KEY,
    token_ciphertext TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Rule-based tags layered on transactions without touching Plaid's category
-- data. Recovers signals Plaid's merchant-cleaning hides, e.g. delivery orders
-- filed under the restaurant name (see tagging.py). Join: transaction_id.
CREATE TABLE IF NOT EXISTS transaction_tags (
    transaction_id TEXT,
    tag TEXT,
    source TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (transaction_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_transaction_tags_tag ON transaction_tags (tag);

-- User category corrections. The rulebook for fixing provider miscategorization
-- (e.g. "Casey's is never fuel") or applying custom categories (e.g. WEDDING).
-- apply_overrides() rewrites transactions.category_* in place from these rows,
-- re-run after every sync/import; a re-fetch restores then re-corrects.
CREATE TABLE IF NOT EXISTS category_overrides (
    match_type TEXT NOT NULL,    -- 'merchant' (substring) or 'transaction' (id)
    match_value TEXT NOT NULL,
    set_primary TEXT,            -- new category_primary (NULL = leave as-is)
    set_detailed TEXT,           -- new category_detailed (NULL = leave as-is)
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (match_type, match_value)
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
    """Open a connection whose transactions are read-only server-side.

    Enforces read-only per transaction (psycopg issues ``BEGIN ... READ ONLY``)
    rather than via a ``default_transaction_read_only`` *startup* option. The
    startup-option form is rejected by transaction-pooling poolers such as
    Neon's ``-pooler`` endpoint ("unsupported startup parameter in options"),
    whereas per-transaction read-only works through poolers and direct
    connections alike. autocommit must stay off for the read-only transaction
    characteristic to take effect (an autocommit SET does not persist across a
    pooler's multiplexed backends), so callers get a transaction that is
    rolled back on close — fine for the SELECT-only read path.
    """
    u = url or database_url()
    if u not in _schema_ensured:
        open_db(u).close()
    conn = psycopg.connect(u, autocommit=False)
    conn.read_only = True
    return conn


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


_TX_INSERT_NOCONFLICT = """
INSERT INTO transactions VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
ON CONFLICT (transaction_id) DO NOTHING
"""


def import_transactions(
    conn: psycopg.Connection,
    rows: list[dict],
    item_key: str,
    account_id: str,
    institution: str,
) -> dict:
    """Import manually-supplied transactions (e.g. an Apple Card CSV) idempotently.

    Two layers of de-duplication, so re-uploading the same or an overlapping
    statement never double-counts and only brings in genuinely new days:

    1. Date-coverage: any row whose ``date`` is already represented for this
       ``item_key`` is skipped (that statement period is treated as imported).
       Rows on not-yet-covered dates — including gaps before the latest date —
       are candidates.
    2. Row identity: candidates are inserted with ON CONFLICT (transaction_id)
       DO NOTHING, so a deterministic id can never insert twice.

    Existing rows are never overwritten. Returns a breakdown of the outcome.
    """
    rows = [r for r in rows if r.get("transaction_id") and r.get("date")]
    with conn.transaction():
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO accounts (account_id, item_key, institution, name, type, subtype, currency, updated_at)
            VALUES (%s,%s,%s,%s,'credit','credit card',%s,%s)
            ON CONFLICT (account_id) DO UPDATE SET
                institution = EXCLUDED.institution, updated_at = EXCLUDED.updated_at
            """,
            (account_id, item_key, institution, institution, "USD", _now()),
        )
        covered = {
            r[0] for r in cur.execute(
                "SELECT DISTINCT date FROM transactions WHERE item_key = %s", (item_key,)
            ).fetchall()
        }
        candidates = [r for r in rows if r["date"] not in covered]
        before = cur.execute(
            "SELECT count(*) FROM transactions WHERE item_key = %s", (item_key,)
        ).fetchone()[0]
        if candidates:
            cur.executemany(_TX_INSERT_NOCONFLICT, [
                (
                    r["transaction_id"], r["account_id"], r["item_key"], r["date"],
                    r.get("authorized_date"), r["amount"], r.get("currency"),
                    r.get("merchant"), r.get("name"), r.get("category_primary"),
                    r.get("category_detailed"), bool(r.get("pending")), _now(),
                )
                for r in candidates
            ])
        after = cur.execute(
            "SELECT count(*) FROM transactions WHERE item_key = %s", (item_key,)
        ).fetchone()[0]

    apply_tags(conn, item_key)  # tag newly-imported rows (e.g. delivery)
    apply_overrides(conn)       # apply user category corrections to imported rows
    imported = after - before
    dates = [r["date"] for r in rows]
    return {
        "rows_in_file": len(rows),
        "imported": imported,
        "skipped_existing_date": len(rows) - len(candidates),
        "skipped_duplicate_id": len(candidates) - imported,
        "file_date_range": [min(dates).isoformat(), max(dates).isoformat()] if dates else None,
        "total_for_item": after,
        "item_key": item_key,
    }


def apply_tags(conn: psycopg.Connection, item_key: str | None = None) -> dict:
    """(Re)compute rule-based tags for stored transactions (see tagging.py).

    Idempotent: ON CONFLICT DO NOTHING, so re-running adds only newly-matching
    rows. Scans all transactions, or just one item_key when given (used after a
    single CSV import). Returns per-tag match counts plus how many were new.
    """
    import tagging
    where = "WHERE item_key = %s" if item_key else ""
    params = (item_key,) if item_key else ()
    rows = conn.execute(
        f"SELECT transaction_id, name, merchant FROM transactions {where}", params
    ).fetchall()
    inserts: list[tuple] = []
    matched: dict[str, int] = {}
    for tid, name, merchant in rows:
        for tag in tagging.compute_tags(name, merchant):
            inserts.append((tid, tag, "rule"))
            matched[tag] = matched.get(tag, 0) + 1
    newly = 0
    if inserts:
        before = conn.execute("SELECT count(*) FROM transaction_tags").fetchone()[0]
        conn.cursor().executemany(
            "INSERT INTO transaction_tags (transaction_id, tag, source) VALUES (%s,%s,%s) "
            "ON CONFLICT (transaction_id, tag) DO NOTHING",
            inserts,
        )
        after = conn.execute("SELECT count(*) FROM transaction_tags").fetchone()[0]
        newly = after - before
    return {"scanned": len(rows), "matched": matched, "newly_tagged": newly}


def add_override(match_type: str, match_value: str,
                 set_primary: str | None = None, set_detailed: str | None = None,
                 note: str | None = None, db_url: str | None = None) -> None:
    """Record a category correction. match_type 'merchant' matches a lowercased
    substring of merchant+name; 'transaction' matches an exact transaction_id."""
    if match_type not in ("merchant", "transaction"):
        raise ValueError("match_type must be 'merchant' or 'transaction'")
    conn = open_db(db_url)
    try:
        conn.execute(
            """
            INSERT INTO category_overrides (match_type, match_value, set_primary, set_detailed, note)
            VALUES (%s,%s,%s,%s,%s)
            ON CONFLICT (match_type, match_value) DO UPDATE SET
                set_primary = EXCLUDED.set_primary,
                set_detailed = EXCLUDED.set_detailed,
                note = EXCLUDED.note
            """,
            (match_type, match_value.lower().strip(), set_primary, set_detailed, note),
        )
    finally:
        conn.close()


def list_overrides(db_url: str | None = None) -> list[dict]:
    conn = open_readonly(db_url)
    try:
        rows = conn.execute(
            "SELECT match_type, match_value, set_primary, set_detailed, note "
            "FROM category_overrides ORDER BY match_type, match_value"
        ).fetchall()
    finally:
        conn.close()
    return [{"match_type": r[0], "match_value": r[1], "set_primary": r[2],
             "set_detailed": r[3], "note": r[4]} for r in rows]


def apply_overrides(conn: psycopg.Connection) -> int:
    """Rewrite transactions.category_* in place from category_overrides.

    Idempotent (overrides set absolute values), so safe to re-run after every
    sync/import. Returns the number of transaction rows touched.
    """
    cur = conn.execute(
        """
        UPDATE transactions t SET
            category_primary  = COALESCE(o.set_primary, t.category_primary),
            category_detailed = COALESCE(o.set_detailed, t.category_detailed)
        FROM category_overrides o
        WHERE (o.match_type = 'transaction' AND t.transaction_id = o.match_value)
           OR (o.match_type = 'merchant'
               AND lower(coalesce(t.merchant,'') || ' ' || coalesce(t.name,''))
                   LIKE '%' || o.match_value || '%')
        """
    )
    return cur.rowcount


def record_manual_balance(
    conn: psycopg.Connection,
    account_id: str,
    current: float,
    apr_percentage: float | None = None,
    minimum_payment: float | None = None,
    snapshot_date: date | None = None,
) -> dict:
    """Record a user-stated balance for an account that has no Plaid Item.

    CSV imports (e.g. Apple Card) carry transactions but no balance, leaving
    the account invisible to every balance-derived tool. This writes the same
    rows the Plaid sync writes — balance_snapshots, plus liabilities_snapshots
    for credit/loan accounts — so debt and net-worth tools pick the account up
    with no special-casing. Same-day re-entry overwrites (snapshot upsert
    semantics, like sync); distinct days accumulate history.

    Refuses Plaid-synced accounts (item_key present in sync_state): their
    snapshots come from the institution and a manual row would be silently
    overwritten — and disagree with — the next sync.
    """
    row = conn.execute(
        "SELECT item_key, institution, type, subtype FROM accounts"
        " WHERE account_id = %s", (account_id,)
    ).fetchone()
    if row is None:
        raise ValueError(f"unknown account_id: {account_id}")
    item_key, institution, acct_type, subtype = row
    synced = conn.execute(
        "SELECT 1 FROM sync_state WHERE item_key = %s", (item_key,)
    ).fetchone()
    if synced:
        raise ValueError(
            f"account {account_id} belongs to Plaid-synced item {item_key}; "
            "its balances come from sync, not manual entry"
        )

    sd = (snapshot_date or date.today()).isoformat()
    ts = _now()
    is_liability = acct_type in ("credit", "loan")
    with conn.transaction():
        conn.execute(
            """
            INSERT INTO balance_snapshots VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (snapshot_date, account_id) DO UPDATE SET
                snapshot_ts = EXCLUDED.snapshot_ts,
                current = EXCLUDED.current
            """,
            (sd, ts, account_id, item_key, institution, acct_type, subtype,
             current, None, None, "USD"),
        )
        if is_liability:
            liability_type = "credit" if acct_type == "credit" else "loan"
            conn.execute(
                """
                INSERT INTO liabilities_snapshots VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (snapshot_date, account_id, liability_type) DO UPDATE SET
                    snapshot_ts = EXCLUDED.snapshot_ts,
                    outstanding_balance = EXCLUDED.outstanding_balance,
                    apr_percentage = EXCLUDED.apr_percentage,
                    minimum_payment_amount = EXCLUDED.minimum_payment_amount
                """,
                (sd, ts, account_id, item_key, liability_type,
                 current, apr_percentage, None, minimum_payment, None, None, "USD"),
            )
    return {
        "ok": True,
        "account_id": account_id,
        "institution": institution,
        "snapshot_date": sd,
        "current": current,
        "liability_recorded": is_liability,
    }


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


_INV_TX_UPSERT = """
INSERT INTO investment_transactions
VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
ON CONFLICT (investment_transaction_id) DO UPDATE SET
    account_id = EXCLUDED.account_id,
    item_key = EXCLUDED.item_key,
    date = EXCLUDED.date,
    name = EXCLUDED.name,
    type = EXCLUDED.type,
    subtype = EXCLUDED.subtype,
    amount = EXCLUDED.amount,
    quantity = EXCLUDED.quantity,
    price = EXCLUDED.price,
    fees = EXCLUDED.fees,
    security_id = EXCLUDED.security_id,
    symbol = EXCLUDED.symbol,
    security_name = EXCLUDED.security_name,
    security_type = EXCLUDED.security_type,
    currency = EXCLUDED.currency,
    updated_at = EXCLUDED.updated_at
"""


def record_investment_transactions(
    conn: psycopg.Connection,
    item_key: str,
    rows: list[dict],
) -> int:
    """Upsert shaped investment-transaction records for one Item.

    ``rows`` are canonical dicts from plaid_client.shape_investment_transaction.
    Keyed by investment_transaction_id, so re-pulling an overlapping date window
    is a no-op (Plaid offers no cursor for this product). Rows without an id are
    skipped. Returns the number of rows written.
    """
    ts = _now()
    values = []
    for r in rows:
        itid = r.get("investment_transaction_id")
        if not itid:
            continue
        d = r.get("date")
        values.append((
            itid, r.get("account_id"), item_key,
            str(d) if d else None,
            r.get("name"), r.get("type"), r.get("subtype"),
            r.get("amount"), r.get("quantity"), r.get("price"), r.get("fees"),
            r.get("security_id"), r.get("symbol"),
            r.get("security_name"), r.get("security_type"),
            r.get("currency"), ts,
        ))
    if values:
        conn.cursor().executemany(_INV_TX_UPSERT, values)
    return len(values)


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
