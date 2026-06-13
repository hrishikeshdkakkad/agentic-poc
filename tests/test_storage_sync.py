"""Tests for storage.py + sync.py: cursor flow, idempotency, snapshots.

The ``db`` fixture (conftest.py) provides a truncated Postgres test database.
"""
from datetime import date

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


# ---------------------------------------------------------------------------
# Investment transactions persistence (Plaid /investments/transactions/get).
# No cursor exists for this product, so idempotency rides entirely on
# investment_transaction_id (PK) + ON CONFLICT — re-pulling an overlapping
# window can never double-count.
# ---------------------------------------------------------------------------

def _inv_tx(itid, dt, type_="buy", subtype="buy", amount=2.0, quantity=0.01,
            price=200.0, fees=0.0, security_id="sec_a", symbol="AAPL",
            security_name="Apple Inc.", security_type="equity",
            account_id="acc_inv", name="BUY AAPL", currency="USD"):
    """A canonical (already-shaped) investment-transaction record."""
    return {
        "investment_transaction_id": itid, "account_id": account_id, "date": dt,
        "name": name, "type": type_, "subtype": subtype, "amount": amount,
        "quantity": quantity, "price": price, "fees": fees,
        "security_id": security_id, "symbol": symbol,
        "security_name": security_name, "security_type": security_type,
        "currency": currency,
    }


def test_record_investment_transactions_persists_and_is_idempotent(db):
    rows = [_inv_tx("it1", "2026-01-05"),
            _inv_tx("it2", "2026-01-06", type_="cash", subtype="dividend", amount=-1.0)]
    n1 = storage.record_investment_transactions(db, "ROBINHOOD", rows)
    assert n1 == 2
    assert db.execute("SELECT count(*) FROM investment_transactions").fetchone()[0] == 2
    # Re-running the same window upserts, never duplicates.
    storage.record_investment_transactions(db, "ROBINHOOD", rows)
    assert db.execute("SELECT count(*) FROM investment_transactions").fetchone()[0] == 2


def test_record_investment_transactions_upserts_mutated_fields(db):
    storage.record_investment_transactions(db, "ROBINHOOD", [_inv_tx("it1", "2026-01-05", amount=2.0)])
    storage.record_investment_transactions(db, "ROBINHOOD", [_inv_tx("it1", "2026-01-05", amount=9.99)])
    row = db.execute(
        "SELECT amount, symbol, item_key, type, security_name FROM investment_transactions "
        "WHERE investment_transaction_id = 'it1'"
    ).fetchone()
    assert row == (9.99, "AAPL", "ROBINHOOD", "buy", "Apple Inc.")


def test_record_investment_transactions_skips_rows_without_id(db):
    rows = [_inv_tx("it1", "2026-01-05"), {**_inv_tx("xx", "2026-01-06"), "investment_transaction_id": None}]
    n = storage.record_investment_transactions(db, "ROBINHOOD", rows)
    assert n == 1
    assert db.execute("SELECT count(*) FROM investment_transactions").fetchone()[0] == 1


def test_investment_sync_window_rolling_vs_backfill():
    today = date(2026, 6, 13)
    rs, re_ = sync_mod.investment_sync_window(False, today=today)
    assert (rs, re_) == ("2026-04-29", "2026-06-13")  # 45-day rolling window
    bs, be = sync_mod.investment_sync_window(True, today=today)
    assert (bs, be) == ("2024-06-13", "2026-06-13")   # ~24 months (Plaid max)


def _inv_api(rows, securities, total=None):
    """A fake Plaid api whose investments_transactions_get returns one page."""
    total = len(rows) if total is None else total

    class _Api:
        def __init__(self):
            self.calls = 0

        def investments_transactions_get(self, req):
            self.calls += 1
            return FakeResp({"investment_transactions": rows,
                             "securities": securities,
                             "total_investment_transactions": total})

    return _Api()


def test_sync_item_investments_persists_rows(db):
    sec = [{"security_id": "sec_a", "ticker_symbol": "NVDA", "name": "NVIDIA", "type": "equity"}]
    api = _inv_api(
        [{"investment_transaction_id": "iv1", "account_id": "acc_b", "security_id": "sec_a",
          "date": "2026-05-01", "type": "buy", "amount": 50.0, "iso_currency_code": "USD"}],
        sec,
    )
    n = sync_mod._sync_item_investments(api, db, "ROBINHOOD", SecretStr("tok"),
                                        ("2026-04-01", "2026-05-31"))
    assert n == 1
    assert db.execute(
        "SELECT symbol, amount, item_key FROM investment_transactions"
    ).fetchone() == ("NVDA", 50.0, "ROBINHOOD")


def _stub_snapshot_calls(api, with_investment_account=False):
    accts = ([{"account_id": "acc_b", "type": "investment", "subtype": "brokerage",
               "balances": {"current": 100.0, "iso_currency_code": "USD"}}]
             if with_investment_account else [])
    api.accounts_balance_get = lambda req: FakeResp({"accounts": accts})
    api.investments_holdings_get = lambda req: FakeResp({"holdings": [], "securities": []})
    api.liabilities_get = lambda req: FakeResp({"liabilities": {}, "accounts": []})


def test_run_sync_persists_investment_transactions(db, monkeypatch):
    api = FakeSyncApi([{"added": [_tx("t1", "2025-01-05", 5.0)]}])
    _stub_snapshot_calls(api, with_investment_account=True)
    sec = [{"security_id": "s1", "ticker_symbol": "VTI", "name": "Vanguard", "type": "etf"}]
    api.investments_transactions_get = lambda req: FakeResp({
        "investment_transactions": [
            {"investment_transaction_id": "iv1", "account_id": "acc_b", "security_id": "s1",
             "date": "2026-05-01", "type": "buy", "amount": 12.0, "iso_currency_code": "USD"}],
        "securities": sec, "total_investment_transactions": 1})
    items = [("ROBINHOOD", SecretStr("t"), ItemHealth("ROBINHOOD", "healthy", "ins_54", "Robinhood"))]
    monkeypatch.setattr(sync_mod, "all_items", lambda a: items)
    out = sync_mod.run_sync(api)
    assert out["items"][0]["investment_transactions"] == 1
    assert db.execute("SELECT count(*) FROM investment_transactions").fetchone()[0] == 1


def test_run_sync_warns_when_investments_unauthorized(db, monkeypatch):
    """Fidelity-style: investments transactions not granted -> warning, not crash."""
    from plaid.exceptions import ApiException

    api = FakeSyncApi([{"added": [_tx("t1", "2025-01-05", 5.0)]}])
    _stub_snapshot_calls(api, with_investment_account=True)

    def boom(req):
        exc = ApiException(status=400, reason="consent")
        exc.body = '{"error_code":"ADDITIONAL_CONSENT_REQUIRED","error_message":"x"}'
        raise exc

    api.investments_transactions_get = boom
    items = [("FIDELITY", SecretStr("t"), ItemHealth("FIDELITY", "healthy", "ins_12", "Fidelity"))]
    monkeypatch.setattr(sync_mod, "all_items", lambda a: items)
    out = sync_mod.run_sync(api)
    assert out["items"][0]["transactions"]["added"] == 1  # rest of the sync still ran
    assert out["items"][0]["investment_transactions"] is None
    warning = next(w for w in out["warnings"] if w.get("scope") == "investment_transactions")
    assert warning["code"] == "ADDITIONAL_CONSENT_REQUIRED"
    assert warning["institution"] == "Fidelity"


def test_run_sync_skips_investments_for_non_investment_items(db, monkeypatch):
    """Depository/credit-only items have no investments product — don't call it."""
    api = FakeSyncApi([{"added": [_tx("t1", "2025-01-05", 5.0)]}])
    _stub_snapshot_calls(api, with_investment_account=False)
    called = {"n": 0}

    def _should_not_be_called(req):
        called["n"] += 1
        return FakeResp({"investment_transactions": [], "securities": [], "total_investment_transactions": 0})

    api.investments_transactions_get = _should_not_be_called
    items = [("CHASE", SecretStr("t"), ItemHealth("CHASE", "healthy", "ins_56", "Chase"))]
    monkeypatch.setattr(sync_mod, "all_items", lambda a: items)
    out = sync_mod.run_sync(api)
    assert called["n"] == 0
    assert "investment_transactions" not in out["items"][0]
