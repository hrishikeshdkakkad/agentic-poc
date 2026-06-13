import os
import pytest
from unittest.mock import MagicMock

# Postgres used by storage/analytics tests. Defaults to the local instance
# started for development; point TEST_DATABASE_URL elsewhere (e.g. a Neon
# branch database) to run against managed Postgres.
TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql://finance:finance@127.0.0.1:5433/finance"
)

_ALL_TABLES = ("accounts", "transactions", "balance_snapshots",
               "holdings_snapshots", "investment_transactions",
               "liabilities_snapshots", "sync_state",
               "plaid_tokens", "transaction_tags", "category_overrides")


def _pg_available() -> bool:
    try:
        import psycopg
        psycopg.connect(TEST_DATABASE_URL, connect_timeout=3).close()
        return True
    except Exception:
        return False


_PG_AVAILABLE = _pg_available()


@pytest.fixture(autouse=True)
def isolate_local_state(tmp_path, monkeypatch):
    """Keep tests away from the real token store and finance database."""
    monkeypatch.setenv("PFM_SECRETS_DIR", str(tmp_path / "pfm-secrets"))
    monkeypatch.setenv("DATABASE_URL", TEST_DATABASE_URL)
    # Pin the split token store to the SAME test database. CLI entrypoints call
    # load_dotenv(); pinning (not deleting) keeps that no-override load from
    # re-introducing a real PFM_TOKENS_DATABASE_URL from .env and writing test
    # tokens into the live plaid_tokens table.
    monkeypatch.setenv("PFM_TOKENS_DATABASE_URL", TEST_DATABASE_URL)


@pytest.fixture
def db(isolate_local_state):
    """Read-write connection to an empty test database."""
    if not _PG_AVAILABLE:
        pytest.skip(f"no test Postgres reachable at {TEST_DATABASE_URL}")
    import storage
    conn = storage.open_db()
    conn.execute(f"TRUNCATE {', '.join(_ALL_TABLES)}")
    yield conn
    conn.close()


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
