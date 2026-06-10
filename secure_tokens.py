"""Encrypted-at-rest storage for Plaid access tokens (Fernet).

Layout (outside the repo by default, override with PFM_SECRETS_DIR):
    ~/.config/personal-finance-mcp/
        fernet.key   chmod 600 — symmetric key, generated on first use
        tokens.enc   chmod 600 — Fernet-encrypted JSON {ENV_KEY: access_token}

Token values are never logged or printed; CLI output shows key names only.
Environment variables (PLAID_TOKEN_*) still work and override the store,
so PLAID_ENV/production swaps stay pure env changes.

CLI:
    python secure_tokens.py list
    python secure_tokens.py add CHASE        # token read from stdin, not argv
    python secure_tokens.py remove CHASE
    python secure_tokens.py import           # move PLAID_TOKEN_* env vars into the store
"""
from __future__ import annotations

import json
import os
import stat
import sys

from cryptography.fernet import Fernet, InvalidToken

_KEY_FILE = "fernet.key"
_TOKENS_FILE = "tokens.enc"


def secrets_dir() -> str:
    return os.environ.get(
        "PFM_SECRETS_DIR",
        os.path.join(os.path.expanduser("~"), ".config", "personal-finance-mcp"),
    )


def _ensure_dir() -> str:
    d = secrets_dir()
    os.makedirs(d, exist_ok=True)
    os.chmod(d, stat.S_IRWXU)  # 700
    return d


def _write_private(path: str, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, data)
    finally:
        os.close(fd)
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)  # 600, even if file pre-existed


def _get_fernet() -> Fernet:
    d = _ensure_dir()
    key_path = os.path.join(d, _KEY_FILE)
    if not os.path.exists(key_path):
        _write_private(key_path, Fernet.generate_key())
    with open(key_path, "rb") as f:
        return Fernet(f.read().strip())


def load_encrypted_tokens() -> dict[str, str]:
    """Decrypt and return {ENV_KEY: token}. Missing store -> empty dict."""
    path = os.path.join(secrets_dir(), _TOKENS_FILE)
    if not os.path.exists(path):
        return {}
    f = _get_fernet()
    with open(path, "rb") as fh:
        blob = fh.read()
    try:
        decrypted = f.decrypt(blob)
    except InvalidToken as e:
        raise RuntimeError(
            "token store cannot be decrypted with the current key "
            f"({path}); fix or remove the store"
        ) from e
    data = json.loads(decrypted)
    return {str(k): str(v) for k, v in data.items()}


def save_tokens(tokens: dict[str, str]) -> None:
    f = _get_fernet()
    path = os.path.join(_ensure_dir(), _TOKENS_FILE)
    _write_private(path, f.encrypt(json.dumps(tokens).encode()))


def set_token(env_key: str, token: str) -> None:
    """Add or replace one token. env_key is the bare suffix, e.g. 'CHASE'."""
    key = env_key.upper().removeprefix("PLAID_TOKEN_")
    tokens = load_encrypted_tokens()
    tokens[key] = token
    save_tokens(tokens)


def remove_token(env_key: str) -> bool:
    key = env_key.upper().removeprefix("PLAID_TOKEN_")
    tokens = load_encrypted_tokens()
    if key not in tokens:
        return False
    del tokens[key]
    save_tokens(tokens)
    return True


def import_from_env() -> list[str]:
    """Copy PLAID_TOKEN_* env vars into the encrypted store. Returns key names."""
    prefix = "PLAID_TOKEN_"
    tokens = load_encrypted_tokens()
    imported = []
    for key, value in os.environ.items():
        if key.startswith(prefix) and value:
            tokens[key[len(prefix):]] = value
            imported.append(key[len(prefix):])
    if imported:
        save_tokens(tokens)
    return imported


def main(argv: list[str]) -> int:
    if len(argv) < 1 or argv[0] not in ("list", "add", "remove", "import"):
        print(__doc__, file=sys.stderr)
        return 2
    cmd = argv[0]
    if cmd == "list":
        keys = sorted(load_encrypted_tokens())
        print(json.dumps({"keys": keys, "store": os.path.join(secrets_dir(), _TOKENS_FILE)}))
    elif cmd == "add":
        if len(argv) < 2:
            print("usage: secure_tokens.py add <KEY>  (token on stdin)", file=sys.stderr)
            return 2
        token = sys.stdin.readline().strip()
        if not token:
            print("no token on stdin", file=sys.stderr)
            return 2
        set_token(argv[1], token)
        print(f"stored token for {argv[1].upper().removeprefix('PLAID_TOKEN_')}")
    elif cmd == "remove":
        if len(argv) < 2:
            print("usage: secure_tokens.py remove <KEY>", file=sys.stderr)
            return 2
        ok = remove_token(argv[1])
        print("removed" if ok else "not found")
        return 0 if ok else 1
    elif cmd == "import":
        imported = import_from_env()
        print(f"imported {len(imported)} token(s): {', '.join(imported) or '(none)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
