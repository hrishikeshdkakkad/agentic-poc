import os
import subprocess
import sys
from unittest.mock import MagicMock

from fastapi.testclient import TestClient

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _reload_link_helper_with_mock_api():
    import importlib
    import link_helper
    importlib.reload(link_helper)
    link_helper.api = MagicMock()
    link_helper.api.link_token_create.return_value.to_dict.return_value = {"link_token": "link-sandbox-x"}
    return link_helper


def _sent_body(link_helper):
    return link_helper.api.link_token_create.call_args[0][0].to_dict()


def test_horizon_guard_blocks_import():
    # Run a fresh subprocess with HORIZON set; importing link_helper must sys.exit.
    result = subprocess.run(
        [sys.executable, "-c", "import link_helper"],
        env={**os.environ, "HORIZON": "1"},
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    assert result.returncode != 0
    assert "must not run on Horizon" in (result.stderr + result.stdout)


def test_index_returns_html(fake_env_tokens):
    # Import inside the test so fake_env_tokens env is active before build_api() runs.
    # NOTE: link_helper.build_api() is called at import time, but we're using
    # fake env vars which produce a valid (if useless) PlaidApi instance.
    import importlib
    import link_helper
    importlib.reload(link_helper)
    client = TestClient(link_helper.app)
    resp = client.get("/")
    assert resp.status_code == 200
    assert "Plaid" in resp.text
    assert "Link a bank" in resp.text


def test_create_link_token_new_link_requires_investments(fake_env_tokens):
    """New links pre-consent investments so investment-tx never needs a later re-link."""
    link_helper = _reload_link_helper_with_mock_api()
    client = TestClient(link_helper.app)
    resp = client.post("/create-link-token", json={})
    assert resp.status_code == 200
    body = _sent_body(link_helper)
    assert body["products"] == ["transactions"]
    assert body["required_if_supported_products"] == ["investments"]
    assert "investments" not in body.get("optional_products", [])
    # New Items request the full 24 months Plaid allows (default is only 90 days);
    # days_requested is fixed at Item creation and can never be raised afterwards.
    assert body["transactions"]["days_requested"] == 730


def test_create_link_token_update_mode_omits_days_requested(fake_env_tokens):
    """days_requested cannot be set in update mode -- it's immutable once Transactions
    is on the Item, so we must not send it (Plaid would reject the request)."""
    link_helper = _reload_link_helper_with_mock_api()
    client = TestClient(link_helper.app)
    resp = client.post("/create-link-token", json={"update_access_token": "access-prod-x"})
    assert resp.status_code == 200
    assert "transactions" not in _sent_body(link_helper)


def test_create_link_token_update_mode_adds_investments_when_requested(fake_env_tokens):
    """Fidelity/Schwab fix: add the investments product to an already-linked Item."""
    link_helper = _reload_link_helper_with_mock_api()
    client = TestClient(link_helper.app)
    resp = client.post("/create-link-token",
                       json={"update_access_token": "access-prod-x", "add_investments": True})
    assert resp.status_code == 200
    body = _sent_body(link_helper)
    assert body["access_token"] == "access-prod-x"
    assert body["additional_consented_products"] == ["investments"]


def test_create_link_token_plain_reauth_omits_investments(fake_env_tokens):
    """A plain re-auth (e.g. Chase ITEM_LOGIN_REQUIRED) must not request investments."""
    link_helper = _reload_link_helper_with_mock_api()
    client = TestClient(link_helper.app)
    resp = client.post("/create-link-token", json={"update_access_token": "access-prod-x"})
    assert resp.status_code == 200
    body = _sent_body(link_helper)
    assert "additional_consented_products" not in body


def test_reset_item_endpoint(fake_env_tokens, monkeypatch):
    link_helper = _reload_link_helper_with_mock_api()
    import reset_item
    from reset_item import ResetResult
    monkeypatch.setattr(
        reset_item, "reset_item",
        lambda env_key, **kw: ResetResult(env_key, "Chase", {"transactions": 5},
                                          "resets/CHASE-x.json", "removed", ["url"]),
    )
    client = TestClient(link_helper.app)
    resp = client.post("/reset-item", json={"env_key": "CHASE"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["env_key"] == "CHASE"
    assert body["plaid_removed"] == "removed"
