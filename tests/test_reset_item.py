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
