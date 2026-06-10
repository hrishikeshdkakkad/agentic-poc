"""Tests for analytics.py and the new history-backed MCP tools."""
import asyncio
from unittest.mock import MagicMock, patch

import pytest

import analytics
import storage
import server as srv
from plaid_client import ItemHealth, SecretStr, plaid_call_count


@pytest.fixture
def seeded_db(db):
    """The Postgres test store seeded with multi-month sandbox-shaped data."""
    conn = db
    txs = [
        # (id, date, amount, category, merchant, pending)
        ("t1", "2025-01-05", 12.50, "FOOD_AND_DRINK", "Starbucks", False),
        ("t2", "2025-01-20", 55.00, "FOOD_AND_DRINK", "Chipotle", False),
        ("t3", "2025-02-03", 80.00, "TRAVEL", "Uber", False),
        ("t4", "2025-02-14", 40.00, "FOOD_AND_DRINK", "Starbucks", False),
        ("t5", "2025-03-01", 1200.00, "RENT_AND_UTILITIES", "Landlord", False),
        ("t6", "2025-03-09", -2500.00, "INCOME", "Employer", False),   # inflow
        ("t7", "2025-03-15", 500.00, "TRANSFER_OUT", "To Savings", False),  # excluded
        ("t8", "2025-03-20", 9.99, "ENTERTAINMENT", "Netflix", True),  # pending
    ]
    for tid, dt, amt, cat, merch, pending in txs:
        conn.execute(
            "INSERT INTO transactions VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())",
            (tid, "acc_chk", "CHASE", dt, dt, amt, "USD", merch,
             f"{merch} txn", cat, f"{cat}_X", pending),
        )
    for sd, cur in (("2025-01-31", 1000.0), ("2025-02-28", 1500.0), ("2025-03-31", 2000.0)):
        conn.execute(
            "INSERT INTO balance_snapshots VALUES (%s, now(), 'acc_chk', 'CHASE', 'Chase', "
            "'depository', 'checking', %s, %s, NULL, 'USD')", (sd, cur, cur))
        conn.execute(
            "INSERT INTO balance_snapshots VALUES (%s, now(), 'acc_cc', 'CHASE', 'Chase', "
            "'credit', 'credit card', 400.0, NULL, 5000.0, 'USD')", (sd,))
    return conn


def test_aggregate_spending_by_category_by_month(seeded_db):
    out = analytics.aggregate_spending("2025-01-01", "2025-03-31",
                                       group_by="category", monthly=True)
    rows = {(r["month"], r["category"]): r["total"] for r in out["rows"]}
    assert rows[("2025-01", "FOOD_AND_DRINK")] == 67.50
    assert rows[("2025-02", "FOOD_AND_DRINK")] == 40.00
    assert rows[("2025-02", "TRAVEL")] == 80.00
    assert rows[("2025-03", "RENT_AND_UTILITIES")] == 1200.00
    # transfers, inflows, and pending excluded
    assert not any(k[1] in ("TRANSFER_OUT", "INCOME", "ENTERTAINMENT") for k in rows)
    assert out["grand_total"] == pytest.approx(67.50 + 40.0 + 80.0 + 1200.0)


def test_aggregate_spending_by_merchant_includes_pending_when_asked(seeded_db):
    out = analytics.aggregate_spending("2025-01-01", "2025-03-31",
                                       group_by="merchant", monthly=False,
                                       include_pending=True)
    rows = {r["merchant"]: r["total"] for r in out["rows"]}
    assert rows["Starbucks"] == 52.50
    assert rows["Netflix"] == 9.99


def test_aggregate_spending_validates_inputs(seeded_db):
    with pytest.raises(ValueError):
        analytics.aggregate_spending("2025-01-01", "2025-03-31", group_by="evil; DROP")
    with pytest.raises(ValueError):
        analytics.aggregate_spending("not-a-date", "2025-03-31")


def test_aggregate_spending_makes_zero_plaid_calls(seeded_db):
    before = plaid_call_count()
    analytics.aggregate_spending("2025-01-01", "2025-03-31")
    analytics.net_worth_history()
    analytics.query_finances("SELECT count(*) FROM transactions")
    assert plaid_call_count() == before


def test_net_worth_history_from_snapshots(seeded_db):
    out = analytics.net_worth_history()
    assert [h["date"] for h in out["history"]] == ["2025-01-31", "2025-02-28", "2025-03-31"]
    first = out["history"][0]
    assert first == {"date": "2025-01-31", "assets": 1000.0,
                     "liabilities": 400.0, "net_worth": 600.0}


def test_query_finances_select_works_and_writes_rejected(seeded_db):
    out = analytics.query_finances("SELECT count(*) AS n FROM transactions")
    assert out["rows"][0][0] == 8
    for bad in (
        "DELETE FROM transactions",
        "INSERT INTO transactions VALUES (1)",
        "SELECT 1; DROP TABLE transactions",
        "ATTACH 'other.db'",
        "COPY transactions TO '/tmp/out.csv'",
        "WITH x AS (SELECT 1) INSERT INTO transactions SELECT * FROM x",
        "PRAGMA database_list",
    ):
        with pytest.raises(ValueError):
            analytics.query_finances(bad)


def test_query_finances_connection_is_readonly(seeded_db):
    # Even if validation were bypassed, the connection itself is read-only.
    conn = storage.open_readonly()
    with pytest.raises(Exception):
        conn.execute("DELETE FROM transactions")
    conn.close()


def _shaped(handle, typ, subtype, current, institution="Chase"):
    return {"handle": handle, "name": handle, "institution": institution,
            "type": typ, "subtype": subtype, "balance": {"current": current}}


def test_compose_net_worth_by_asset_class():
    accounts = [
        _shaped("chase_checking_0001", "depository", "checking", 1500.0),
        _shaped("chase_savings_0002", "depository", "savings", 8000.0),
        _shaped("fid_brokerage_0003", "investment", "brokerage", 20000.0),
        _shaped("fid_401k_0004", "investment", "401k", 50000.0),
        _shaped("fid_ira_0005", "investment", "ira", 10000.0),
        _shaped("chase_cc_0006", "credit", "credit card", 400.0),
        _shaped("nav_student_0007", "loan", "student", 12000.0),
    ]
    out = analytics.compose_net_worth(accounts)
    assert out["by_class"]["cash"]["total"] == 9500.0
    assert out["by_class"]["investments"]["total"] == 20000.0
    assert out["by_class"]["retirement"]["total"] == 60000.0
    assert out["by_class"]["credit_debt"]["total"] == 400.0
    assert out["by_class"]["loans"]["total"] == 12000.0
    assert out["total_assets"] == 89500.0
    assert out["total_liabilities"] == 12400.0
    assert out["net_worth"] == 77100.0


def test_get_net_worth_tool_uses_live_balances(seeded_db, fake_env_tokens):
    fake_api = MagicMock()
    fake_api.accounts_balance_get.return_value.to_dict.return_value = {
        "accounts": [
            {"account_id": "a1", "name": "Checking", "mask": "0001",
             "type": "depository", "subtype": "checking",
             "balances": {"current": 100.0, "iso_currency_code": "USD"}},
            {"account_id": "a2", "name": "Visa", "mask": "0002",
             "type": "credit", "subtype": "credit card",
             "balances": {"current": 30.0, "iso_currency_code": "USD"}},
        ],
    }
    items = [("CHASE", SecretStr("t"), ItemHealth("CHASE", "healthy", "ins_3", "Chase"))]
    with patch.object(srv, "build_api", return_value=fake_api), \
         patch.object(srv, "all_items", return_value=items):
        out = srv._get_net_worth_impl()
    assert out["net_worth"] == 70.0
    assert out["by_class"]["cash"]["total"] == 100.0
    assert out["by_class"]["credit_debt"]["total"] == 30.0


def test_new_tools_registered():
    tools = asyncio.run(srv.mcp.list_tools())
    names = {t.name for t in tools}
    assert {"sync_now", "get_net_worth", "get_net_worth_history",
            "aggregate_spending", "query_finances", "get_sync_status",
            "describe_tables", "list_transactions"} <= names
    # original 9 still present
    assert {"list_accounts", "get_balances", "get_transactions",
            "get_recurring_transactions", "get_liabilities",
            "get_investment_holdings", "get_investment_transactions",
            "get_institutions_status", "search_transactions"} <= names


def test_describe_tables_reports_schema_and_notes(seeded_db):
    out = analytics.describe_tables()
    assert set(out["tables"]) == {
        "accounts", "transactions", "balance_snapshots",
        "holdings_snapshots", "liabilities_snapshots", "sync_state",
        "transaction_tags", "category_overrides",
    }
    tx = out["tables"]["transactions"]
    assert "outflow" in tx["description"]
    cols = {c["name"]: c for c in tx["columns"]}
    assert cols["amount"]["type"] == "double precision"
    assert "Positive = money out" in cols["amount"]["note"]
    assert any("outflow" in c for c in out["conventions"])


def test_list_transactions_filters_and_paging(seeded_db):
    out = analytics.list_transactions(category="food_and_drink")
    assert out["total_matching"] == 3
    assert {t["merchant"] for t in out["transactions"]} == {"Starbucks", "Chipotle"}

    out = analytics.list_transactions(merchant_contains="star")
    assert all(t["merchant"] == "Starbucks" for t in out["transactions"])
    assert out["total_matching"] == 2

    out = analytics.list_transactions(start_date="2025-02-01", end_date="2025-02-28")
    assert {t["transaction_id"] for t in out["transactions"]} == {"t3", "t4"}

    out = analytics.list_transactions(min_amount=100.0, include_pending=False)
    assert {t["transaction_id"] for t in out["transactions"]} == {"t5", "t7"}

    out = analytics.list_transactions(limit=2, offset=0)
    assert len(out["transactions"]) == 2
    assert out["total_matching"] == 8
    # newest first
    assert out["transactions"][0]["date"] >= out["transactions"][1]["date"]
    page2 = analytics.list_transactions(limit=2, offset=2)
    assert {t["transaction_id"] for t in page2["transactions"]}.isdisjoint(
        {t["transaction_id"] for t in out["transactions"]}
    )


def test_list_transactions_validates_dates_and_caps_limit(seeded_db):
    with pytest.raises(ValueError):
        analytics.list_transactions(start_date="not-a-date")
    out = analytics.list_transactions(limit=99999)
    assert out["limit"] == 500


def test_list_transactions_zero_plaid_calls(seeded_db):
    before = plaid_call_count()
    analytics.list_transactions(category="FOOD_AND_DRINK")
    analytics.describe_tables()
    assert plaid_call_count() == before


def test_get_sync_status_reports_counts_and_counter(seeded_db):
    out = srv._get_sync_status_impl()
    assert out["table_counts"]["transactions"] == 8
    assert out["table_counts"]["balance_snapshots"] == 6
    assert isinstance(out["plaid_calls_this_session"], int)


def test_list_transactions_includes_tags(seeded_db):
    seeded_db.execute(
        "INSERT INTO transaction_tags (transaction_id, tag, source) "
        "VALUES ('t1', 'delivery', 'rule')")
    out = analytics.list_transactions(merchant_contains="Starbucks")
    by_id = {t["transaction_id"]: t for t in out["transactions"]}
    assert by_id["t1"]["tags"] == ["delivery"]
    assert by_id["t4"]["tags"] == []


def test_new_insight_and_override_tools_registered():
    tools = asyncio.run(srv.mcp.list_tools())
    names = {getattr(t, "name", None) for t in tools}
    assert {
        "get_debt_analysis", "get_portfolio_analysis", "get_income_analysis",
        "get_net_worth_trajectory", "get_recurring_analysis",
        "get_merchant_profile", "compare_periods", "get_financial_health",
        "set_category_override", "list_category_overrides",
    } <= names


def test_set_category_override_tool_applies_immediately(db):
    db.execute(
        "INSERT INTO transactions VALUES ('p1','acc','CHASE','2026-05-01',"
        "'2026-05-01',825.0,'USD','Stephanie Hopkins Pho',"
        "'STEPHANIE HOPKINS PHO','FOOD_AND_DRINK',NULL,FALSE,now())")
    out = srv._set_category_override_impl(
        "merchant", "stephanie hopkins", set_primary="WEDDING",
        note="proposal photographer, not a restaurant")
    assert out["applied_to_transactions"] == 1
    assert db.execute(
        "SELECT category_primary FROM transactions WHERE transaction_id='p1'"
    ).fetchone()[0] == "WEDDING"
    lst = srv._list_category_overrides_impl()
    assert lst["overrides"][0]["match_value"] == "stephanie hopkins"
    assert lst["count"] == 1


def test_set_category_override_rejects_bad_match_type(db):
    out = srv._set_category_override_impl("category", "food", set_primary="X")
    assert out["error"]["code"] == "INVALID_OVERRIDE"
