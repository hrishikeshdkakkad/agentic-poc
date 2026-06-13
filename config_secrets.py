"""Load deployment config/secrets from AWS SSM Parameter Store at startup.

In deployment the Plaid/DB/Fernet secrets are NOT plaintext Lambda environment
variables. They live in one SSM SecureString parameter (a JSON blob) encrypted
with a customer-managed KMS key whose policy denies every account principal
except this app's Lambda execution roles (and root). Reading the parameter
therefore requires both ``ssm:GetParameter`` and ``kms:Decrypt`` on that key --
which the other shared-account admins are explicitly denied.

``load_into_env()`` fetches that parameter once and populates ``os.environ``
before any module reads PLAID_*/DATABASE_URL/FERNET_KEY/MCP_AUTH_TOKEN. It is a
no-op when ``PFM_CONFIG_PARAM`` is unset, so local runs, tests, and ``.env``
keep working unchanged. Secret values are never logged.
"""
from __future__ import annotations

import json
import os

_PARAM_ENV = "PFM_CONFIG_PARAM"
_loaded = False


def load_into_env(*, overwrite: bool = True) -> bool:
    """Populate ``os.environ`` from the SSM SecureString named by ``$PFM_CONFIG_PARAM``.

    Returns True if config was loaded from SSM, False if ``PFM_CONFIG_PARAM`` is
    unset (the local/dev/test path). Idempotent: a second call is a no-op.

    Raises if the parameter is named but cannot be fetched or parsed -- a
    missing secret store must fail loudly, never silently leave the process
    unconfigured (mirrors lambda_app refusing to serve without MCP_AUTH_TOKEN).
    """
    global _loaded
    param = os.environ.get(_PARAM_ENV)
    if not param:
        return False
    if _loaded:
        return True

    # boto3 ships in the AWS Lambda runtime; import lazily so non-Lambda paths
    # (tests, CLI without PFM_CONFIG_PARAM) never require it installed.
    import boto3

    resp = boto3.client("ssm").get_parameter(Name=param, WithDecryption=True)
    raw = resp["Parameter"]["Value"]
    try:
        values = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"SSM parameter {param!r} is not valid JSON config") from e
    if not isinstance(values, dict):
        raise RuntimeError(f"SSM parameter {param!r} must be a JSON object")

    for key, value in values.items():
        if value is None:
            continue
        if overwrite or key not in os.environ:
            os.environ[str(key)] = str(value)
    _loaded = True
    return True
