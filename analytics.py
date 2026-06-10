"""Query layer over the Postgres history store plus live net-worth composition.

Everything here is read-only. aggregate_spending, net_worth_history,
list_transactions, and query_finances answer purely from Postgres — zero
Plaid calls. get_net_worth composes from live balances (current truth) so it
stays accurate between syncs.
"""
from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal

import storage

# Plaid account subtypes that count as retirement assets.
RETIREMENT_SUBTYPES = {
    "401a", "401k", "403b", "457b", "ira", "roth", "roth 401k",
    "sep ira", "simple ira", "sarsep", "pension", "profit sharing plan",
    "retirement", "thrift savings plan", "keogh",
}

ASSET_TYPES = {"depository", "investment", "brokerage"}
LIABILITY_TYPES = {"credit", "loan"}


def classify_account(acct_type: str | None, subtype: str | None) -> str:
    """Map a Plaid account type/subtype to a net-worth asset class."""
    t = (acct_type or "").lower()
    s = (subtype or "").lower()
    if t == "depository":
        return "cash"
    if t in ("investment", "brokerage"):
        return "retirement" if s in RETIREMENT_SUBTYPES else "investments"
    if t == "credit":
        return "credit_debt"
    if t == "loan":
        return "loans"
    return "other"


def compose_net_worth(shaped_accounts: list[dict]) -> dict:
    """Compose net worth from shaped live account balances.

    Assets are cash + investments + retirement (investment account balances
    already include holdings market value, so holdings are not added again —
    that would double count). Liabilities are credit + loan balances, which
    Plaid reports as positive amounts owed.
    """
    by_class: dict[str, dict] = {}
    for a in shaped_accounts:
        cls = classify_account(a.get("type"), a.get("subtype"))
        bal = (a.get("balance") or {}).get("current")
        if bal is None:
            continue
        bucket = by_class.setdefault(cls, {"total": 0.0, "accounts": []})
        bucket["total"] = round(bucket["total"] + bal, 2)
        bucket["accounts"].append({
            "handle": a.get("handle"),
            "name": a.get("name"),
            "institution": a.get("institution"),
            "subtype": a.get("subtype"),
            "current": bal,
        })

    assets = sum(by_class.get(c, {}).get("total", 0.0) for c in ("cash", "investments", "retirement", "other"))
    liabilities = sum(by_class.get(c, {}).get("total", 0.0) for c in ("credit_debt", "loans"))
    return {
        "net_worth": round(assets - liabilities, 2),
        "total_assets": round(assets, 2),
        "total_liabilities": round(liabilities, 2),
        "by_class": by_class,
    }


def net_worth_history(db_url: str | None = None) -> dict:
    """Net worth per snapshot date, from balance_snapshots only."""
    conn = storage.open_readonly(db_url)
    try:
        rows = conn.execute(
            """
            SELECT
                snapshot_date,
                round(sum(CASE WHEN type IN ('depository','investment','brokerage')
                               THEN current ELSE 0 END)::numeric, 2) AS assets,
                round(sum(CASE WHEN type IN ('credit','loan')
                               THEN current ELSE 0 END)::numeric, 2) AS liabilities,
                round((sum(CASE WHEN type IN ('depository','investment','brokerage')
                               THEN current ELSE 0 END)
                     - sum(CASE WHEN type IN ('credit','loan')
                               THEN current ELSE 0 END))::numeric, 2) AS net_worth
            FROM balance_snapshots
            GROUP BY snapshot_date
            ORDER BY snapshot_date
            """
        ).fetchall()
    finally:
        conn.close()
    return {
        "history": [
            {
                "date": str(r[0]),
                "assets": float(r[1]),
                "liabilities": float(r[2]),
                "net_worth": float(r[3]),
            }
            for r in rows
        ]
    }


def aggregate_spending(
    start_date: str,
    end_date: str,
    group_by: str = "category",
    monthly: bool = True,
    include_pending: bool = False,
    db_url: str | None = None,
) -> dict:
    """Aggregate outflows from stored transactions. Never calls Plaid.

    Spending = transactions with amount > 0 (Plaid's outflow convention),
    excluding inter-account transfers and loan/credit payments so moving
    money between your own accounts doesn't count as spending.
    """
    # Validate inputs that get interpolated into SQL identifiers.
    if group_by not in ("category", "merchant"):
        raise ValueError("group_by must be 'category' or 'merchant'")
    start = date.fromisoformat(start_date)
    end = date.fromisoformat(end_date)

    group_col = "coalesce(category_primary, 'UNCATEGORIZED')" if group_by == "category" \
        else "coalesce(merchant, 'UNKNOWN')"
    month_col = "to_char(date, 'YYYY-MM')"

    select_keys = [f"{month_col} AS month"] if monthly else []
    select_keys.append(f"{group_col} AS grp")
    group_keys = (["month"] if monthly else []) + ["grp"]

    pending_filter = "" if include_pending else "AND pending = FALSE"

    sql = f"""
        SELECT {', '.join(select_keys)},
               round(sum(amount)::numeric, 2) AS total,
               count(*) AS transaction_count
        FROM transactions
        WHERE amount > 0
          AND date >= %s AND date <= %s
          AND coalesce(category_primary, '') NOT IN ('TRANSFER_OUT', 'LOAN_PAYMENTS')
          {pending_filter}
        GROUP BY {', '.join(group_keys)}
        ORDER BY {', '.join(group_keys)}
    """
    conn = storage.open_readonly(db_url)
    try:
        rows = conn.execute(sql, (start, end)).fetchall()
    finally:
        conn.close()

    out = []
    for r in rows:
        if monthly:
            out.append({"month": r[0], group_by: r[1], "total": float(r[2]), "transaction_count": r[3]})
        else:
            out.append({group_by: r[0], "total": float(r[1]), "transaction_count": r[2]})
    return {
        "start_date": start_date,
        "end_date": end_date,
        "group_by": group_by,
        "monthly": monthly,
        "grand_total": round(sum(r["total"] for r in out), 2),
        "rows": out,
        "source": "history_db",
    }


# ---------------------------------------------------------------------------
# Schema discovery + raw transaction listing (agent-facing granular access)
# ---------------------------------------------------------------------------

_TABLE_DOCS: dict[str, dict] = {
    "accounts": {
        "description": "One row per linked account; refreshed on every sync.",
        "columns": {
            "account_id": "Plaid account id — joins to transactions and all snapshot tables",
            "item_key": "Which linked Item (institution token) owns the account",
            "type": "Plaid type: depository | investment | credit | loan",
            "subtype": "Plaid subtype, e.g. checking, 401k, ira, credit card, student",
        },
    },
    "transactions": {
        "description": "Full transaction history from /transactions/sync. "
                       "Sign convention: amount > 0 is an outflow (spending), "
                       "amount < 0 is an inflow (income/refund).",
        "columns": {
            "transaction_id": "Primary key; upserts keep re-syncs duplicate-free",
            "amount": "Positive = money out, negative = money in (Plaid convention)",
            "category_primary": "Plaid personal-finance category, e.g. FOOD_AND_DRINK, TRANSFER_OUT",
            "category_detailed": "Finer-grained category",
            "pending": "TRUE while unsettled; pending rows are replaced when they post",
        },
    },
    "balance_snapshots": {
        "description": "Dated balance per account, appended on every sync. "
                       "Source for net-worth-over-time.",
        "columns": {
            "snapshot_date": "One row per account per day (re-syncs same day overwrite)",
            "current": "Balance at snapshot time; for credit/loan this is amount owed",
        },
    },
    "holdings_snapshots": {
        "description": "Dated investment positions (symbol, quantity, value) per account.",
        "columns": {
            "market_value": "Position value at snapshot time",
            "cost_basis": "Total cost basis as reported by the institution",
        },
    },
    "liabilities_snapshots": {
        "description": "Dated debt detail: APRs, rates, minimum payments, outstanding balance.",
        "columns": {
            "liability_type": "credit | student | mortgage",
            "outstanding_balance": "Amount owed at snapshot time",
        },
    },
    "sync_state": {
        "description": "Per-Item /transactions/sync cursor and lifetime counters.",
        "columns": {
            "cursor": "Opaque Plaid cursor; internal bookkeeping",
        },
    },
}


def describe_tables(db_url: str | None = None) -> dict:
    """Return the live schema of every table, annotated with usage notes."""
    conn = storage.open_readonly(db_url)
    try:
        rows = conn.execute(
            """
            SELECT table_name, column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = 'public'
            ORDER BY table_name, ordinal_position
            """
        ).fetchall()
    finally:
        conn.close()
    tables: dict[str, dict] = {}
    for table_name, column_name, data_type in rows:
        doc = _TABLE_DOCS.get(table_name, {})
        entry = tables.setdefault(table_name, {
            "description": doc.get("description"),
            "columns": [],
        })
        col: dict = {"name": column_name, "type": data_type}
        note = doc.get("columns", {}).get(column_name)
        if note:
            col["note"] = note
        entry["columns"].append(col)
    return {
        "tables": tables,
        "conventions": [
            "transaction amount > 0 = outflow (spending), < 0 = inflow (Plaid convention)",
            "snapshots are append-per-date; same-day re-syncs overwrite, never duplicate",
            "join key across tables: account_id",
        ],
    }


_LIST_MAX = 500


def list_transactions(
    start_date: str | None = None,
    end_date: str | None = None,
    account_id: str | None = None,
    category: str | None = None,
    merchant_contains: str | None = None,
    min_amount: float | None = None,
    max_amount: float | None = None,
    include_pending: bool = True,
    limit: int = 100,
    offset: int = 0,
    db_url: str | None = None,
) -> dict:
    """List raw stored transactions with filters. Never calls Plaid.

    Filters combine with AND. ``category`` matches category_primary
    (case-insensitive); ``merchant_contains`` is a case-insensitive
    substring match on merchant. Results are newest-first.
    """
    where: list[str] = []
    params: list = []
    if start_date:
        where.append("date >= %s")
        params.append(date.fromisoformat(start_date))
    if end_date:
        where.append("date <= %s")
        params.append(date.fromisoformat(end_date))
    if account_id:
        where.append("account_id = %s")
        params.append(account_id)
    if category:
        where.append("upper(coalesce(category_primary, '')) = upper(%s)")
        params.append(category)
    if merchant_contains:
        where.append("merchant ILIKE %s")
        params.append(f"%{merchant_contains}%")
    if min_amount is not None:
        where.append("amount >= %s")
        params.append(min_amount)
    if max_amount is not None:
        where.append("amount <= %s")
        params.append(max_amount)
    if not include_pending:
        where.append("pending = FALSE")
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    limit = max(1, min(int(limit), _LIST_MAX))
    offset = max(0, int(offset))

    cols = ("transaction_id", "account_id", "date", "amount", "currency",
            "merchant", "name", "category_primary", "category_detailed", "pending")
    conn = storage.open_readonly(db_url)
    try:
        total = conn.execute(
            f"SELECT count(*) FROM transactions {where_sql}", params
        ).fetchone()[0]
        rows = conn.execute(
            f"SELECT {', '.join(cols)} FROM transactions {where_sql} "
            f"ORDER BY date DESC, transaction_id LIMIT %s OFFSET %s",
            params + [limit, offset],
        ).fetchall()
    finally:
        conn.close()
    out = []
    for r in rows:
        d = dict(zip(cols, r))
        d["date"] = str(d["date"]) if d["date"] else None
        out.append(d)
    return {
        "transactions": out,
        "total_matching": total,
        "limit": limit,
        "offset": offset,
        "source": "history_db",
    }


# ---------------------------------------------------------------------------
# query_finances: read-only SQL escape hatch
# ---------------------------------------------------------------------------

_BANNED_TOKENS = re.compile(
    r"\b(attach|detach|copy|export|import|install|load|create|insert|update|delete|"
    r"drop|alter|pragma|set|reset|call|begin|commit|rollback|vacuum|checkpoint|"
    r"grant|revoke|truncate|merge|use)\b",
    re.IGNORECASE,
)

_MAX_ROWS = 500


def _validate_select(sql: str) -> str:
    """Reject anything that isn't a single read-only SELECT/WITH statement."""
    stripped = sql.strip().rstrip(";").strip()
    if not stripped:
        raise ValueError("empty query")
    if ";" in stripped:
        raise ValueError("only a single statement is allowed")
    first = stripped.split(None, 1)[0].lower()
    if first not in ("select", "with"):
        raise ValueError("only SELECT (or WITH ... SELECT) queries are allowed")
    banned = _BANNED_TOKENS.search(stripped)
    if banned:
        raise ValueError(f"keyword not allowed in read-only queries: {banned.group(0)}")
    return stripped


def _jsonable(v):
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (date, datetime)):
        return str(v)
    return v


def query_finances(sql: str, db_url: str | None = None) -> dict:
    """Run a validated read-only SELECT against the Postgres history store.

    Defense in depth: keyword validation above, plus the connection forces
    default_transaction_read_only=on so Postgres rejects any write that
    slips through.
    """
    stmt = _validate_select(sql)
    conn = storage.open_readonly(db_url)
    try:
        cur = conn.execute(stmt)
        columns = [d[0] for d in (cur.description or [])]
        rows = cur.fetchmany(_MAX_ROWS + 1)
    finally:
        conn.close()
    truncated = len(rows) > _MAX_ROWS
    rows = rows[:_MAX_ROWS]
    return {
        "columns": columns,
        "rows": [[_jsonable(v) for v in r] for r in rows],
        "row_count": len(rows),
        "truncated": truncated,
    }
