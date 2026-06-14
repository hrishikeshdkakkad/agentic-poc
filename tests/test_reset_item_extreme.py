"""Extreme correctness/robustness tests for the Item reset helper.

These go beyond the per-task unit tests: atomicity under failure injection,
backup/restore byte-fidelity (unicode, NULLs, decimals, timestamps), idempotency,
and scale isolation. All run against the test Postgres (:5433) — never production.
"""
import json
import os
from datetime import datetime
from unittest.mock import MagicMock

import pytest

import reset_item


def _rich_seed(conn, key, *, name="Coffee", n_tx=1):
    """Seed an item with realistic, edge-casey data."""
    conn.execute(
        "INSERT INTO accounts (account_id, item_key, institution, name, type, subtype, currency, updated_at)"
        " VALUES (%s,%s,%s,'Acct','depository','checking','USD', now())",
        (f"{key}_acct", key, key.title()),
    )
    for i in range(n_tx):
        # merchant + authorized_date deliberately NULL; unicode/quote in name; decimal amount
        conn.execute(
            "INSERT INTO transactions (transaction_id, account_id, item_key, date,"
            " authorized_date, amount, currency, merchant, name, pending)"
            " VALUES (%s,%s,%s,%s, NULL, %s,'USD', NULL, %s, %s)",
            (f"{key}_tx{i}", f"{key}_acct", key, "2026-01-0%d" % ((i % 9) + 1),
             round(1.01 * (i + 1), 2), name, (i % 2 == 0)),
        )
    conn.execute(
        "INSERT INTO transaction_tags (transaction_id, tag, source) VALUES (%s,'coffee','rule')",
        (f"{key}_tx0",),
    )
    conn.execute(
        "INSERT INTO balance_snapshots (snapshot_date, account_id, item_key, institution, type, subtype, current)"
        " VALUES ('2026-01-01', %s,%s,'X','depository','checking', 1234.56)",
        (f"{key}_acct", key),
    )
    conn.execute(
        "INSERT INTO investment_transactions (investment_transaction_id, account_id, item_key, date, name, type, amount, quantity, price)"
        " VALUES (%s,%s,%s,'2026-01-01','Buy','buy', 10.5, 2.0, 5.25)",
        (f"{key}_inv", f"{key}_acct", key),
    )
    conn.execute("INSERT INTO sync_state (item_key, cursor) VALUES (%s,'cur123')", (key,))


def _dump(conn, key):
    """Full ordered snapshot of every item row, for deep equality."""
    out = {}
    out["transaction_tags"] = conn.execute(
        "SELECT t.* FROM transaction_tags t JOIN transactions x"
        " ON t.transaction_id=x.transaction_id WHERE x.item_key=%s ORDER BY t.transaction_id, t.tag",
        (key,)).fetchall()
    for t in reset_item._ITEM_TABLES:
        out[t] = conn.execute(
            f"SELECT * FROM {t} WHERE item_key=%s ORDER BY 1,2", (key,)).fetchall()
    return out


def _patch_token(monkeypatch, key):
    from plaid_client import SecretStr
    monkeypatch.setattr(reset_item.plaid_client, "load_tokens",
                        lambda: {key: SecretStr("access-prod-x")})


# ---------------------------------------------------------------------------
# 1. Backup → wipe → restore is byte-for-byte faithful (unicode, NULLs, decimals)
# ---------------------------------------------------------------------------
def test_restore_is_byte_faithful_with_edge_data(db, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _rich_seed(db, "CHASE", name="Café ☕ O'Brien — naïve ¥€$", n_tx=5)
    before = _dump(db, "CHASE")

    path = reset_item._backup("CHASE", os.environ["DATABASE_URL"], datetime(2026, 6, 14, 10, 0, 0))
    reset_item._wipe("CHASE", os.environ["DATABASE_URL"])
    assert db.execute("SELECT count(*) FROM transactions WHERE item_key='CHASE'").fetchone()[0] == 0
    counts = reset_item.restore_from_backup(path)

    after = _dump(db, "CHASE")
    assert before == after, "restored rows differ from original"
    assert counts["transactions"] == 5
    # NULLs preserved (merchant/authorized_date were NULL)
    row = db.execute("SELECT merchant, authorized_date FROM transactions WHERE transaction_id='CHASE_tx1'").fetchone()
    assert row == (None, None)


# ---------------------------------------------------------------------------
# 2. The wipe is atomic: a failure mid-transaction rolls back ALL deletes
# ---------------------------------------------------------------------------
def test_wipe_is_atomic_under_midway_failure(db, monkeypatch):
    _rich_seed(db, "CHASE", n_tx=3)
    real_tables = reset_item._ITEM_TABLES  # capture BEFORE patching

    def real_total():
        # Count via the REAL table list, independent of the patched global.
        n = db.execute("SELECT count(*) FROM transaction_tags t JOIN transactions x"
                       " ON t.transaction_id=x.transaction_id WHERE x.item_key='CHASE'").fetchone()[0]
        for t in real_tables:
            n += db.execute(f"SELECT count(*) FROM {t} WHERE item_key='CHASE'").fetchone()[0]
        return n

    total_before = real_total()
    assert total_before > 0

    # Inject a non-existent table at the END of the wipe order → last DELETE raises
    # AFTER several real DELETEs have run inside the same transaction.
    monkeypatch.setattr(reset_item, "_ITEM_TABLES",
                        real_tables + ("table_that_does_not_exist",))
    with pytest.raises(Exception):
        reset_item._wipe("CHASE", os.environ["DATABASE_URL"])
    monkeypatch.undo()  # restore real _ITEM_TABLES for verification

    # Every real DELETE that ran before the failure must have rolled back.
    assert real_total() == total_before, "wipe was not atomic — partial deletion survived"


# ---------------------------------------------------------------------------
# 3. Idempotency: re-running reset / restore is safe
# ---------------------------------------------------------------------------
def test_double_reset_is_safe(db, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _rich_seed(db, "CHASE")
    db.execute("INSERT INTO plaid_tokens (env_key, token_ciphertext) VALUES ('CHASE','ct')")
    _patch_token(monkeypatch, "CHASE")

    reset_item.reset_item("CHASE", confirm=True, api=MagicMock())
    # Token + data gone; load_tokens still patched to return CHASE, but the row is gone.
    # Second run: the in-DB token is cleared, but the patched load_tokens still yields it,
    # so reset proceeds and finds zero rows to wipe — must not error or create dupes.
    result2 = reset_item.reset_item("CHASE", confirm=True, api=MagicMock())
    assert all(v == 0 for v in result2.deleted.values())


def test_double_restore_no_duplicates(db, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _rich_seed(db, "CHASE", n_tx=4)
    path = reset_item._backup("CHASE", os.environ["DATABASE_URL"], datetime(2026, 6, 14, 9, 0, 0))
    reset_item._wipe("CHASE", os.environ["DATABASE_URL"])

    first = reset_item.restore_from_backup(path)
    second = reset_item.restore_from_backup(path)  # ON CONFLICT DO NOTHING
    assert first["transactions"] == 4
    assert second["transactions"] == 0
    assert db.execute("SELECT count(*) FROM transactions WHERE item_key='CHASE'").fetchone()[0] == 4


# ---------------------------------------------------------------------------
# 4. Scale isolation: reset one item out of many, every other byte-identical
# ---------------------------------------------------------------------------
def test_scale_isolation_30_items(db, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    keys = [f"BANK{i:02d}" for i in range(30)]
    for k in keys:
        _rich_seed(db, k, n_tx=4)
    target = "BANK15"
    db.execute("INSERT INTO plaid_tokens (env_key, token_ciphertext) VALUES (%s,'ct')", (target,))
    _patch_token(monkeypatch, target)

    others_before = {k: _dump(db, k) for k in keys if k != target}
    reset_item.reset_item(target, confirm=True, api=MagicMock())

    assert sum(len(v) for v in _dump(db, target).values()) == 0
    for k in keys:
        if k == target:
            continue
        assert _dump(db, k) == others_before[k], f"{k} was disturbed by resetting {target}"


# ---------------------------------------------------------------------------
# 5. The exact access token is handed to Plaid /item/remove (no leak/mangle)
# ---------------------------------------------------------------------------
def test_item_remove_receives_revealed_token(db, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _rich_seed(db, "CHASE")
    db.execute("INSERT INTO plaid_tokens (env_key, token_ciphertext) VALUES ('CHASE','ct')")
    from plaid_client import SecretStr
    monkeypatch.setattr(reset_item.plaid_client, "load_tokens",
                        lambda: {"CHASE": SecretStr("access-prod-SECRET123")})
    api = MagicMock()
    reset_item.reset_item("CHASE", confirm=True, api=api)
    sent = api.item_remove.call_args[0][0]  # the ItemRemoveRequest
    assert sent.access_token == "access-prod-SECRET123"
