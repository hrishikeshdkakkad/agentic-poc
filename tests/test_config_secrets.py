"""Unit tests for config_secrets.load_into_env (the SSM secret loader)."""
import json
import sys
import types

import pytest

import config_secrets


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    # Each test starts from a clean loader + env, and we fully restore os.environ
    # afterward (the loader writes os.environ directly, which monkeypatch won't
    # undo) so dummy secrets never leak into the rest of the suite.
    import os
    snapshot = dict(os.environ)
    monkeypatch.setattr(config_secrets, "_loaded", False)
    monkeypatch.delenv("PFM_CONFIG_PARAM", raising=False)
    yield
    os.environ.clear()
    os.environ.update(snapshot)


def _fake_boto3(value):
    """A stand-in boto3 module whose ssm client returns `value` verbatim."""
    ssm = types.SimpleNamespace(
        get_parameter=lambda Name, WithDecryption: {"Parameter": {"Value": value}}
    )
    return types.SimpleNamespace(client=lambda service: ssm)


def test_noop_when_param_unset(monkeypatch):
    # No PFM_CONFIG_PARAM -> returns False and never imports boto3.
    monkeypatch.setitem(sys.modules, "boto3", None)  # would explode if used
    assert config_secrets.load_into_env() is False


def test_populates_env_from_ssm(monkeypatch):
    cfg = {"PLAID_SECRET": "shh", "DATABASE_URL": "postgres://x", "PLAID_ENV": "production"}
    monkeypatch.setitem(sys.modules, "boto3", _fake_boto3(json.dumps(cfg)))
    monkeypatch.setenv("PFM_CONFIG_PARAM", "/personal-finance-mcp/config")
    for k in cfg:
        monkeypatch.delenv(k, raising=False)

    assert config_secrets.load_into_env() is True
    import os
    assert os.environ["PLAID_SECRET"] == "shh"
    assert os.environ["DATABASE_URL"] == "postgres://x"


def test_is_idempotent(monkeypatch):
    calls = {"n": 0}

    def client(service):
        calls["n"] += 1
        return types.SimpleNamespace(
            get_parameter=lambda Name, WithDecryption: {"Parameter": {"Value": "{}"}}
        )

    monkeypatch.setitem(sys.modules, "boto3", types.SimpleNamespace(client=client))
    monkeypatch.setenv("PFM_CONFIG_PARAM", "/p")
    config_secrets.load_into_env()
    config_secrets.load_into_env()
    assert calls["n"] == 1  # second call short-circuits on the _loaded guard


def test_overwrite_false_preserves_existing(monkeypatch):
    monkeypatch.setitem(sys.modules, "boto3", _fake_boto3(json.dumps({"PLAID_ENV": "sandbox"})))
    monkeypatch.setenv("PFM_CONFIG_PARAM", "/p")
    monkeypatch.setenv("PLAID_ENV", "production")
    config_secrets.load_into_env(overwrite=False)
    import os
    assert os.environ["PLAID_ENV"] == "production"


def test_raises_on_bad_json(monkeypatch):
    monkeypatch.setitem(sys.modules, "boto3", _fake_boto3("not json"))
    monkeypatch.setenv("PFM_CONFIG_PARAM", "/p")
    with pytest.raises(RuntimeError, match="not valid JSON"):
        config_secrets.load_into_env()


def test_raises_when_not_object(monkeypatch):
    monkeypatch.setitem(sys.modules, "boto3", _fake_boto3(json.dumps(["a", "b"])))
    monkeypatch.setenv("PFM_CONFIG_PARAM", "/p")
    with pytest.raises(RuntimeError, match="JSON object"):
        config_secrets.load_into_env()
