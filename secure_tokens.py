"""Encrypted-at-rest storage for Plaid access tokens, persisted in Postgres.

Tokens are Fernet-encrypted *client-side* and the ciphertext is stored in
the ``plaid_tokens`` table (so the server can run anywhere that reaches the
database). The Fernet key never touches the database:

    key resolution order:
      1. FERNET_KEY env var (for deployments — a base64 Fernet key)
      2. keyfile at $PFM_SECRETS_DIR/fernet.key, chmod 600, generated on
         first use (default dir: ~/.config/personal-finance-mcp, chmod 700)

Someone holding only the DATABASE_URL sees ciphertext; someone holding only
the key sees nothing. Token values are never logged or printed; CLI output
shows key names only. PLAID_TOKEN_* env vars still work and override the
store (see plaid_client.load_tokens).

A legacy file store ($PFM_SECRETS_DIR/tokens.enc, from the pre-Postgres
layout) is migrated into the database automatically on first load and
renamed to tokens.enc.migrated.

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
_LEGACY_TOKENS_FILE = "tokens.enc"


def _tokens_db_url() -> str | None:
    """Database holding plaid_tokens. Defaults to DATABASE_URL (one shared
    Postgres, the upstream layout). Set PFM_TOKENS_DATABASE_URL to keep
    credentials in a separate (e.g. local-only) database from the history
    store, so access tokens never reach the managed/history database."""
    return os.environ.get("PFM_TOKENS_DATABASE_URL") or None


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
    env_key = os.environ.get("FERNET_KEY")
    if env_key:
        return Fernet(env_key.strip().encode())
    d = _ensure_dir()
    key_path = os.path.join(d, _KEY_FILE)
    if not os.path.exists(key_path):
        _write_private(key_path, Fernet.generate_key())
    with open(key_path, "rb") as f:
        return Fernet(f.read().strip())


def _decrypt(f: Fernet, ciphertext: str, context: str) -> str:
    try:
        return f.decrypt(ciphertext.encode()).decode()
    except InvalidToken as e:
        raise RuntimeError(
            f"stored token for {context} cannot be decrypted with the current "
            "Fernet key; fix the key (FERNET_KEY / fernet.key) or remove the row"
        ) from e


def _migrate_legacy_file(conn, f: Fernet) -> None:
    """One-time import of the old file-based store into plaid_tokens."""
    path = os.path.join(secrets_dir(), _LEGACY_TOKENS_FILE)
    if not os.path.exists(path):
        return
    with open(path, "rb") as fh:
        blob = fh.read()
    try:
        data = json.loads(f.decrypt(blob))
    except InvalidToken as e:
        raise RuntimeError(
            f"legacy token store {path} cannot be decrypted with the current key; "
            "fix or remove it"
        ) from e
    for key, value in data.items():
        _upsert(conn, str(key), f.encrypt(str(value).encode()).decode())
    os.rename(path, path + ".migrated")


def _upsert(conn, env_key: str, ciphertext: str) -> None:
    conn.execute(
        """
        INSERT INTO plaid_tokens (env_key, token_ciphertext)
        VALUES (%s, %s)
        ON CONFLICT (env_key) DO UPDATE SET
            token_ciphertext = EXCLUDED.token_ciphertext,
            updated_at = now()
        """,
        (env_key, ciphertext),
    )


def _norm(env_key: str) -> str:
    return env_key.upper().removeprefix("PLAID_TOKEN_")


def load_encrypted_tokens() -> dict[str, str]:
    """Decrypt and return {ENV_KEY: token} from the plaid_tokens table."""
    import storage
    f = _get_fernet()
    conn = storage.open_db(_tokens_db_url())
    try:
        _migrate_legacy_file(conn, f)
        rows = conn.execute(
            "SELECT env_key, token_ciphertext FROM plaid_tokens ORDER BY env_key"
        ).fetchall()
    finally:
        conn.close()
    return {k: _decrypt(f, ct, k) for k, ct in rows}


def set_token(env_key: str, token: str) -> None:
    """Add or replace one token. env_key is the bare suffix, e.g. 'CHASE'."""
    import storage
    f = _get_fernet()
    conn = storage.open_db(_tokens_db_url())
    try:
        _upsert(conn, _norm(env_key), f.encrypt(token.encode()).decode())
    finally:
        conn.close()


def remove_token(env_key: str) -> bool:
    import storage
    conn = storage.open_db(_tokens_db_url())
    try:
        cur = conn.execute(
            "DELETE FROM plaid_tokens WHERE env_key = %s", (_norm(env_key),)
        )
        return cur.rowcount > 0
    finally:
        conn.close()


def import_from_env() -> list[str]:
    """Copy PLAID_TOKEN_* env vars into the encrypted store. Returns key names."""
    import storage
    prefix = "PLAID_TOKEN_"
    f = _get_fernet()
    imported = []
    conn = storage.open_db(_tokens_db_url())
    try:
        for key, value in os.environ.items():
            if key.startswith(prefix) and value:
                _upsert(conn, key[len(prefix):], f.encrypt(value.encode()).decode())
                imported.append(key[len(prefix):])
    finally:
        conn.close()
    return imported


def main(argv: list[str]) -> int:
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass
    if len(argv) < 1 or argv[0] not in ("list", "add", "remove", "import"):
        print(__doc__, file=sys.stderr)
        return 2
    cmd = argv[0]
    if cmd == "list":
        keys = sorted(load_encrypted_tokens())
        print(json.dumps({"keys": keys, "store": "plaid_tokens table"}))
    elif cmd == "add":
        if len(argv) < 2:
            print("usage: secure_tokens.py add <KEY>  (token on stdin)", file=sys.stderr)
            return 2
        token = sys.stdin.readline().strip()
        if not token:
            print("no token on stdin", file=sys.stderr)
            return 2
        set_token(argv[1], token)
        print(f"stored token for {_norm(argv[1])}")
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
