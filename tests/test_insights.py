"""Tests for insights.py — recurring detection, merchant profile, period
comparison, and the composite financial-health view."""
from datetime import date

import pytest

import insights


def _tx(conn, tid, dt, amount, cat, merchant, name=None, acct="acc_chk", item="CHASE"):
    conn.execute(
        "INSERT INTO transactions VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())",
        (tid, acct, item, dt, dt, amount, "USD", merchant, name or merchant,
         cat, None, False),
    )


AS_OF = date(2026, 6, 10)


# ---------------------------------------------------------------------------
# get_recurring_analysis
# ---------------------------------------------------------------------------

def _seed_recurring(db):
    # Netflix monthly with a price hike in April
    for i, (dt, amt) in enumerate([("2026-01-05", 9.99), ("2026-02-05", 9.99),
                                   ("2026-03-05", 9.99), ("2026-04-05", 12.99),
                                   ("2026-05-05", 12.99)]):
        _tx(db, f"nf{i}", dt, amt, "ENTERTAINMENT", "Netflix")
    # Rent monthly, fixed
    for i, dt in enumerate(["2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01"]):
        _tx(db, f"rent{i}", dt, 1800.0, "OTHER", "Ett*applejackllcrent")
    # One-off and a twice-only merchant: neither is recurring
    _tx(db, "w1", "2026-03-15", 84.12, "GENERAL_MERCHANDISE", "Walmart")
    _tx(db, "c1", "2026-01-09", 6.0, "FOOD_AND_DRINK", "Blue Bottle")
    _tx(db, "c2", "2026-03-22", 6.0, "FOOD_AND_DRINK", "Blue Bottle")


def test_recurring_detects_monthly_streams_and_price_creep(db):
    _seed_recurring(db)
    out = insights.get_recurring_analysis(months=6, as_of=AS_OF)
    streams = {s["merchant"]: s for s in out["streams"]}

    assert "Netflix" in streams and "Ett*applejackllcrent" in streams
    assert "Walmart" not in streams and "Blue Bottle" not in streams

    nf = streams["Netflix"]
    assert nf["cadence"] == "monthly"
    assert nf["latest_amount"] == 12.99
    assert nf["price_change"] is not None
    assert nf["price_change"]["pct"] == pytest.approx(30.03, abs=0.1)
    assert nf["annualized_cost"] == pytest.approx(12.99 * 12, abs=0.01)
    assert nf["next_expected_date"].startswith("2026-06-0")

    rent = streams["Ett*applejackllcrent"]
    assert rent["is_fixed_amount"] is True and rent["price_change"] is None
    assert out["monthly_recurring_total"] == pytest.approx(12.99 + 1800.0, abs=0.01)


def test_recurring_detects_weekly_and_merges_same_day_charges(db):
    for i, dt in enumerate(["2026-04-06", "2026-04-13", "2026-04-20",
                            "2026-04-27", "2026-05-04"]):
        _tx(db, f"g{i}", dt, 12.0, "PERSONAL_CARE", "Planet Fitness")
    # same-day double charge must collapse into one event, not break intervals
    _tx(db, "g_dup", "2026-04-20", 12.0, "PERSONAL_CARE", "Planet Fitness")
    out = insights.get_recurring_analysis(months=3, as_of=AS_OF)
    pf = next(s for s in out["streams"] if s["merchant"] == "Planet Fitness")
    assert pf["cadence"] == "weekly"
    assert pf["annualized_cost"] == pytest.approx(12.0 * 52, rel=0.05)


# ---------------------------------------------------------------------------
# get_merchant_profile
# ---------------------------------------------------------------------------

def test_merchant_profile_lifetime_and_trend(db):
    for i, (dt, amt) in enumerate([("2026-03-02", 6.50), ("2026-03-20", 5.25),
                                   ("2026-04-11", 7.00), ("2026-05-05", 6.25),
                                   ("2026-05-28", 8.00)]):
        _tx(db, f"sb{i}", dt, amt, "FOOD_AND_DRINK", "Starbucks")
    _tx(db, "sbr", "2026-05-29", -5.25, "FOOD_AND_DRINK", "Starbucks")  # refund

    out = insights.get_merchant_profile("starbucks", as_of=AS_OF)
    assert out["transaction_count"] == 5
    assert out["total_spent"] == pytest.approx(33.0)
    assert out["total_refunded"] == pytest.approx(5.25)
    assert out["avg_ticket"] == pytest.approx(6.60)
    assert out["first_seen"] == "2026-03-02" and out["last_seen"] == "2026-05-29"
    months = {m["month"]: m["total"] for m in out["monthly"]}
    assert months["2026-05"] == pytest.approx(14.25)


def test_merchant_profile_searches_raw_name_too(db):
    _tx(db, "dd1", "2026-05-05", 25.0, "FOOD_AND_DRINK", "Subway",
        name="DD *DOORDASH SUBWAY")
    out = insights.get_merchant_profile("doordash", as_of=AS_OF)
    assert out["transaction_count"] == 1
    assert out["matched_merchants"] == ["Subway"]


def test_merchant_profile_no_matches(db):
    out = insights.get_merchant_profile("nonexistent", as_of=AS_OF)
    assert out["transaction_count"] == 0 and out["total_spent"] == 0.0


# ---------------------------------------------------------------------------
# compare_periods
# ---------------------------------------------------------------------------

def test_compare_periods_category_and_merchant_drivers(db):
    _tx(db, "a1", "2026-04-03", 500.0, "FOOD_AND_DRINK", "Chipotle")
    _tx(db, "a2", "2026-04-10", 200.0, "GENERAL_MERCHANDISE", "Target")
    _tx(db, "a3", "2026-04-12", 900.0, "TRANSFER_OUT", "To Savings")  # excluded
    _tx(db, "b1", "2026-05-08", 300.0, "FOOD_AND_DRINK", "Chipotle")
    _tx(db, "b2", "2026-05-15", 400.0, "TRAVEL", "United")

    out = insights.compare_periods("2026-04", "2026-05")
    assert out["total_a"] == pytest.approx(700.0)
    assert out["total_b"] == pytest.approx(700.0)
    assert out["delta"] == pytest.approx(0.0)

    cats = {r["category"]: r for r in out["by_category"]}
    assert cats["TRAVEL"]["delta"] == pytest.approx(400.0)
    assert cats["FOOD_AND_DRINK"]["delta"] == pytest.approx(-200.0)
    assert cats["GENERAL_MERCHANDISE"]["delta"] == pytest.approx(-200.0)
    assert "TRANSFER_OUT" not in cats
    # sorted by |delta| — the biggest mover leads
    assert out["by_category"][0]["category"] == "TRAVEL"
    merch = {r["merchant"]: r for r in out["by_merchant"]}
    assert merch["United"]["delta"] == pytest.approx(400.0)


def test_compare_periods_validates_format(db):
    with pytest.raises(ValueError):
        insights.compare_periods("2026-4", "2026-05")


# ---------------------------------------------------------------------------
# get_financial_health
# ---------------------------------------------------------------------------

def test_financial_health_composite_and_flags(db):
    # debt: Chase card, high APR, 58% utilization
    db.execute(
        "INSERT INTO liabilities_snapshots VALUES ('2026-06-10', now(), 'acc_cc', "
        "'CHASE', 'credit', 5856.91, 26.74, NULL, 41.0, '2026-06-24', FALSE, 'USD')")
    db.execute(
        "INSERT INTO balance_snapshots VALUES ('2026-06-10', now(), 'acc_cc', 'CHASE', "
        "'Chase', 'credit', 'credit card', 5856.91, NULL, 10000.0, 'USD')")
    # cash + history
    db.execute(
        "INSERT INTO balance_snapshots VALUES ('2026-06-10', now(), 'acc_chk', 'CHASE', "
        "'Chase', 'depository', 'checking', 12000.0, 12000.0, NULL, 'USD')")
    # cash-like brokerage position
    db.execute(
        "INSERT INTO holdings_snapshots VALUES ('2026-06-10', now(), 'acc_rh', "
        "'ROBINHOOD', 'sec_bil', 'BIL', 'SPDR T-Bill', 'etf', 328.0, 91.46, "
        "30000.0, NULL, 'USD')")
    # income/expenses: two completed months
    _tx(db, "i1", "2026-04-15", -3000.0, "INCOME", "Acme", "ACME PAYROLL")
    _tx(db, "e1", "2026-04-20", 1900.0, "OTHER", "Ett*applejackllcrent")
    _tx(db, "i2", "2026-05-15", -3000.0, "INCOME", "Acme", "ACME PAYROLL")
    _tx(db, "e2", "2026-05-20", 1900.0, "OTHER", "Ett*applejackllcrent")

    out = insights.get_financial_health(as_of=AS_OF)
    assert out["net_worth"] == pytest.approx(12000.0 - 5856.91, abs=0.01)
    assert out["debt"]["total_debt"] == pytest.approx(5856.91)
    assert out["liquid_reserves"] == pytest.approx(42000.0)
    assert out["months_of_runway"] == pytest.approx(42000.0 / 1900.0, abs=0.1)
    assert out["income"]["savings_rate"] == pytest.approx(1 - 1900 / 3000, abs=0.01)

    flag_names = {f["flag"] for f in out["flags"]}
    assert "high_utilization" in flag_names
    assert "expensive_debt" in flag_names
    assert all({"flag", "severity", "detail"} <= set(f) for f in out["flags"])


def test_financial_health_on_empty_store(db):
    out = insights.get_financial_health(as_of=AS_OF)
    assert out["net_worth"] is None
    assert out["months_of_runway"] is None
    assert isinstance(out["flags"], list)
