import json
import os

import pytest

import reset_item


def _seed_item(conn, key):
    """Insert one row per item_key table plus a tag, for item_key=key."""
    conn.execute(
        "INSERT INTO accounts (account_id, item_key, institution, name, type, subtype, currency, updated_at)"
        " VALUES (%s,%s,%s,'Acct','depository','checking','USD', now())",
        (f"{key}_acct", key, key.title()),
    )
    conn.execute(
        "INSERT INTO transactions (transaction_id, account_id, item_key, date, amount, currency, name)"
        " VALUES (%s,%s,%s,'2026-01-01', 9.99,'USD','Coffee')",
        (f"{key}_tx", f"{key}_acct", key),
    )
    conn.execute(
        "INSERT INTO transaction_tags (transaction_id, tag, source) VALUES (%s,'coffee','rule')",
        (f"{key}_tx",),
    )
    conn.execute(
        "INSERT INTO balance_snapshots (snapshot_date, account_id, item_key, institution, type, subtype, current)"
        " VALUES ('2026-01-01', %s,%s,'X','depository','checking', 100.0)",
        (f"{key}_acct", key),
    )
    conn.execute(
        "INSERT INTO holdings_snapshots (snapshot_date, account_id, item_key, security_id, quantity)"
        " VALUES ('2026-01-01', %s,%s,'sec1', 1.0)",
        (f"{key}_acct", key),
    )
    conn.execute(
        "INSERT INTO liabilities_snapshots (snapshot_date, account_id, item_key, liability_type, outstanding_balance)"
        " VALUES ('2026-01-01', %s,%s,'credit', 50.0)",
        (f"{key}_acct", key),
    )
    conn.execute(
        "INSERT INTO investment_transactions (investment_transaction_id, account_id, item_key, date, name, type, amount)"
        " VALUES (%s,%s,%s,'2026-01-01','Buy','buy', 10.0)",
        (f"{key}_inv", f"{key}_acct", key),
    )
    conn.execute(
        "INSERT INTO sync_state (item_key, cursor) VALUES (%s,'cur123')",
        (key,),
    )


def test_preview_counts_rows_for_item(db):
    _seed_item(db, "CHASE")
    _seed_item(db, "SOFI")
    counts = reset_item.preview_reset("CHASE")
    assert counts["transactions"] == 1
    assert counts["transaction_tags"] == 1
    assert counts["balance_snapshots"] == 1
    assert counts["holdings_snapshots"] == 1
    assert counts["liabilities_snapshots"] == 1
    assert counts["investment_transactions"] == 1
    assert counts["accounts"] == 1
    assert counts["sync_state"] == 1


def test_preview_normalizes_prefixed_key(db):
    _seed_item(db, "CHASE")
    assert reset_item.preview_reset("PLAID_TOKEN_chase")["transactions"] == 1


import secure_tokens


def test_remove_token_targets_explicit_url(db):
    # Both DATABASE_URL and PFM_TOKENS_DATABASE_URL point at the test DB here.
    db.execute(
        "INSERT INTO plaid_tokens (env_key, token_ciphertext) VALUES ('CHASE','ct')"
    )
    removed = secure_tokens.remove_token("CHASE", url=os.environ["DATABASE_URL"])
    assert removed is True
    left = db.execute(
        "SELECT count(*) FROM plaid_tokens WHERE env_key='CHASE'"
    ).fetchone()[0]
    assert left == 0


from datetime import datetime


def test_backup_writes_all_item_rows(db, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)  # so resets/ is created under tmp
    _seed_item(db, "CHASE")
    path = reset_item._backup("CHASE", os.environ["DATABASE_URL"],
                              datetime(2026, 6, 14, 10, 45, 0))
    assert path == os.path.join("resets", "CHASE-2026-06-14-104500.json")
    data = json.loads(open(path).read())
    assert data["env_key"] == "CHASE"
    assert len(data["tables"]["transactions"]) == 1
    assert len(data["tables"]["transaction_tags"]) == 1
    assert data["tables"]["transactions"][0]["name"] == "Coffee"
    # The token is a secret and must never be written to a backup.
    assert "plaid_tokens" not in data["tables"]
    assert "token" not in json.dumps(data).lower()


from unittest.mock import MagicMock

from plaid.exceptions import ApiException


def _api_raising(error_code):
    api = MagicMock()
    exc = ApiException(status=400)
    exc.body = json.dumps({"error_code": error_code})
    api.item_remove.side_effect = exc
    return api


def _store_token(conn, key, url_env="DATABASE_URL"):
    conn.execute(
        "INSERT INTO plaid_tokens (env_key, token_ciphertext) VALUES (%s,%s)"
        " ON CONFLICT (env_key) DO NOTHING",
        (key, "ct-unused-because-api-mocked"),
    )


def test_reset_wipes_target_and_preserves_others(db, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _seed_item(db, "CHASE")
    _seed_item(db, "SOFI")
    _store_token(db, "CHASE")
    from plaid_client import SecretStr
    monkeypatch.setattr(reset_item.plaid_client, "load_tokens",
                        lambda: {"CHASE": SecretStr("access-prod-x")})
    api = MagicMock()  # item_remove succeeds

    result = reset_item.reset_item("CHASE", confirm=True, api=api)

    assert result.plaid_removed == "removed"
    api.item_remove.assert_called_once()
    for table in ("transactions", "accounts", "balance_snapshots",
                  "holdings_snapshots", "liabilities_snapshots",
                  "investment_transactions", "sync_state"):
        assert db.execute(f"SELECT count(*) FROM {table} WHERE item_key='CHASE'").fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM transaction_tags WHERE transaction_id='CHASE_tx'").fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM plaid_tokens WHERE env_key='CHASE'").fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM transactions WHERE item_key='SOFI'").fetchone()[0] == 1
    assert db.execute("SELECT count(*) FROM accounts WHERE item_key='SOFI'").fetchone()[0] == 1
    assert os.path.exists(result.backup_path)


def test_reset_dry_run_changes_nothing(db, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _seed_item(db, "CHASE")
    from plaid_client import SecretStr
    monkeypatch.setattr(reset_item.plaid_client, "load_tokens",
                        lambda: {"CHASE": SecretStr("access-prod-x")})
    result = reset_item.reset_item("CHASE", confirm=False, api=MagicMock())
    assert result.dry_run is True
    assert result.deleted["transactions"] == 1
    assert db.execute("SELECT count(*) FROM transactions WHERE item_key='CHASE'").fetchone()[0] == 1


def test_reset_aborts_when_plaid_remove_fails(db, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _seed_item(db, "CHASE")
    _store_token(db, "CHASE")
    from plaid_client import SecretStr
    monkeypatch.setattr(reset_item.plaid_client, "load_tokens",
                        lambda: {"CHASE": SecretStr("access-prod-x")})
    api = _api_raising("INTERNAL_SERVER_ERROR")
    with pytest.raises(ApiException):
        reset_item.reset_item("CHASE", confirm=True, api=api)
    assert db.execute("SELECT count(*) FROM transactions WHERE item_key='CHASE'").fetchone()[0] == 1
    assert db.execute("SELECT count(*) FROM plaid_tokens WHERE env_key='CHASE'").fetchone()[0] == 1


def test_reset_treats_item_not_found_as_done(db, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _seed_item(db, "CHASE")
    _store_token(db, "CHASE")
    from plaid_client import SecretStr
    monkeypatch.setattr(reset_item.plaid_client, "load_tokens",
                        lambda: {"CHASE": SecretStr("access-prod-x")})
    api = _api_raising("ITEM_NOT_FOUND")
    result = reset_item.reset_item("CHASE", confirm=True, api=api)
    assert result.plaid_removed == "already_absent"
    assert db.execute("SELECT count(*) FROM transactions WHERE item_key='CHASE'").fetchone()[0] == 0


def test_reset_refuses_env_var_token(db, monkeypatch):
    monkeypatch.setenv("PLAID_TOKEN_CHASE", "access-prod-x")
    with pytest.raises(RuntimeError, match="env-var-backed"):
        reset_item.reset_item("CHASE", confirm=True, api=MagicMock())


def test_reset_errors_on_unknown_connection(db, monkeypatch):
    monkeypatch.setattr(reset_item.plaid_client, "load_tokens", lambda: {})
    with pytest.raises(RuntimeError, match="no token"):
        reset_item.reset_item("NOPE", confirm=True, api=MagicMock())


def test_reset_all_resets_every_connection(db, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _seed_item(db, "CHASE")
    _seed_item(db, "SOFI")
    _store_token(db, "CHASE")
    _store_token(db, "SOFI")
    from plaid_client import SecretStr
    monkeypatch.setattr(reset_item.plaid_client, "load_tokens",
                        lambda: {"CHASE": SecretStr("a"), "SOFI": SecretStr("b")})
    results = reset_item.reset_all(confirm=True, api=MagicMock())
    assert {r.env_key for r in results} == {"CHASE", "SOFI"}
    assert db.execute("SELECT count(*) FROM transactions").fetchone()[0] == 0


def test_restore_reinserts_data_rows(db, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _seed_item(db, "CHASE")
    path = reset_item._backup("CHASE", os.environ["DATABASE_URL"],
                              datetime(2026, 6, 14, 10, 45, 0))
    db.execute("DELETE FROM transaction_tags WHERE transaction_id='CHASE_tx'")
    for table in ("transactions", "accounts", "balance_snapshots",
                  "holdings_snapshots", "liabilities_snapshots",
                  "investment_transactions", "sync_state"):
        db.execute(f"DELETE FROM {table} WHERE item_key='CHASE'")
    counts = reset_item.restore_from_backup(path)
    assert counts["transactions"] == 1
    assert db.execute("SELECT count(*) FROM transactions WHERE item_key='CHASE'").fetchone()[0] == 1
    assert db.execute("SELECT count(*) FROM transaction_tags WHERE transaction_id='CHASE_tx'").fetchone()[0] == 1


def test_cli_preview_prints_counts_without_confirm(db, capsys, monkeypatch):
    _seed_item(db, "CHASE")
    from plaid_client import SecretStr
    monkeypatch.setattr(reset_item.plaid_client, "load_tokens",
                        lambda: {"CHASE": SecretStr("a")})
    rc = reset_item.main(["CHASE"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "DRY RUN" in out
    assert "transactions" in out
    assert db.execute("SELECT count(*) FROM transactions WHERE item_key='CHASE'").fetchone()[0] == 1


def test_reset_clears_token_from_both_stores(db, tmp_path, monkeypatch):
    # Production splits the token store (PFM_TOKENS_DATABASE_URL) from the
    # history store (DATABASE_URL/Neon). A reset must clear the token from BOTH,
    # or the Lambda keeps syncing a removed Item from the surviving Neon copy.
    monkeypatch.chdir(tmp_path)
    _seed_item(db, "CHASE")
    from plaid_client import SecretStr
    monkeypatch.setattr(reset_item.plaid_client, "load_tokens",
                        lambda: {"CHASE": SecretStr("a")})
    cleared_urls = []
    monkeypatch.setattr(reset_item.secure_tokens, "remove_token",
                        lambda key, url=None: cleared_urls.append(url) or True)
    db_url = os.environ["DATABASE_URL"]
    tokens_url = "postgresql://separate-local-token-store/db"
    reset_item.reset_item("CHASE", confirm=True, api=MagicMock(),
                          db_url=db_url, tokens_url=tokens_url)
    # Both distinct stores cleared, deduped, order preserved (tokens store first).
    assert cleared_urls == [tokens_url, db_url]
