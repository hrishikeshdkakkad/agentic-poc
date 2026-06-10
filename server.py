from __future__ import annotations

import os
from datetime import date, timedelta

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from fastmcp import FastMCP
from plaid.exceptions import ApiException
from plaid.model.accounts_balance_get_request import AccountsBalanceGetRequest
from plaid.model.accounts_balance_get_request_options import AccountsBalanceGetRequestOptions
from plaid.model.accounts_get_request import AccountsGetRequest
from plaid.model.investments_holdings_get_request import InvestmentsHoldingsGetRequest
from plaid.model.investments_transactions_get_request import InvestmentsTransactionsGetRequest
from plaid.model.investments_transactions_get_request_options import InvestmentsTransactionsGetRequestOptions
from plaid.model.liabilities_get_request import LiabilitiesGetRequest
from plaid.model.transactions_get_request import TransactionsGetRequest
from plaid.model.transactions_get_request_options import TransactionsGetRequestOptions
from plaid.model.transactions_recurring_get_request import TransactionsRecurringGetRequest

from plaid_client import (
    ItemHealth,
    all_items,
    build_api,
    map_plaid_error,
    shape_account,
    shape_holding,
    shape_transaction,
)

mcp = FastMCP("personal-finance-mcp")


def _warning_from_health(h: ItemHealth) -> dict:
    return {
        "institution": h.institution_name or h.env_key,
        "status": h.status,
        "reason": h.reason,
    }


def _list_accounts_impl() -> dict:
    """List every account across all linked Items, with balances.

    Returns:
        {"accounts": [...], "warnings": [...]}. Warnings describe Items that
        are unhealthy (re-auth required, etc.) or hit API errors on this call.
    """
    api = build_api()
    accounts: list[dict] = []
    warnings: list[dict] = []
    for env_key, token, health in all_items(api):
        if health.status != "healthy":
            warnings.append(_warning_from_health(health))
            continue
        try:
            resp = api.accounts_get(
                AccountsGetRequest(access_token=token.reveal())
            ).to_dict()
            for raw in resp.get("accounts", []):
                accounts.append(shape_account(raw, health.institution_name))
        except ApiException as e:
            mapped = map_plaid_error(e, health.institution_name)["error"]
            warnings.append({"institution": health.institution_name, **mapped})
    return {"accounts": accounts, "warnings": warnings}


list_accounts = mcp.tool(
    name="list_accounts",
    annotations={"readOnlyHint": True, "title": "List Accounts"},
)(_list_accounts_impl)


def _get_balances_impl(account_ids: list[str] | None = None) -> dict:
    """Get live current + available balances for accounts.

    Args:
        account_ids: Optional filter. When omitted, returns balances for every
            account across every healthy Item. When provided, only matching
            accounts are returned; Items that don't own any of the IDs emit a
            warning (INVALID_ACCOUNT_ID) rather than failing the call.

    Returns:
        {"accounts": [...], "warnings": [...]}.
    """
    api = build_api()
    accounts: list[dict] = []
    warnings: list[dict] = []

    options = None
    if account_ids:
        options = AccountsBalanceGetRequestOptions(account_ids=list(account_ids))

    for env_key, token, health in all_items(api):
        if health.status != "healthy":
            warnings.append(_warning_from_health(health))
            continue
        try:
            kwargs = {"access_token": token.reveal()}
            if options is not None:
                kwargs["options"] = options
            resp = api.accounts_balance_get(AccountsBalanceGetRequest(**kwargs)).to_dict()
            for raw in resp.get("accounts", []):
                accounts.append(shape_account(raw, health.institution_name))
        except ApiException as e:
            mapped = map_plaid_error(e, health.institution_name)["error"]
            warnings.append({"institution": health.institution_name, **mapped})

    return {"accounts": accounts, "warnings": warnings}


get_balances = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Get Balances"},
    name="get_balances",
)(_get_balances_impl)


_MAX_LOOKBACK_DAYS = 730  # ~2 years


def _clip_window(start_date: str, end_date: str) -> tuple[str, str, str | None]:
    """Return (start, end, warning_reason_or_None) clipped to the 2-year window."""
    start = date.fromisoformat(start_date)
    end = date.fromisoformat(end_date)
    earliest = end - timedelta(days=_MAX_LOOKBACK_DAYS)
    if start < earliest:
        return earliest.isoformat(), end.isoformat(), (
            f"clipped start from {start.isoformat()} to {earliest.isoformat()} "
            "(Plaid max lookback ~2 years)"
        )
    return start.isoformat(), end.isoformat(), None


def _get_transactions_impl(
    start_date: str,
    end_date: str,
    account_ids: list[str] | None = None,
) -> dict:
    """Fetch transactions in [start_date, end_date] across all healthy Items.

    Dates are ISO YYYY-MM-DD. Uses Plaid /transactions/get with offset
    pagination (count=500 per page). If start_date is older than ~2 years
    before end_date, the window is clipped and a warning is emitted.
    """
    api = build_api()
    transactions: list[dict] = []
    warnings: list[dict] = []

    clipped_start, clipped_end, clip_reason = _clip_window(start_date, end_date)
    if clip_reason:
        warnings.append({"code": "WINDOW_CLIPPED", "reason": clip_reason, "message": clip_reason})

    base_options: dict = {"count": 500}
    if account_ids:
        base_options["account_ids"] = list(account_ids)

    for env_key, token, health in all_items(api):
        if health.status != "healthy":
            warnings.append(_warning_from_health(health))
            continue
        offset = 0
        try:
            while True:
                options = TransactionsGetRequestOptions(**{**base_options, "offset": offset})
                resp = api.transactions_get(
                    TransactionsGetRequest(
                        access_token=token.reveal(),
                        start_date=date.fromisoformat(clipped_start),
                        end_date=date.fromisoformat(clipped_end),
                        options=options,
                    )
                ).to_dict()
                batch = resp.get("transactions", []) or []
                for raw in batch:
                    transactions.append(shape_transaction(raw))
                total = resp.get("total_transactions") or 0
                offset += len(batch)
                if offset >= total or not batch:
                    break
        except ApiException as e:
            mapped = map_plaid_error(e, health.institution_name)["error"]
            warnings.append({"institution": health.institution_name, **mapped})

    return {"transactions": transactions, "warnings": warnings}


get_transactions = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Get Transactions"},
    name="get_transactions",
)(_get_transactions_impl)


def _shape_stream(stream: dict, institution: str | None) -> dict:
    avg_amount_obj = stream.get("average_amount") or {}
    pfc = stream.get("personal_finance_category") or {}
    return {
        "stream_id": stream.get("stream_id"),
        "description": stream.get("description"),
        "merchant": stream.get("merchant_name"),
        "average_amount": avg_amount_obj.get("amount"),
        "frequency": stream.get("frequency"),
        "last_date": str(stream.get("last_date")) if stream.get("last_date") else None,
        "is_active": stream.get("is_active"),
        "category": pfc.get("primary"),
        "account_id": stream.get("account_id"),
        "institution": institution,
    }


def _get_recurring_transactions_impl() -> dict:
    """Return recurring inflow and outflow streams across all linked Items.

    Calls /accounts/get first per Item to collect account IDs (required by
    /transactions/recurring/get), then fetches recurring streams and shapes
    them into unified inflows/outflows lists.

    Returns:
        {"inflows": [...], "outflows": [...], "warnings": [...]}
    """
    api = build_api()
    inflows: list[dict] = []
    outflows: list[dict] = []
    warnings: list[dict] = []
    for env_key, token, health in all_items(api):
        if health.status != "healthy":
            warnings.append(_warning_from_health(health))
            continue
        try:
            acct_resp = api.accounts_get(
                AccountsGetRequest(access_token=token.reveal())
            ).to_dict()
            account_ids = [a["account_id"] for a in acct_resp.get("accounts", [])]
            resp = api.transactions_recurring_get(
                TransactionsRecurringGetRequest(
                    access_token=token.reveal(),
                    account_ids=account_ids,
                )
            ).to_dict()
            for stream in resp.get("inflow_streams", []) or []:
                inflows.append(_shape_stream(stream, health.institution_name))
            for stream in resp.get("outflow_streams", []) or []:
                outflows.append(_shape_stream(stream, health.institution_name))
        except ApiException as e:
            mapped = map_plaid_error(e, health.institution_name)["error"]
            warnings.append({"institution": health.institution_name, **mapped})
    return {"inflows": inflows, "outflows": outflows, "warnings": warnings}


get_recurring_transactions = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Get Recurring Transactions"},
    name="get_recurring_transactions",
)(_get_recurring_transactions_impl)


def _get_liabilities_impl() -> dict:
    """Return credit, student-loan, and mortgage liability details across all linked Items.

    For Items where the liabilities product is not enabled, a per-Item warning
    with code PRODUCTS_NOT_SUPPORTED is emitted instead of failing the call.

    Returns:
        {"credit": [...], "student": [...], "mortgage": [...], "warnings": [...]}
    """
    api = build_api()
    credit: list[dict] = []
    student: list[dict] = []
    mortgage: list[dict] = []
    warnings: list[dict] = []
    for env_key, token, health in all_items(api):
        if health.status != "healthy":
            warnings.append(_warning_from_health(health))
            continue
        try:
            resp = api.liabilities_get(
                LiabilitiesGetRequest(access_token=token.reveal())
            ).to_dict()
            liabs = resp.get("liabilities") or {}

            for c in liabs.get("credit", []) or []:
                aprs = c.get("aprs") or []
                # Prefer purchase_apr; fall back to first APR entry
                apr_entry = next(
                    (a for a in aprs if a.get("apr_type") == "purchase_apr"),
                    aprs[0] if aprs else {},
                )
                credit.append({
                    "account_id": c.get("account_id"),
                    "institution": health.institution_name,
                    "apr_percentage": apr_entry.get("apr_percentage"),
                    "last_payment_amount": c.get("last_payment_amount"),
                    "last_payment_date": str(c["last_payment_date"]) if c.get("last_payment_date") else None,
                    "last_statement_balance": c.get("last_statement_balance"),
                    "last_statement_issue_date": str(c["last_statement_issue_date"]) if c.get("last_statement_issue_date") else None,
                    "minimum_payment_amount": c.get("minimum_payment_amount"),
                    "next_payment_due_date": str(c["next_payment_due_date"]) if c.get("next_payment_due_date") else None,
                    "is_overdue": c.get("is_overdue"),
                })

            for s in liabs.get("student", []) or []:
                student.append({
                    "account_id": s.get("account_id"),
                    "institution": health.institution_name,
                    "interest_rate_percentage": s.get("interest_rate_percentage"),
                    "origination_principal_amount": s.get("origination_principal_amount"),
                    "outstanding_interest_amount": s.get("outstanding_interest_amount"),
                    "next_monthly_payment": s.get("next_monthly_payment"),
                    "last_payment_amount": s.get("last_payment_amount"),
                    "last_payment_date": str(s["last_payment_date"]) if s.get("last_payment_date") else None,
                    "minimum_payment_amount": s.get("minimum_payment_amount"),
                })

            for m in liabs.get("mortgage", []) or []:
                interest = m.get("interest_rate") or {}
                mortgage.append({
                    "account_id": m.get("account_id"),
                    "institution": health.institution_name,
                    "interest_rate_percentage": interest.get("percentage"),
                    "origination_principal_amount": m.get("origination_principal_amount"),
                    "next_monthly_payment": m.get("next_monthly_payment"),
                    "last_payment_amount": m.get("last_payment_amount"),
                    "last_payment_date": str(m["last_payment_date"]) if m.get("last_payment_date") else None,
                    "current_late_fee": m.get("current_late_fee"),
                    "escrow_balance": m.get("escrow_balance"),
                    "maturity_date": str(m["maturity_date"]) if m.get("maturity_date") else None,
                })

        except ApiException as e:
            mapped = map_plaid_error(e, health.institution_name)["error"]
            warnings.append({"institution": health.institution_name, **mapped})
    return {"credit": credit, "student": student, "mortgage": mortgage, "warnings": warnings}


get_liabilities = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Get Liabilities"},
    name="get_liabilities",
)(_get_liabilities_impl)


def _get_investment_holdings_impl() -> dict:
    """Return investment holdings with security metadata across all linked Items.

    Joins holdings with the securities list returned in the same response to
    provide symbol, name, and security type. Adds institution to each holding.

    Returns:
        {"holdings": [...], "warnings": [...]}
    """
    api = build_api()
    holdings: list[dict] = []
    warnings: list[dict] = []
    for env_key, token, health in all_items(api):
        if health.status != "healthy":
            warnings.append(_warning_from_health(health))
            continue
        try:
            resp = api.investments_holdings_get(
                InvestmentsHoldingsGetRequest(access_token=token.reveal())
            ).to_dict()
            secs_by_id = {s["security_id"]: s for s in resp.get("securities", []) or []}
            for h in resp.get("holdings", []) or []:
                shaped = shape_holding(h, secs_by_id)
                shaped["institution"] = health.institution_name
                holdings.append(shaped)
        except ApiException as e:
            mapped = map_plaid_error(e, health.institution_name)["error"]
            warnings.append({"institution": health.institution_name, **mapped})
    return {"holdings": holdings, "warnings": warnings}


get_investment_holdings = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Get Investment Holdings"},
    name="get_investment_holdings",
)(_get_investment_holdings_impl)


def _get_investment_transactions_impl(
    start_date: str,
    end_date: str,
) -> dict:
    """Fetch investment transactions in [start_date, end_date] across all healthy Items.

    Dates are ISO YYYY-MM-DD. Uses offset pagination (count=500 per page).
    If start_date is older than ~2 years before end_date, the window is clipped
    and a warning is emitted. Each transaction is joined with security metadata
    (ticker symbol, name) from the same response.

    Returns:
        {"investment_transactions": [...], "warnings": [...]}
    """
    api = build_api()
    investment_transactions: list[dict] = []
    warnings: list[dict] = []

    clipped_start, clipped_end, clip_reason = _clip_window(start_date, end_date)
    if clip_reason:
        warnings.append({"code": "WINDOW_CLIPPED", "reason": clip_reason, "message": clip_reason})

    for env_key, token, health in all_items(api):
        if health.status != "healthy":
            warnings.append(_warning_from_health(health))
            continue
        offset = 0
        try:
            while True:
                resp = api.investments_transactions_get(
                    InvestmentsTransactionsGetRequest(
                        access_token=token.reveal(),
                        start_date=date.fromisoformat(clipped_start),
                        end_date=date.fromisoformat(clipped_end),
                        options=InvestmentsTransactionsGetRequestOptions(
                            count=500,
                            offset=offset,
                        ),
                    )
                ).to_dict()
                secs_by_id = {
                    s["security_id"]: s
                    for s in resp.get("securities", []) or []
                }
                batch = resp.get("investment_transactions", []) or []
                for t in batch:
                    investment_transactions.append({
                        "investment_transaction_id": t.get("investment_transaction_id"),
                        "account_id": t.get("account_id"),
                        "date": str(t.get("date")) if t.get("date") else None,
                        "type": t.get("type"),
                        "subtype": t.get("subtype"),
                        "amount": t.get("amount"),
                        "quantity": t.get("quantity"),
                        "price": t.get("price"),
                        "fees": t.get("fees"),
                        "currency": t.get("iso_currency_code"),
                        "symbol": secs_by_id.get(t.get("security_id"), {}).get("ticker_symbol"),
                        "name": secs_by_id.get(t.get("security_id"), {}).get("name"),
                        "institution": health.institution_name,
                    })
                total = resp.get("total_investment_transactions") or 0
                offset += len(batch)
                if offset >= total or not batch:
                    break
        except ApiException as e:
            mapped = map_plaid_error(e, health.institution_name)["error"]
            warnings.append({"institution": health.institution_name, **mapped})

    return {"investment_transactions": investment_transactions, "warnings": warnings}


get_investment_transactions = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Get Investment Transactions"},
    name="get_investment_transactions",
)(_get_investment_transactions_impl)


def _get_institutions_status_impl() -> dict:
    """Return health status for every linked Item/institution.

    No additional network calls beyond what ``all_items`` already makes (it
    uses the 5-minute health cache). Enumerates linked Items and reports their
    current health status.

    Returns:
        {"items": [{"env_key", "institution", "institution_id", "status", "reason"}, ...]}
    """
    api = build_api()
    items_out: list[dict] = []
    for env_key, token, health in all_items(api):
        items_out.append({
            "env_key": env_key,
            "institution": health.institution_name or env_key,
            "institution_id": health.institution_id,
            "status": health.status,
            "reason": health.reason,
        })
    return {"items": items_out}


get_institutions_status = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Get Institutions Status"},
    name="get_institutions_status",
)(_get_institutions_status_impl)


def _search_transactions_impl(
    query: str,
    start_date: str,
    end_date: str,
) -> dict:
    """Search transactions by keyword across merchant, name, and counterparty names.

    Fetches transactions in [start_date, end_date] and filters them with a
    case-insensitive substring match against:
    - ``merchant_name``
    - ``name``
    - ``counterparties[].name``

    The match is performed on the raw Plaid payload before shaping so that
    counterparty names (which are dropped by ``shape_transaction``) are
    searchable. Dates are ISO YYYY-MM-DD. The window is clipped to ~2 years
    and a WINDOW_CLIPPED warning is emitted when applicable.

    Returns:
        {"transactions": [...], "warnings": [...]}
    """
    api = build_api()
    transactions: list[dict] = []
    warnings: list[dict] = []

    clipped_start, clipped_end, clip_reason = _clip_window(start_date, end_date)
    if clip_reason:
        warnings.append({"code": "WINDOW_CLIPPED", "reason": clip_reason, "message": clip_reason})

    q = query.lower()

    for env_key, token, health in all_items(api):
        if health.status != "healthy":
            warnings.append(_warning_from_health(health))
            continue
        offset = 0
        try:
            while True:
                options = TransactionsGetRequestOptions(count=500, offset=offset)
                resp = api.transactions_get(
                    TransactionsGetRequest(
                        access_token=token.reveal(),
                        start_date=date.fromisoformat(clipped_start),
                        end_date=date.fromisoformat(clipped_end),
                        options=options,
                    )
                ).to_dict()
                batch = resp.get("transactions", []) or []
                for raw in batch:
                    merchant = (raw.get("merchant_name") or "").lower()
                    name = (raw.get("name") or "").lower()
                    counterparty_names = [
                        (cp.get("name") or "").lower()
                        for cp in (raw.get("counterparties") or [])
                    ]
                    if q in merchant or q in name or any(q in cp for cp in counterparty_names):
                        transactions.append(shape_transaction(raw))
                total = resp.get("total_transactions") or 0
                offset += len(batch)
                if offset >= total or not batch:
                    break
        except ApiException as e:
            mapped = map_plaid_error(e, health.institution_name)["error"]
            warnings.append({"institution": health.institution_name, **mapped})

    return {"transactions": transactions, "warnings": warnings}


search_transactions = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Search Transactions"},
    name="search_transactions",
)(_search_transactions_impl)


# ---------------------------------------------------------------------------
# History tools (Postgres-backed). See storage.py / sync.py / analytics.py.
# ---------------------------------------------------------------------------

import analytics  # noqa: E402
import storage  # noqa: E402
import sync as sync_mod  # noqa: E402
from plaid_client import plaid_call_count  # noqa: E402


def _sync_now_impl() -> dict:
    """Pull new/changed transactions and record today's snapshots into Postgres.

    Runs the /transactions/sync cursor flow for every healthy Item (resuming
    from each Item's stored cursor) and appends dated balance, holdings, and
    liabilities snapshot rows. Idempotent: re-running adds no duplicates.
    Writes only to the local database — never to Plaid or any bank.
    """
    return sync_mod.run_sync()


sync_now = mcp.tool(
    annotations={"title": "Sync Now (local history)"},
    name="sync_now",
)(_sync_now_impl)


def _get_net_worth_impl() -> dict:
    """Compute current net worth from live balances, broken down by asset class.

    Classes: cash (depository), investments (taxable investment accounts),
    retirement (401k/IRA/etc. subtypes), credit_debt, loans, other.
    net_worth = assets - liabilities. Uses live Plaid balances so the figure
    is current even between syncs; investment balances already include
    holdings market value.
    """
    live = _get_balances_impl()
    out = analytics.compose_net_worth(live["accounts"])
    out["warnings"] = live["warnings"]
    return out


get_net_worth = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Get Net Worth"},
    name="get_net_worth",
)(_get_net_worth_impl)


def _get_net_worth_history_impl() -> dict:
    """Net worth over time from local snapshots — zero Plaid calls.

    One row per snapshot date with assets, liabilities, and net worth.
    Snapshots accumulate each time sync_now (or the sync.py CLI) runs.
    """
    return analytics.net_worth_history()


get_net_worth_history = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Get Net Worth History"},
    name="get_net_worth_history",
)(_get_net_worth_history_impl)


def _aggregate_spending_impl(
    start_date: str,
    end_date: str,
    group_by: str = "category",
    monthly: bool = True,
    include_pending: bool = False,
) -> dict:
    """Aggregate spending from local history — zero Plaid calls, no lookback cap.

    Args:
        start_date / end_date: ISO YYYY-MM-DD, any range covered by synced data.
        group_by: "category" (personal finance category) or "merchant".
        monthly: also split totals by calendar month.
        include_pending: include pending transactions (default off).

    Spending counts Plaid outflows (amount > 0) and excludes transfers and
    loan/credit payments so internal money movement isn't "spending".
    """
    return analytics.aggregate_spending(
        start_date, end_date, group_by=group_by, monthly=monthly,
        include_pending=include_pending,
    )


aggregate_spending = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Aggregate Spending"},
    name="aggregate_spending",
)(_aggregate_spending_impl)


def _query_finances_impl(sql: str) -> dict:
    """Escape hatch: run a single read-only SELECT against the history database.

    Tables: accounts, transactions, balance_snapshots, holdings_snapshots,
    liabilities_snapshots, sync_state. Only SELECT/WITH statements are
    accepted; writes and DDL are rejected and the connection is opened
    read-only. Results are capped at 500 rows. Zero Plaid calls.
    """
    try:
        return analytics.query_finances(sql)
    except ValueError as e:
        return {"error": {"code": "INVALID_QUERY", "message": str(e)}}


query_finances = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Query Finances (read-only SQL)"},
    name="query_finances",
)(_query_finances_impl)


def _describe_tables_impl() -> dict:
    """Describe the history database schema: tables, columns, types, and conventions.

    Call this before writing query_finances SQL or when unsure where data
    lives. Includes the Plaid sign convention (amount > 0 = outflow) and the
    join keys between tables. Zero Plaid calls.
    """
    return analytics.describe_tables()


describe_tables = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Describe Local Tables"},
    name="describe_tables",
)(_describe_tables_impl)


def _list_transactions_impl(
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
) -> dict:
    """List raw transactions from local history with filters — zero Plaid calls.

    All filters are optional and combine with AND: ISO date range, account_id,
    category (personal-finance category, case-insensitive), merchant substring,
    amount bounds (Plaid convention: positive = outflow). Newest first, paged
    via limit (max 500) and offset; total_matching reports the unpaged count.
    Unlike get_transactions, this reads the local store, so there is no
    2-year lookback cap and no Plaid traffic.
    """
    return analytics.list_transactions(
        start_date=start_date, end_date=end_date, account_id=account_id,
        category=category, merchant_contains=merchant_contains,
        min_amount=min_amount, max_amount=max_amount,
        include_pending=include_pending, limit=limit, offset=offset,
    )


list_transactions = mcp.tool(
    annotations={"readOnlyHint": True, "title": "List Transactions (local)"},
    name="list_transactions",
)(_list_transactions_impl)


def _get_sync_status_impl() -> dict:
    """Report local-store freshness and the Plaid API call counter.

    Returns per-Item sync cursors/timestamps, row counts per table, and
    plaid_calls_this_session — the process-wide count of Plaid API calls,
    useful to prove that history-backed tools answer without hitting Plaid.
    """
    conn = storage.open_readonly()
    try:
        items = [
            {
                "item_key": r[0],
                "last_synced_at": str(r[1]) if r[1] else None,
                "tx_added": r[2], "tx_modified": r[3], "tx_removed": r[4],
            }
            for r in conn.execute(
                "SELECT item_key, last_synced_at, tx_added, tx_modified, tx_removed "
                "FROM sync_state ORDER BY item_key"
            ).fetchall()
        ]
        counts = {
            t: conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
            for t in ("accounts", "transactions", "balance_snapshots",
                      "holdings_snapshots", "liabilities_snapshots")
        }
    finally:
        conn.close()
    return {
        "items": items,
        "table_counts": counts,
        "plaid_calls_this_session": plaid_call_count(),
    }


get_sync_status = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Get Sync Status"},
    name="get_sync_status",
)(_get_sync_status_impl)


def _get_optimizer_score_impl() -> dict:
    """Score the Optimizer game from local history — zero Plaid calls.

    One hard rule: finish the whole month under the target ($2,600, everything
    in — rent, travel, dining, taxes; an expense is an expense). Returns the
    current month vs target with month-to-date pace and category breakdown,
    your best completed month, lifetime points, months won, and dollars saved
    toward the wedding. Only money that isn't a real expense (transfers, card
    payments, savings/investing) is excluded. See gamify.py.
    """
    import gamify
    return gamify.load_game()


get_optimizer_score = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Optimizer Score"},
    name="get_optimizer_score",
)(_get_optimizer_score_impl)


# ---------------------------------------------------------------------------
# Deep-insight tools (wealth.py / insights.py) — zero Plaid calls, answer
# from the local history store so agents can call them liberally.
# ---------------------------------------------------------------------------

import insights  # noqa: E402
import wealth  # noqa: E402


def _get_debt_analysis_impl(monthly_payment: float | None = None) -> dict:
    """What every carried debt actually costs, with concrete payoff plans.

    Per debt: balance, APR, credit utilization, minimum payment, due date,
    and monthly_interest_if_carried — the real dollar cost of revolving.
    payoff_scenarios amortizes the balance at the minimum payment, a few
    standard levels, and the optional monthly_payment you pass, each with
    months-to-zero and total interest (or an explicit "never pays off").
    Aggregates: total debt, balance-weighted APR, total monthly interest.
    """
    return wealth.get_debt_analysis(monthly_payment=monthly_payment)


get_debt_analysis = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Debt Analysis"},
    name="get_debt_analysis",
)(_get_debt_analysis_impl)


def _get_portfolio_analysis_impl() -> dict:
    """Portfolio at the latest holdings snapshot, aggregated by symbol.

    Positions with weight, unrealized gain where cost basis is known (never
    invented — basis_known flags partial data, basis_coverage_pct says how
    much of the portfolio the gain figures cover), a cash-like vs invested
    split (T-bill ETFs like BIL/SGOV count as parked cash, not bets),
    allocation by security type, and concentration (top position / top 5).
    """
    return wealth.get_portfolio_analysis()


get_portfolio_analysis = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Portfolio Analysis"},
    name="get_portfolio_analysis",
)(_get_portfolio_analysis_impl)


def _get_income_analysis_impl(months: int = 6) -> dict:
    """Inflows classified into typed buckets, with savings rate.

    Plaid's INCOME category is unreliable (vault transfers and refunds land
    there), so every inflow is classified by pattern: payroll, interest,
    tax_refund, other_income count as income; p2p, self_transfer,
    card_payment, refund are reported but never counted as income. Monthly
    series flags the in-progress month partial; averages and savings_rate
    use completed months only. Read caveats — ambiguous money is yours to
    interpret, and overrides can reclassify it.
    """
    return wealth.get_income_analysis(months=months)


get_income_analysis = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Income Analysis"},
    name="get_income_analysis",
)(_get_income_analysis_impl)


def _get_net_worth_trajectory_impl(milestone: float = 100000.0,
                                   months: int = 6) -> dict:
    """Where net worth is heading and when it crosses the milestone.

    Two independent monthly-change estimates: snapshot growth (used once
    snapshots span 21+ days) and average monthly net cashflow from
    transactions (works from day one; transfers between own accounts net
    out). Returns both, the chosen estimate_source, per-month net flows,
    and a milestone block with months_away and an ETA date.
    """
    return wealth.get_net_worth_trajectory(milestone=milestone, months=months)


get_net_worth_trajectory = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Net Worth Trajectory"},
    name="get_net_worth_trajectory",
)(_get_net_worth_trajectory_impl)


def _get_recurring_analysis_impl(months: int = 6) -> dict:
    """Recurring expense streams detected locally from charge cadence.

    Unlike Plaid's recurring API this is built from the full local history,
    so each stream carries price evolution: price_change flags creep (latest
    vs prior median beyond 5%), is_fixed_amount separates true bills from
    habitual merchants, and annualized_cost / monthly_equivalent make
    subscriptions comparable. Includes next_expected_date per stream and a
    price_increases shortlist. Card payments and transfers are excluded.
    """
    return insights.get_recurring_analysis(months=months)


get_recurring_analysis = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Recurring & Subscriptions"},
    name="get_recurring_analysis",
)(_get_recurring_analysis_impl)


def _get_merchant_profile_impl(merchant: str) -> dict:
    """The lifetime story of one merchant: total given, frequency, trend.

    Case-insensitive substring search over BOTH the cleaned merchant and the
    raw transaction name — so "doordash" finds orders Plaid filed under the
    restaurant's name. Returns lifetime totals, refunds, average/max ticket,
    first/last seen, a monthly series, a trend vs prior months, tags, and
    the most recent transactions.
    """
    return insights.get_merchant_profile(merchant)


get_merchant_profile = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Merchant Profile"},
    name="get_merchant_profile",
)(_get_merchant_profile_impl)


def _compare_periods_impl(period_a: str, period_b: str) -> dict:
    """Diff two months of spending and name what drove the change.

    Periods are YYYY-MM. Returns totals and delta, plus by_category and
    by_merchant rows (a, b, delta) sorted by absolute delta so the biggest
    movers lead. Transfers and loan payments are excluded, pending too.
    """
    try:
        return insights.compare_periods(period_a, period_b)
    except ValueError as e:
        return {"error": {"code": "INVALID_PERIOD", "message": str(e)}}


compare_periods = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Compare Periods"},
    name="compare_periods",
)(_compare_periods_impl)


def _get_financial_health_impl() -> dict:
    """One-call orientation across the whole financial picture.

    Net worth, liquid reserves (bank cash + cash-like brokerage positions),
    months of runway, debt cost, income vs expenses with savings rate,
    Optimizer-game pace, and net-worth trajectory — plus rule-based flags
    (high_utilization, expensive_debt, thin_runway, negative/low savings,
    unknown_cost_basis, over_pace) for what deserves attention. Start here
    when forming an overall view, then drill into the dedicated tools.
    """
    return insights.get_financial_health()


get_financial_health = mcp.tool(
    annotations={"readOnlyHint": True, "title": "Financial Health"},
    name="get_financial_health",
)(_get_financial_health_impl)


def _set_category_override_impl(match_type: str, match_value: str,
                                set_primary: str | None = None,
                                set_detailed: str | None = None,
                                note: str | None = None) -> dict:
    """Durably correct a transaction category — the fix survives re-syncs.

    match_type 'merchant' rewrites every transaction whose merchant+name
    contains match_value (case-insensitive); 'transaction' targets one
    transaction_id. set_primary/set_detailed write category_primary/
    category_detailed (NULL leaves a field unchanged). The override is
    stored as a rule and re-applied after every sync and import, so use it
    to permanently fix provider miscategorization (e.g. a photographer
    filed as FOOD_AND_DRINK → WEDDING). Applied to existing rows
    immediately; include a note saying why.
    """
    try:
        storage.add_override(match_type, match_value, set_primary=set_primary,
                             set_detailed=set_detailed, note=note)
    except ValueError as e:
        return {"error": {"code": "INVALID_OVERRIDE", "message": str(e)}}
    conn = storage.open_db()
    try:
        touched = storage.apply_overrides(conn)
    finally:
        conn.close()
    return {
        "ok": True,
        "match_type": match_type,
        "match_value": match_value.lower().strip(),
        "set_primary": set_primary,
        "set_detailed": set_detailed,
        "applied_to_transactions": touched,
    }


set_category_override = mcp.tool(
    annotations={"title": "Set Category Override"},
    name="set_category_override",
)(_set_category_override_impl)


def _list_category_overrides_impl() -> dict:
    """List the category-correction rulebook (see set_category_override)."""
    overrides = storage.list_overrides()
    return {"overrides": overrides, "count": len(overrides)}


list_category_overrides = mcp.tool(
    annotations={"readOnlyHint": True, "title": "List Category Overrides"},
    name="list_category_overrides",
)(_list_category_overrides_impl)


if __name__ == "__main__":
    mcp.run(
        transport="http",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8000")),
    )
