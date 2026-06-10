import os
import pytest
from unittest.mock import MagicMock

@pytest.fixture(autouse=True)
def isolate_local_state(tmp_path, monkeypatch):
    """Keep tests away from the real token store and DuckDB file."""
    monkeypatch.setenv("PFM_SECRETS_DIR", str(tmp_path / "pfm-secrets"))
    monkeypatch.setenv("FINANCE_DB_PATH", str(tmp_path / "finance-test.duckdb"))

@pytest.fixture
def fake_env_tokens(monkeypatch):
    monkeypatch.setenv("PLAID_TOKEN_CHASE", "access-prod-fake-chase")
    monkeypatch.setenv("PLAID_TOKEN_FIDELITY", "access-prod-fake-fidelity")
    monkeypatch.setenv("PLAID_CLIENT_ID", "client-id-fake")
    monkeypatch.setenv("PLAID_SECRET", "secret-fake")
    monkeypatch.setenv("PLAID_ENV", "sandbox")

@pytest.fixture
def mock_plaid_api():
    return MagicMock()
