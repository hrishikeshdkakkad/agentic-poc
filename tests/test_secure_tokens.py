"""Tests for the Fernet-encrypted token store (Postgres-backed).

Ciphertext lives in the plaid_tokens table; the Fernet key stays local
(keyfile or FERNET_KEY env var). The ``db`` fixture provides a truncated
test database.
"""
import json
import os
import stat

import pytest
from cryptography.fernet import Fernet

import secure_tokens
from plaid_client import load_tokens


@pytest.fixture
def secrets_dir(tmp_path, monkeypatch):
    d = str(tmp_path / "secrets")
    monkeypatch.setenv("PFM_SECRETS_DIR", d)
    monkeypatch.delenv("FERNET_KEY", raising=False)
    return d


def test_roundtrip_and_keyfile_permissions(db, secrets_dir):
    secure_tokens.set_token("CHASE", "access-sandbox-abc123")
    assert secure_tokens.load_encrypted_tokens() == {"CHASE": "access-sandbox-abc123"}

    key_path = os.path.join(secrets_dir, "fernet.key")
    assert stat.S_IMODE(os.stat(key_path).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(secrets_dir).st_mode) == 0o700


def test_tokens_not_plaintext_in_db(db, secrets_dir):
    secure_tokens.set_token("CHASE", "access-sandbox-supersecret")
    ciphertext = db.execute(
        "SELECT token_ciphertext FROM plaid_tokens WHERE env_key = 'CHASE'"
    ).fetchone()[0]
    assert "supersecret" not in ciphertext


def test_fernet_key_env_var_takes_precedence(db, secrets_dir, monkeypatch):
    key = Fernet.generate_key().decode()
    monkeypatch.setenv("FERNET_KEY", key)
    secure_tokens.set_token("CHASE", "tok-env-key")
    assert secure_tokens.load_encrypted_tokens() == {"CHASE": "tok-env-key"}
    # no keyfile should be created when FERNET_KEY is provided
    assert not os.path.exists(os.path.join(secrets_dir, "fernet.key"))
    # ciphertext decrypts with that exact key
    ct = db.execute("SELECT token_ciphertext FROM plaid_tokens").fetchone()[0]
    assert Fernet(key.encode()).decrypt(ct.encode()) == b"tok-env-key"


def test_set_token_normalizes_key_and_remove(db, secrets_dir):
    secure_tokens.set_token("PLAID_TOKEN_chase", "tok1")
    assert secure_tokens.load_encrypted_tokens() == {"CHASE": "tok1"}
    assert secure_tokens.remove_token("chase") is True
    assert secure_tokens.load_encrypted_tokens() == {}
    assert secure_tokens.remove_token("chase") is False


def test_import_from_env(db, secrets_dir, monkeypatch):
    monkeypatch.setenv("PLAID_TOKEN_AMEX", "access-sandbox-amex")
    imported = secure_tokens.import_from_env()
    assert "AMEX" in imported
    assert secure_tokens.load_encrypted_tokens()["AMEX"] == "access-sandbox-amex"


def test_legacy_file_store_migrates_into_db(db, secrets_dir):
    # Simulate the pre-Postgres layout: Fernet-encrypted JSON file.
    f = secure_tokens._get_fernet()
    legacy_path = os.path.join(secrets_dir, "tokens.enc")
    with open(legacy_path, "wb") as fh:
        fh.write(f.encrypt(json.dumps({"OLDBANK": "tok-legacy"}).encode()))
    tokens = secure_tokens.load_encrypted_tokens()
    assert tokens["OLDBANK"] == "tok-legacy"
    assert not os.path.exists(legacy_path)
    assert os.path.exists(legacy_path + ".migrated")


def test_load_tokens_merges_store_and_env(db, secrets_dir, monkeypatch):
    for k in list(os.environ):
        if k.startswith("PLAID_TOKEN_"):
            monkeypatch.delenv(k)
    secure_tokens.set_token("FIDELITY", "tok-from-store")
    secure_tokens.set_token("CHASE", "tok-store-version")
    monkeypatch.setenv("PLAID_TOKEN_CHASE", "tok-env-wins")
    tokens = load_tokens()
    assert tokens["FIDELITY"].reveal() == "tok-from-store"
    assert tokens["CHASE"].reveal() == "tok-env-wins"  # env overrides store
    # SecretStr never exposes the value in repr/str/format
    assert "tok-from-store" not in repr(tokens["FIDELITY"])
    assert "tok-from-store" not in f"{tokens['FIDELITY']}"


def test_undecryptable_row_raises_clear_error(db, secrets_dir):
    db.execute(
        "INSERT INTO plaid_tokens (env_key, token_ciphertext) VALUES ('BAD', 'garbage')"
    )
    with pytest.raises(RuntimeError, match="cannot be decrypted"):
        secure_tokens.load_encrypted_tokens()


def test_load_tokens_survives_broken_store(db, secrets_dir, monkeypatch):
    for k in list(os.environ):
        if k.startswith("PLAID_TOKEN_"):
            monkeypatch.delenv(k)
    db.execute(
        "INSERT INTO plaid_tokens (env_key, token_ciphertext) VALUES ('BAD', 'garbage')"
    )
    monkeypatch.setenv("PLAID_TOKEN_ENVBANK", "tok-env")
    tokens = load_tokens()  # falls back to env without raising
    assert list(tokens) == ["ENVBANK"]


def test_cli_list_shows_keys_only(db, secrets_dir, capsys):
    secure_tokens.set_token("CHASE", "super-secret-token")
    assert secure_tokens.main(["list"]) == 0
    out = capsys.readouterr().out
    assert "CHASE" in out
    assert "super-secret-token" not in out
    parsed = json.loads(out)
    assert parsed["keys"] == ["CHASE"]


def test_query_finances_cannot_read_plaid_tokens(db, secrets_dir):
    import analytics
    secure_tokens.set_token("CHASE", "tok")
    with pytest.raises(ValueError, match="not queryable"):
        analytics.query_finances("SELECT * FROM plaid_tokens")
    schema = analytics.describe_tables()
    assert "plaid_tokens" not in schema["tables"]
