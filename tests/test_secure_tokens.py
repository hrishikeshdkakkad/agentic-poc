"""Tests for the Fernet-encrypted token store."""
import json
import os
import stat

import pytest

import secure_tokens
from plaid_client import load_tokens


@pytest.fixture
def secrets_dir(tmp_path, monkeypatch):
    d = str(tmp_path / "secrets")
    monkeypatch.setenv("PFM_SECRETS_DIR", d)
    return d


def test_roundtrip_and_file_permissions(secrets_dir):
    secure_tokens.set_token("CHASE", "access-sandbox-abc123")
    assert secure_tokens.load_encrypted_tokens() == {"CHASE": "access-sandbox-abc123"}

    key_path = os.path.join(secrets_dir, "fernet.key")
    tok_path = os.path.join(secrets_dir, "tokens.enc")
    assert stat.S_IMODE(os.stat(key_path).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(tok_path).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(secrets_dir).st_mode) == 0o700


def test_tokens_not_plaintext_on_disk(secrets_dir):
    secure_tokens.set_token("CHASE", "access-sandbox-supersecret")
    with open(os.path.join(secrets_dir, "tokens.enc"), "rb") as f:
        blob = f.read()
    assert b"supersecret" not in blob
    assert b"CHASE" not in blob


def test_set_token_normalizes_key_and_remove(secrets_dir):
    secure_tokens.set_token("PLAID_TOKEN_chase", "tok1")
    assert secure_tokens.load_encrypted_tokens() == {"CHASE": "tok1"}
    assert secure_tokens.remove_token("chase") is True
    assert secure_tokens.load_encrypted_tokens() == {}
    assert secure_tokens.remove_token("chase") is False


def test_import_from_env(secrets_dir, monkeypatch):
    monkeypatch.setenv("PLAID_TOKEN_AMEX", "access-sandbox-amex")
    imported = secure_tokens.import_from_env()
    assert "AMEX" in imported
    assert secure_tokens.load_encrypted_tokens()["AMEX"] == "access-sandbox-amex"


def test_load_tokens_merges_store_and_env(secrets_dir, monkeypatch):
    # Clear any ambient PLAID_TOKEN_* vars
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


def test_corrupt_store_raises_clear_error(secrets_dir):
    secure_tokens.set_token("CHASE", "tok")
    with open(os.path.join(secrets_dir, "tokens.enc"), "wb") as f:
        f.write(b"garbage-not-fernet")
    with pytest.raises(RuntimeError, match="cannot be decrypted"):
        secure_tokens.load_encrypted_tokens()


def test_load_tokens_survives_corrupt_store(secrets_dir, monkeypatch):
    for k in list(os.environ):
        if k.startswith("PLAID_TOKEN_"):
            monkeypatch.delenv(k)
    secure_tokens.set_token("CHASE", "tok")
    with open(os.path.join(secrets_dir, "tokens.enc"), "wb") as f:
        f.write(b"garbage")
    monkeypatch.setenv("PLAID_TOKEN_ENVBANK", "tok-env")
    tokens = load_tokens()  # falls back to env without raising
    assert list(tokens) == ["ENVBANK"]


def test_cli_list_shows_keys_only(secrets_dir, capsys):
    secure_tokens.set_token("CHASE", "super-secret-token")
    assert secure_tokens.main(["list"]) == 0
    out = capsys.readouterr().out
    assert "CHASE" in out
    assert "super-secret-token" not in out
    parsed = json.loads(out)
    assert parsed["keys"] == ["CHASE"]
