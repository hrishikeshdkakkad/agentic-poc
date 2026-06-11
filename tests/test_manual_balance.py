"""Manual balance snapshots for accounts with no Plaid Item (CSV imports).

CSV exports carry no balance, so manually-imported accounts are invisible to
every balance-derived tool. record_manual_balance lets the user state the
real balance (from the issuer's app); it writes the same snapshot tables the
Plaid sync writes, so debt/net-worth tools pick the account up with zero
special-casing.
"""
from datetime import date

import pytest

import storage
import wealth

ACCOUNT = "applecard_manual"


def _mk_manual_account(conn):
    conn.execute(
        "INSERT INTO accounts (account_id, item_key, institution, name, type,"
        " subtype, currency, updated_at) VALUES"
        " (%s, 'APPLECARD', 'Apple Card', 'Apple Card', 'credit',"
        " 'credit card', 'USD', now())",
        (ACCOUNT,),
    )


def _mk_synced_account(conn):
    conn.execute(
        "INSERT INTO accounts (account_id, item_key, institution, name, type,"
        " subtype, currency, updated_at) VALUES"
        " ('chase_1', 'CHASE', 'Chase', 'CREDIT CARD', 'credit',"
        " 'credit card', 'USD', now())"
    )
    conn.execute(
        "INSERT INTO sync_state (item_key, cursor, last_synced_at)"
        " VALUES ('CHASE', 'cur', now())"
    )


def test_writes_balance_and_liability_snapshots(db):
    _mk_manual_account(db)
    out = storage.record_manual_balance(
        db, ACCOUNT, current=822.15, apr_percentage=27.49, minimum_payment=25.0
    )
    assert out["ok"] is True
    bal = db.execute(
        "SELECT current, item_key, institution, type FROM balance_snapshots"
        " WHERE account_id = %s", (ACCOUNT,)
    ).fetchone()
    assert bal == (822.15, "APPLECARD", "Apple Card", "credit")
    liab = db.execute(
        "SELECT liability_type, outstanding_balance, apr_percentage,"
        " minimum_payment_amount FROM liabilities_snapshots"
        " WHERE account_id = %s", (ACCOUNT,)
    ).fetchone()
    assert liab == ("credit", 822.15, 27.49, 25.0)


def test_depository_account_writes_no_liability_row(db):
    db.execute(
        "INSERT INTO accounts (account_id, item_key, institution, name, type,"
        " subtype, currency, updated_at) VALUES"
        " ('manual_checking', 'MANUALBANK', 'Manual Bank', 'Checking',"
        " 'depository', 'checking', 'USD', now())"
    )
    out = storage.record_manual_balance(db, "manual_checking", current=100.0)
    assert out["ok"] is True
    assert db.execute(
        "SELECT count(*) FROM liabilities_snapshots WHERE account_id = 'manual_checking'"
    ).fetchone()[0] == 0


def test_rejects_unknown_account(db):
    with pytest.raises(ValueError, match="unknown account"):
        storage.record_manual_balance(db, "nope", current=1.0)


def test_rejects_plaid_synced_account(db):
    _mk_synced_account(db)
    with pytest.raises(ValueError, match="Plaid-synced"):
        storage.record_manual_balance(db, "chase_1", current=1.0)


def test_same_day_rerun_overwrites_not_duplicates(db):
    _mk_manual_account(db)
    storage.record_manual_balance(db, ACCOUNT, current=800.0, apr_percentage=27.49)
    storage.record_manual_balance(db, ACCOUNT, current=822.15, apr_percentage=27.49)
    rows = db.execute(
        "SELECT current FROM balance_snapshots WHERE account_id = %s", (ACCOUNT,)
    ).fetchall()
    assert rows == [(822.15,)]


def test_flows_into_debt_analysis(db):
    _mk_manual_account(db)
    storage.record_manual_balance(
        db, ACCOUNT, current=822.15, apr_percentage=27.49, minimum_payment=25.0
    )
    out = wealth.get_debt_analysis()
    assert [d["institution"] for d in out["debts"]] == ["Apple Card"]
    d = out["debts"][0]
    assert d["balance"] == 822.15
    assert d["apr_percentage"] == 27.49
    assert d["payoff_scenarios"]  # APR known → scenarios computed


def test_history_for_distinct_days_accumulates(db):
    _mk_manual_account(db)
    storage.record_manual_balance(db, ACCOUNT, current=900.0,
                                  snapshot_date=date(2026, 6, 1))
    storage.record_manual_balance(db, ACCOUNT, current=822.15,
                                  snapshot_date=date(2026, 6, 11))
    rows = db.execute(
        "SELECT snapshot_date, current FROM balance_snapshots"
        " WHERE account_id = %s ORDER BY snapshot_date", (ACCOUNT,)
    ).fetchall()
    assert [float(r[1]) for r in rows] == [900.0, 822.15]
