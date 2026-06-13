"""Unit tests for sync.lambda_handler (the scheduled-sync Lambda entrypoint)."""
import pytest

import sync


def test_handler_loads_config_then_summarizes(monkeypatch):
    calls = []
    monkeypatch.setattr(sync.config_secrets, "load_into_env", lambda: calls.append("load"))
    monkeypatch.setattr(sync, "run_sync", lambda investments_backfill=False: {
        "items": [{"item_key": "CHASE"}, {"item_key": "AMEX"}],
        "warnings": [{"institution": "Old Bank", "status": "re-auth"}],
        "total_transactions_stored": 4242,
        "tags": 3,
    })

    out = sync.lambda_handler({}, None)

    assert calls == ["load"]  # config loaded before run_sync
    assert out == {
        "ok": True,
        "items_synced": 2,
        "warnings": [{"institution": "Old Bank", "status": "re-auth"}],
        "total_transactions_stored": 4242,
    }


def test_handler_propagates_total_failure(monkeypatch):
    # A hard failure (e.g. DB down) must propagate so the schedule retries.
    monkeypatch.setattr(sync.config_secrets, "load_into_env", lambda: None)

    def boom(investments_backfill=False):
        raise RuntimeError("DATABASE_URL is not set")

    monkeypatch.setattr(sync, "run_sync", boom)
    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        sync.lambda_handler({}, None)


def test_handler_tolerates_empty_result(monkeypatch):
    monkeypatch.setattr(sync.config_secrets, "load_into_env", lambda: None)
    monkeypatch.setattr(sync, "run_sync", lambda investments_backfill=False: {})
    out = sync.lambda_handler(None, None)
    assert out["ok"] is True
    assert out["items_synced"] == 0
    assert out["warnings"] == []


def test_handler_dry_run_pings_db_without_syncing(monkeypatch):
    monkeypatch.setattr(sync.config_secrets, "load_into_env", lambda: None)

    class _Conn:
        def __init__(self):
            self.executed = None
            self.closed = False
        def execute(self, q):
            self.executed = q
        def close(self):
            self.closed = True

    conn = _Conn()
    monkeypatch.setattr(sync.storage, "open_readonly", lambda: conn)

    def _no_sync():
        raise AssertionError("run_sync must not run during dry_run")

    monkeypatch.setattr(sync, "run_sync", _no_sync)

    out = sync.lambda_handler({"dry_run": True}, None)
    assert out == {"ok": True, "dry_run": True}
    assert conn.executed == "SELECT 1"
    assert conn.closed is True


def test_handler_passes_investments_backfill_flag(monkeypatch):
    seen = {}
    monkeypatch.setattr(sync.config_secrets, "load_into_env", lambda: None)
    monkeypatch.setattr(sync, "run_sync",
                        lambda investments_backfill=False: seen.update(backfill=investments_backfill) or {})
    sync.lambda_handler({"investments_backfill": True}, None)
    assert seen["backfill"] is True


def test_handler_defaults_to_no_backfill(monkeypatch):
    seen = {}
    monkeypatch.setattr(sync.config_secrets, "load_into_env", lambda: None)
    monkeypatch.setattr(sync, "run_sync",
                        lambda investments_backfill=False: seen.update(backfill=investments_backfill) or {})
    sync.lambda_handler({}, None)
    assert seen["backfill"] is False
