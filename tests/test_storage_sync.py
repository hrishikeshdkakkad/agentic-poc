"""Tests for storage.py + sync.py: cursor flow, idempotency, snapshots.

The ``db`` fixture (conftest.py) provides a truncated Postgres test database.
"""
import pytest

import storage
import sync as sync_mod
from plaid_client import ItemHealth, SecretStr


class FakeResp:
    def __init__(self, d):
        self._d = d

    def to_dict(self):
        return self._d


def _tx(tid, dt, amount, category="FOOD_AND_DRINK", merchant="Starbucks",
        account_id="acc_chk", pending=False):
    return {
        "transaction_id": tid,
        "account_id": account_id,
        "date": dt,
        "authorized_date": dt,
        "amount": amount,
        "iso_currency_code": "USD",
        "merchant_name": merchant,
        "name": f"{merchant} purchase",
        "personal_finance_category": {"primary": category, "detailed": f"{category}_X"},
        "pending": pending,
    }


class FakeSyncApi:
    """Pages out a fixed transaction set via the /transactions/sync contract."""

    def __init__(self, pages):
        # pages: list of dicts with added/modified/removed
        self.pages = pages
        self.sync_calls = 0

    def transactions_sync(self, req):
        self.sync_calls += 1
        cursor = req.to_dict().get("cursor") or ""
        idx = int(cursor.split("-")[1]) if cursor.startswith("cur-") else 0
        if idx >= len(self.pages):
            return FakeResp({"added": [], "modified": [], "removed": [],
                             "next_cursor": cursor, "has_more": False})
        page = self.pages[idx]
        return FakeResp({
            "added": page.get("added", []),
            "modified": page.get("modified", []),
            "removed": page.get("removed", []),
            "next_cursor": f"cur-{idx + 1}",
            "has_more": idx + 1 < len(self.pages),
        })


def test_sync_pagination_and_cursor_persisted(db):
    api = FakeSyncApi([
        {"added": [_tx("t1", "2025-01-05", 12.50), _tx("t2", "2025-01-06", 8.00)]},
        {"added": [_tx("t3", "2025-02-10", 30.00, category="TRAVEL", merchant="Uber")]},
    ])
    out = sync_mod._sync_item_transactions(api, db, "CHASE", SecretStr("tok"))
    assert out == {"added": 3, "modified": 0, "removed": 0}
    assert db.execute("SELECT count(*) FROM transactions").fetchone()[0] == 3
    assert storage.get_cursor(db, "CHASE") == "cur-2"


def test_sync_idempotent_rerun_no_duplicates(db):
    pages = [{"added": [_tx("t1", "2025-01-05", 12.50), _tx("t2", "2025-01-06", 8.00)]}]
    api = FakeSyncApi(pages)
    sync_mod._sync_item_transactions(api, db, "CHASE", SecretStr("tok"))
    n1 = db.execute("SELECT count(*) FROM transactions").fetchone()[0]
    # Second run resumes from cur-1 -> empty delta
    sync_mod._sync_item_transactions(api, db, "CHASE", SecretStr("tok"))
    n2 = db.execute("SELECT count(*) FROM transactions").fetchone()[0]
    assert (n1, n2) == (2, 2)


def test_sync_modified_and_removed(db):
    api = FakeSyncApi([
        {"added": [_tx("t1", "2025-01-05", 12.50), _tx("t2", "2025-01-06", 8.00)]},
    ])
    sync_mod._sync_item_transactions(api, db, "CHASE", SecretStr("tok"))
    api2 = FakeSyncApi([
        {},  # cursor cur-0... need continuation; emulate next delta from cur-1
        {"modified": [_tx("t1", "2025-01-05", 99.99)],
         "removed": [{"transaction_id": "t2"}]},
    ])
    sync_mod._sync_item_transactions(api2, db, "CHASE", SecretStr("tok"))
    rows = db.execute(
        "SELECT transaction_id, amount FROM transactions ORDER BY transaction_id"
    ).fetchall()
    assert rows == [("t1", 99.99)]


def test_sync_mutation_during_pagination_restarts(db):
    from plaid.exceptions import ApiException

    class MutatingApi(FakeSyncApi):
        def __init__(self, pages):
            super().__init__(pages)
            self.raised = False

        def transactions_sync(self, req):
            if not self.raised and self.sync_calls == 1:
                self.raised = True
                exc = ApiException(status=400, reason="mutation")
                exc.body = '{"error_code":"TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"}'
                raise exc
            return super().transactions_sync(req)

    api = MutatingApi([
        {"added": [_tx("t1", "2025-01-05", 12.50)]},
        {"added": [_tx("t2", "2025-02-06", 8.00)]},
    ])
    out = sync_mod._sync_item_transactions(api, db, "CHASE", SecretStr("tok"))
    assert out["added"] == 2
    assert db.execute("SELECT count(*) FROM transactions").fetchone()[0] == 2


def test_snapshots_same_day_idempotent(db):
    accounts = [
        {"account_id": "acc_chk", "name": "Checking", "type": "depository",
         "subtype": "checking",
         "balances": {"current": 1000.0, "available": 950.0, "iso_currency_code": "USD"}},
        {"account_id": "acc_401k", "name": "401k", "type": "investment",
         "subtype": "401k",
         "balances": {"current": 50000.0, "available": None, "iso_currency_code": "USD"}},
    ]
    storage.record_balance_snapshots(db, "CHASE", "Chase", accounts)
    storage.record_balance_snapshots(db, "CHASE", "Chase", accounts)
    assert db.execute("SELECT count(*) FROM balance_snapshots").fetchone()[0] == 2

    holdings = [{"account_id": "acc_401k", "security_id": "sec1", "quantity": 10,
                 "institution_price": 100.0, "institution_value": 1000.0,
                 "cost_basis": 900.0, "iso_currency_code": "USD"}]
    secs = {"sec1": {"security_id": "sec1", "ticker_symbol": "VTI",
                     "name": "Vanguard Total", "type": "etf"}}
    storage.record_holdings_snapshots(db, "CHASE", holdings, secs)
    storage.record_holdings_snapshots(db, "CHASE", holdings, secs)
    assert db.execute("SELECT count(*) FROM holdings_snapshots").fetchone()[0] == 1
    row = db.execute("SELECT symbol, market_value FROM holdings_snapshots").fetchone()
    assert row == ("VTI", 1000.0)


def test_liabilities_snapshot_joins_outstanding_balance(db):
    liabs = {
        "credit": [{"account_id": "acc_cc", "aprs": [
            {"apr_type": "purchase_apr", "apr_percentage": 22.99}],
            "minimum_payment_amount": 25.0, "next_payment_due_date": "2025-03-01",
            "is_overdue": False}],
        "student": [{"account_id": "acc_loan", "interest_rate_percentage": 5.25,
                     "minimum_payment_amount": 150.0}],
        "mortgage": [],
    }
    balances = {"acc_cc": {"current": 410.0, "iso_currency_code": "USD"},
                "acc_loan": {"current": 12000.0, "iso_currency_code": "USD"}}
    n = storage.record_liabilities_snapshots(db, "CHASE", liabs, balances)
    assert n == 2
    rows = dict(db.execute(
        "SELECT liability_type, outstanding_balance FROM liabilities_snapshots"
    ).fetchall())
    assert rows == {"credit": 410.0, "student": 12000.0}


def test_run_sync_skips_unhealthy_items(db, monkeypatch):
    api = FakeSyncApi([{"added": [_tx("t1", "2025-01-05", 5.0)]}])
    api.accounts_balance_get = lambda req: FakeResp({"accounts": []})
    api.investments_holdings_get = lambda req: FakeResp({"holdings": [], "securities": []})
    api.liabilities_get = lambda req: FakeResp({"liabilities": {}, "accounts": []})
    items = [
        ("CHASE", SecretStr("t"), ItemHealth("CHASE", "healthy", "ins_3", "Chase")),
        ("AMEX", SecretStr("t2"), ItemHealth("AMEX", "re_auth_required", "ins_9", "Amex",
                                             reason="ITEM_LOGIN_REQUIRED")),
    ]
    monkeypatch.setattr(sync_mod, "all_items", lambda a: items)
    out = sync_mod.run_sync(api)
    assert len(out["items"]) == 1
    assert out["items"][0]["transactions"]["added"] == 1
    assert out["warnings"][0]["status"] == "re_auth_required"
