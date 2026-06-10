"""Query layer over the local DuckDB store plus live net-worth composition.

Everything here is read-only. aggregate_spending, net_worth_history, and
query_finances answer purely from DuckDB — zero Plaid calls. get_net_worth
composes from live balances (current truth) so it stays accurate between
syncs.
"""
from __future__ import annotations

import re
from datetime import date

import duckdb

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


def net_worth_history(db_path: str | None = None) -> dict:
    """Net worth per snapshot date, from balance_snapshots only."""
    conn = storage.open_readonly(db_path)
    try:
        rows = conn.execute(
            """
            SELECT
                snapshot_date,
                round(sum(CASE WHEN type IN ('depository','investment','brokerage')
                               THEN current ELSE 0 END), 2) AS assets,
                round(sum(CASE WHEN type IN ('credit','loan')
                               THEN current ELSE 0 END), 2) AS liabilities,
                round(sum(CASE WHEN type IN ('depository','investment','brokerage')
                               THEN current ELSE 0 END)
                    - sum(CASE WHEN type IN ('credit','loan')
                               THEN current ELSE 0 END), 2) AS net_worth
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
                "assets": r[1],
                "liabilities": r[2],
                "net_worth": r[3],
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
    db_path: str | None = None,
) -> dict:
    """Aggregate outflows from local transactions. Never calls Plaid.

    Spending = transactions with amount > 0 (Plaid's outflow convention),
    excluding inter-account transfers and loan/credit payments so moving
    money between your own accounts doesn't count as spending.
    """
    # Validate inputs that get interpolated into SQL identifiers.
    if group_by not in ("category", "merchant"):
        raise ValueError("group_by must be 'category' or 'merchant'")
    date.fromisoformat(start_date)
    date.fromisoformat(end_date)

    group_col = "coalesce(category_primary, 'UNCATEGORIZED')" if group_by == "category" \
        else "coalesce(merchant, 'UNKNOWN')"
    month_col = "strftime(date, '%Y-%m')"

    select_keys = [f"{month_col} AS month"] if monthly else []
    select_keys.append(f"{group_col} AS grp")
    group_keys = (["month"] if monthly else []) + ["grp"]

    pending_filter = "" if include_pending else "AND pending = FALSE"

    sql = f"""
        SELECT {', '.join(select_keys)},
               round(sum(amount), 2) AS total,
               count(*) AS transaction_count
        FROM transactions
        WHERE amount > 0
          AND date >= ? AND date <= ?
          AND coalesce(category_primary, '') NOT IN ('TRANSFER_OUT', 'LOAN_PAYMENTS')
          {pending_filter}
        GROUP BY {', '.join(group_keys)}
        ORDER BY {', '.join(group_keys)}
    """
    conn = storage.open_readonly(db_path)
    try:
        rows = conn.execute(sql, (start_date, end_date)).fetchall()
    finally:
        conn.close()

    out = []
    for r in rows:
        if monthly:
            out.append({"month": r[0], group_by: r[1], "total": r[2], "transaction_count": r[3]})
        else:
            out.append({group_by: r[0], "total": r[1], "transaction_count": r[2]})
    return {
        "start_date": start_date,
        "end_date": end_date,
        "group_by": group_by,
        "monthly": monthly,
        "grand_total": round(sum(r["total"] for r in out), 2),
        "rows": out,
        "source": "local_duckdb",
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


def query_finances(sql: str, db_path: str | None = None) -> dict:
    """Run a validated read-only SELECT against the local DuckDB store.

    Defense in depth: keyword validation above, plus the connection itself is
    opened read_only so DuckDB rejects any write that slips through.
    """
    stmt = _validate_select(sql)
    conn = storage.open_readonly(db_path)
    try:
        cur = conn.execute(stmt)
        columns = [d[0] for d in cur.description]
        rows = cur.fetchmany(_MAX_ROWS + 1)
    finally:
        conn.close()
    truncated = len(rows) > _MAX_ROWS
    rows = rows[:_MAX_ROWS]
    return {
        "columns": columns,
        "rows": [[(str(v) if isinstance(v, (date,)) else v) for v in r] for r in rows],
        "row_count": len(rows),
        "truncated": truncated,
    }
