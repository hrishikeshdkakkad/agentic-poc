"""Auto-mirror of newly linked tokens into the history DB (Neon).

When a bank is linked/re-linked, the token must also land in DATABASE_URL so the
scheduled Lambda (which reads plaid_tokens from Neon, not the local token store)
syncs the new Item automatically — no manual local->Neon copy.
"""
import os

import secure_tokens


def test_set_token_accepts_explicit_url(db):
    secure_tokens.set_token("CHASE", "access-x", url=os.environ["DATABASE_URL"])
    assert secure_tokens.load_encrypted_tokens()["CHASE"] == "access-x"


def test_set_token_everywhere_mirrors_to_history_db(monkeypatch):
    # Distinct local + history DBs -> the token is written to BOTH.
    monkeypatch.setenv("DATABASE_URL", "postgresql://neon/history")
    monkeypatch.setenv("PFM_TOKENS_DATABASE_URL", "postgresql://local/tokens")
    monkeypatch.delenv("PFM_DISABLE_TOKEN_MIRROR", raising=False)
    calls = []
    monkeypatch.setattr(secure_tokens, "set_token",
                        lambda key, tok, url=None: calls.append((key, url)))
    res = secure_tokens.set_token_everywhere("CHASE", "access-x")
    assert ("CHASE", "postgresql://local/tokens") in calls   # local store
    assert ("CHASE", "postgresql://neon/history") in calls    # mirrored to Neon
    assert res["local"] is True and res["history_db"] is True


def test_set_token_everywhere_single_store_writes_once(monkeypatch):
    # token store == history DB -> exactly one write, no redundant mirror.
    monkeypatch.setenv("DATABASE_URL", "postgresql://same/db")
    monkeypatch.delenv("PFM_TOKENS_DATABASE_URL", raising=False)
    monkeypatch.delenv("PFM_DISABLE_TOKEN_MIRROR", raising=False)
    calls = []
    monkeypatch.setattr(secure_tokens, "set_token",
                        lambda key, tok, url=None: calls.append(url))
    secure_tokens.set_token_everywhere("CHASE", "access-x")
    assert calls == ["postgresql://same/db"]


def test_mirror_failure_is_nonfatal(monkeypatch):
    # A Neon mirror failure must NOT lose the local token or raise.
    monkeypatch.setenv("DATABASE_URL", "postgresql://neon/history")
    monkeypatch.setenv("PFM_TOKENS_DATABASE_URL", "postgresql://local/tokens")
    monkeypatch.delenv("PFM_DISABLE_TOKEN_MIRROR", raising=False)
    written = []

    def fake_set(key, tok, url=None):
        if "neon" in url:
            raise RuntimeError("neon unreachable")
        written.append(url)

    monkeypatch.setattr(secure_tokens, "set_token", fake_set)
    res = secure_tokens.set_token_everywhere("CHASE", "access-x")
    assert written == ["postgresql://local/tokens"]   # local still written
    assert res["local"] is True
    assert "error" in str(res["history_db"])


def test_mirror_can_be_disabled(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://neon/history")
    monkeypatch.setenv("PFM_TOKENS_DATABASE_URL", "postgresql://local/tokens")
    monkeypatch.setenv("PFM_DISABLE_TOKEN_MIRROR", "1")
    calls = []
    monkeypatch.setattr(secure_tokens, "set_token",
                        lambda key, tok, url=None: calls.append(url))
    res = secure_tokens.set_token_everywhere("CHASE", "access-x")
    assert calls == ["postgresql://local/tokens"]      # local only
    assert res["history_db"] == "disabled"
