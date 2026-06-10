"""Tests for wealth.py — debt, portfolio, income, and net-worth trajectory."""
from datetime import date

import pytest

import wealth


# ---------------------------------------------------------------------------
# seed helpers (column orders match storage.py DDL)
# ---------------------------------------------------------------------------

def _tx(conn, tid, dt, amount, cat, merchant, name=None, acct="acc_chk", item="CHASE"):
    conn.execute(
        "INSERT INTO transactions VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())",
        (tid, acct, item, dt, dt, amount, "USD", merchant, name or merchant,
         cat, None, False),
    )


def _account(conn, acct, typ, subtype, name, institution="Chase", item="CHASE"):
    conn.execute(
        "INSERT INTO accounts VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,now())",
        (acct, item, institution, name, name, "0000", typ, subtype, "USD"),
    )


def _liability(conn, sd, acct="acc_cc", balance=5856.91, apr=26.74, minpay=41.0,
               ltype="credit", item="CHASE"):
    conn.execute(
        "INSERT INTO liabilities_snapshots VALUES (%s, now(), %s, %s, %s, %s, %s, NULL, %s, %s, FALSE, 'USD')",
        (sd, acct, item, ltype, balance, apr, minpay, "2026-06-24"),
    )


def _balance(conn, sd, acct, current, limit=None, typ="depository",
             subtype="checking", item="CHASE", institution="Chase"):
    conn.execute(
        "INSERT INTO balance_snapshots VALUES (%s, now(), %s, %s, %s, %s, %s, %s, NULL, %s, 'USD')",
        (sd, acct, item, institution, typ, subtype, current, limit),
    )


def _holding(conn, sd, symbol, sec_type, qty, price, mv, basis,
             acct="acc_rh", name=None, item="ROBINHOOD"):
    conn.execute(
        "INSERT INTO holdings_snapshots VALUES (%s, now(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'USD')",
        (sd, acct, item, f"sec_{symbol}_{acct}", symbol, name or symbol,
         sec_type, qty, price, mv, basis),
    )


# ---------------------------------------------------------------------------
# get_debt_analysis
# ---------------------------------------------------------------------------

def test_debt_analysis_utilization_interest_and_payoff(db):
    _account(db, "acc_cc", "credit", "credit card", "Chase Freedom")
    _liability(db, "2026-06-10")
    _balance(db, "2026-06-10", "acc_cc", 5856.91, limit=10000.0,
             typ="credit", subtype="credit card")

    out = wealth.get_debt_analysis(monthly_payment=500.0)
    assert len(out["debts"]) == 1
    d = out["debts"][0]
    assert d["institution"] == "Chase"
    assert d["balance"] == 5856.91
    assert d["apr_percentage"] == 26.74
    assert d["utilization_pct"] == pytest.approx(58.57, abs=0.01)
    # 5856.91 * 26.74% / 12 — what one month of carrying this balance costs
    assert d["monthly_interest_if_carried"] == pytest.approx(130.51, abs=0.05)

    scenarios = {s["monthly_payment"]: s for s in d["payoff_scenarios"]}
    # the $41 minimum doesn't even cover interest — payoff never completes
    assert scenarios[41.0]["months"] is None
    assert "never" in scenarios[41.0]["verdict"]
    # $500/mo clears it in about 14 months with meaningful interest paid
    s500 = scenarios[500.0]
    assert 12 <= s500["months"] <= 16
    assert s500["total_interest"] > 500
    assert out["total_debt"] == 5856.91
    assert out["total_monthly_interest_if_carried"] == pytest.approx(130.51, abs=0.05)


def test_debt_analysis_skips_zero_balances_and_handles_empty(db):
    _account(db, "acc_cc", "credit", "credit card", "Chase Freedom")
    _account(db, "acc_rhcc", "credit", "credit card", "Robinhood Card",
             institution="Robinhood", item="ROBINHOOD")
    _liability(db, "2026-06-10")
    _liability(db, "2026-06-10", acct="acc_rhcc", balance=0.0, apr=None,
               minpay=None, item="ROBINHOOD")

    out = wealth.get_debt_analysis()
    assert [d["account_id"] for d in out["debts"]] == ["acc_cc"]

    db.execute("TRUNCATE liabilities_snapshots")
    empty = wealth.get_debt_analysis()
    assert empty["debts"] == [] and empty["total_debt"] == 0.0


def test_debt_analysis_uses_latest_snapshot_only(db):
    _account(db, "acc_cc", "credit", "credit card", "Chase Freedom")
    _liability(db, "2026-06-01", balance=7000.0)
    _liability(db, "2026-06-10", balance=5856.91)
    out = wealth.get_debt_analysis()
    assert out["debts"][0]["balance"] == 5856.91


# ---------------------------------------------------------------------------
# get_portfolio_analysis
# ---------------------------------------------------------------------------

def _seed_portfolio(db):
    sd = "2026-06-10"
    # BIL held in two accounts: one with basis, one without (null-safe path)
    _holding(db, sd, "BIL", "etf", 336.44, 91.46, 30770.70, 30806.77, acct="rh_1")
    _holding(db, sd, "BIL", "etf", 373.60, 91.475, 34174.91, None, acct="rh_2")
    _holding(db, sd, "AMZN", "equity", 38.93, 244.05, 9500.07, 10283.04, acct="rh_1")
    _holding(db, sd, "CUR:USD", "cash", 127.16, 1.0, 127.16, None, acct="rh_1")
    # an older snapshot that must be ignored
    _holding(db, "2026-06-01", "AMZN", "equity", 38.93, 230.0, 8952.0, 10283.04, acct="rh_1")


def test_portfolio_aggregates_by_symbol_at_latest_snapshot(db):
    _seed_portfolio(db)
    out = wealth.get_portfolio_analysis()
    assert out["as_of"] == "2026-06-10"
    assert out["total_value"] == pytest.approx(74572.84, abs=0.01)

    pos = {p["symbol"]: p for p in out["positions"]}
    assert pos["BIL"]["market_value"] == pytest.approx(64945.61, abs=0.01)
    assert pos["BIL"]["accounts"] == 2
    # AMZN has full basis: unrealized loss is computable
    assert pos["AMZN"]["unrealized_gain"] == pytest.approx(-782.97, abs=0.01)
    assert pos["AMZN"]["unrealized_pct"] == pytest.approx(-7.61, abs=0.05)
    # BIL basis is only partially known — no pretend gain numbers
    assert pos["BIL"]["unrealized_gain"] is None
    assert pos["BIL"]["basis_known"] is False


def test_portfolio_cash_like_split_and_concentration(db):
    _seed_portfolio(db)
    out = wealth.get_portfolio_analysis()
    # BIL is a T-bill ETF and CUR:USD is cash — both cash-like, not "invested"
    assert out["cash_like_value"] == pytest.approx(64945.61 + 127.16, abs=0.01)
    assert out["invested_value"] == pytest.approx(9500.07, abs=0.01)
    top = out["concentration"]["top_position"]
    assert top["symbol"] == "BIL"
    assert top["weight_pct"] == pytest.approx(87.1, abs=0.2)
    # basis coverage: only BIL(rh_1) + AMZN rows carry basis
    assert out["basis_coverage_pct"] == pytest.approx(54.0, abs=1.0)


def test_portfolio_empty(db):
    out = wealth.get_portfolio_analysis()
    assert out["positions"] == [] and out["total_value"] == 0.0


# ---------------------------------------------------------------------------
# get_income_analysis
# ---------------------------------------------------------------------------

def test_classify_inflow_buckets():
    cl = wealth.classify_inflow
    assert cl("INCOME", "ACME PAYROLL DIRECT DEP", None) == "payroll"
    assert cl("INCOME", "Interest earned", None) == "interest"
    assert cl("TRANSFER_IN", "Zelle® Payment from Sankalp", None) == "p2p"
    assert cl("LOAN_DISBURSEMENTS", "Payment Thank You-Mobile", None) == "card_payment"
    assert cl("PAYMENT", "ACH DEPOSIT INTERNET TRANSFER", None) == "card_payment"
    assert cl("INCOME", "From Wedding Vault", None) == "self_transfer"
    assert cl("TRANSFER_IN", "From Savings - 6772", None) == "self_transfer"
    assert cl("INCOME", "Ca Franchise Tax Board", None) == "tax_refund"
    assert cl("OTHER", "STATEMENT CREDIT", None) == "refund"
    assert cl("CREDIT", "WALMART (RETURN)", "Walmart") == "refund"
    assert cl("INCOME", "TOCK AT*DOMAINE CARNER", None) == "other_income"


def _seed_income(db):
    # April (complete month)
    _tx(db, "i1", "2026-04-15", -3000.0, "INCOME", "Acme", "ACME PAYROLL DIRECT DEP")
    _tx(db, "i2", "2026-04-14", -353.0, "INCOME", "Ca Franchise Tax Board")
    _tx(db, "i3", "2026-04-29", -500.0, "TRANSFER_IN", "Zelle® Payment from Sankalp")
    _tx(db, "i4", "2026-04-05", -1000.0, "INCOME", "From Wedding Vault")
    _tx(db, "e1", "2026-04-01", 1800.0, "OTHER", "Ett*applejackllcrent")
    _tx(db, "e2", "2026-04-10", 200.0, "FOOD_AND_DRINK", "Chipotle")
    # May (complete month)
    _tx(db, "i5", "2026-05-15", -3000.0, "INCOME", "Acme", "ACME PAYROLL DIRECT DEP")
    _tx(db, "i6", "2026-05-30", -1.60, "INCOME", "Interest earned")
    _tx(db, "i7", "2026-05-24", -632.60, "LOAN_DISBURSEMENTS", "Payment Thank You-Mobile")
    _tx(db, "e3", "2026-05-01", 1800.0, "OTHER", "Ett*applejackllcrent")
    # June (partial as of the 10th)
    _tx(db, "i8", "2026-06-02", -100.0, "INCOME", "Acme", "ACME PAYROLL DIRECT DEP")


def test_income_analysis_buckets_and_savings_rate(db):
    _seed_income(db)
    out = wealth.get_income_analysis(months=3, as_of=date(2026, 6, 10))

    b = out["by_bucket"]
    assert b["payroll"] == pytest.approx(6100.0)
    assert b["tax_refund"] == pytest.approx(353.0)
    assert b["p2p"] == pytest.approx(500.0)
    assert b["self_transfer"] == pytest.approx(1000.0)
    assert b["card_payment"] == pytest.approx(632.60)
    assert b["interest"] == pytest.approx(1.60)

    # averages use completed months only (April + May), June is partial
    assert out["completed_months"] == 2
    assert out["estimated_monthly_income"] == pytest.approx((3353.0 + 3001.6) / 2, abs=0.01)
    assert out["avg_monthly_expenses"] == pytest.approx((2000.0 + 1800.0) / 2, abs=0.01)
    expected_rate = 1 - 1900.0 / 3177.3
    assert out["savings_rate"] == pytest.approx(expected_rate, abs=0.01)

    months = {m["month"]: m for m in out["months"]}
    assert months["2026-06"]["partial"] is True
    assert months["2026-04"]["partial"] is False
    # p2p and transfers never silently inflate income
    assert "p2p" not in wealth.INCOME_BUCKETS
    assert any("p2p" in c for c in out["caveats"])


def test_income_analysis_no_income(db):
    _tx(db, "e1", "2026-05-02", 50.0, "FOOD_AND_DRINK", "Chipotle")
    out = wealth.get_income_analysis(months=3, as_of=date(2026, 6, 10))
    assert out["estimated_monthly_income"] == 0.0
    assert out["savings_rate"] is None


# ---------------------------------------------------------------------------
# get_net_worth_trajectory
# ---------------------------------------------------------------------------

def test_trajectory_from_snapshots_with_milestone(db):
    _balance(db, "2026-05-10", "acc_chk", 80000.0)
    _balance(db, "2026-06-09", "acc_chk", 90000.0)
    out = wealth.get_net_worth_trajectory(milestone=100000.0, as_of=date(2026, 6, 10))
    assert out["status"] == "ok"
    assert out["current_net_worth"] == 90000.0
    assert out["estimate_source"] == "snapshots"
    # ~$10k over 30 days ≈ $10.1k/month
    assert out["estimated_monthly_change"] == pytest.approx(10133, rel=0.05)
    m = out["milestone"]
    assert m["target"] == 100000.0 and not m["reached"]
    assert m["months_away"] == pytest.approx(1.0, abs=0.3)
    assert m["eta"].startswith("2026-07")


def test_trajectory_falls_back_to_cashflow_when_snapshots_thin(db):
    _balance(db, "2026-06-08", "acc_chk", 90000.0)
    _balance(db, "2026-06-09", "acc_chk", 90050.0)
    # two complete months of +$1,000 net flow
    _tx(db, "i1", "2026-04-15", -3000.0, "INCOME", "Acme")
    _tx(db, "e1", "2026-04-20", 2000.0, "OTHER", "Ett*applejackllcrent")
    _tx(db, "i2", "2026-05-15", -3000.0, "INCOME", "Acme")
    _tx(db, "e2", "2026-05-20", 2000.0, "OTHER", "Ett*applejackllcrent")
    out = wealth.get_net_worth_trajectory(milestone=100000.0, as_of=date(2026, 6, 10))
    assert out["status"] == "ok"
    assert out["estimate_source"] == "cashflow"
    assert out["estimated_monthly_change"] == pytest.approx(1000.0, abs=1.0)
    assert out["milestone"]["months_away"] == pytest.approx(9.95, abs=0.5)


def test_trajectory_without_any_snapshots(db):
    out = wealth.get_net_worth_trajectory()
    assert out["status"] == "insufficient_history"
    assert out["current_net_worth"] is None
