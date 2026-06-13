"""Unit tests for sync.lambda_handler (the scheduled-sync Lambda entrypoint)."""
import pytest

import sync


def test_handler_loads_config_then_summarizes(monkeypatch):
    calls = []
    monkeypatch.setattr(sync.config_secrets, "load_into_env", lambda: calls.append("load"))
    monkeypatch.setattr(sync, "run_sync", lambda: {
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

    def boom():
        raise RuntimeError("DATABASE_URL is not set")

    monkeypatch.setattr(sync, "run_sync", boom)
    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        sync.lambda_handler({}, None)


def test_handler_tolerates_empty_result(monkeypatch):
    monkeypatch.setattr(sync.config_secrets, "load_into_env", lambda: None)
    monkeypatch.setattr(sync, "run_sync", lambda: {})
    out = sync.lambda_handler(None, None)
    assert out["ok"] is True
    assert out["items_synced"] == 0
    assert out["warnings"] == []
