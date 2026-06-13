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


def _inject(monkeypatch, get_parameter):
    """Install fake boto3 + botocore.config modules (neither need be installed).

    `get_parameter` is a callable (Name=, WithDecryption=) -> response dict.
    The fake client accepts the `config=` kwarg the loader now passes.
    """
    ssm = types.SimpleNamespace(get_parameter=get_parameter)
    monkeypatch.setitem(sys.modules, "boto3",
                        types.SimpleNamespace(client=lambda service, **kw: ssm))
    botocore = types.ModuleType("botocore")
    bcfg = types.ModuleType("botocore.config")
    bcfg.Config = lambda **kw: object()
    monkeypatch.setitem(sys.modules, "botocore", botocore)
    monkeypatch.setitem(sys.modules, "botocore.config", bcfg)


def test_noop_when_param_unset(monkeypatch):
    monkeypatch.setitem(sys.modules, "boto3", None)  # would explode if used
    assert config_secrets.load_into_env() is False


def test_populates_env_from_ssm(monkeypatch):
    import os
    cfg = {"PLAID_SECRET": "shh", "DATABASE_URL": "postgres://x", "PLAID_ENV": "production"}
    _inject(monkeypatch, lambda Name, WithDecryption: {"Parameter": {"Value": json.dumps(cfg)}})
    monkeypatch.setenv("PFM_CONFIG_PARAM", "/personal-finance-mcp/config")
    for k in cfg:
        monkeypatch.delenv(k, raising=False)
    assert config_secrets.load_into_env() is True
    assert os.environ["PLAID_SECRET"] == "shh"
    assert os.environ["DATABASE_URL"] == "postgres://x"


def test_with_decryption_is_requested(monkeypatch):
    seen = {}

    def gp(Name, WithDecryption):
        seen["decrypt"] = WithDecryption
        return {"Parameter": {"Value": "{}"}}

    _inject(monkeypatch, gp)
    monkeypatch.setenv("PFM_CONFIG_PARAM", "/p")
    config_secrets.load_into_env()
    assert seen["decrypt"] is True  # must decrypt the SecureString


def test_is_idempotent(monkeypatch):
    calls = {"n": 0}

    def gp(Name, WithDecryption):
        calls["n"] += 1
        return {"Parameter": {"Value": "{}"}}

    _inject(monkeypatch, gp)
    monkeypatch.setenv("PFM_CONFIG_PARAM", "/p")
    config_secrets.load_into_env()
    config_secrets.load_into_env()
    assert calls["n"] == 1  # second call short-circuits on the _loaded guard


def test_overwrite_false_preserves_existing(monkeypatch):
    import os
    _inject(monkeypatch, lambda Name, WithDecryption: {"Parameter": {"Value": json.dumps({"PLAID_ENV": "sandbox"})}})
    monkeypatch.setenv("PFM_CONFIG_PARAM", "/p")
    monkeypatch.setenv("PLAID_ENV", "production")
    config_secrets.load_into_env(overwrite=False)
    assert os.environ["PLAID_ENV"] == "production"


def test_raises_on_bad_json(monkeypatch):
    _inject(monkeypatch, lambda Name, WithDecryption: {"Parameter": {"Value": "not json"}})
    monkeypatch.setenv("PFM_CONFIG_PARAM", "/p")
    with pytest.raises(RuntimeError, match="not valid JSON"):
        config_secrets.load_into_env()


def test_raises_when_not_object(monkeypatch):
    _inject(monkeypatch, lambda Name, WithDecryption: {"Parameter": {"Value": json.dumps(["a", "b"])}})
    monkeypatch.setenv("PFM_CONFIG_PARAM", "/p")
    with pytest.raises(RuntimeError, match="JSON object"):
        config_secrets.load_into_env()
