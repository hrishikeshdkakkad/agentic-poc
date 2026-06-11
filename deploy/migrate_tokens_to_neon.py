"""Copy Fernet-encrypted Plaid token rows from the local token store into
the history database (Neon), so a remote deployment sharing the same
FERNET_KEY can read them.

Ciphertext is copied verbatim — this script never decrypts and never prints
token material. The split-trust model is preserved: the history database
holds only ciphertext; the Fernet key lives only in the deployment's env
(and the local keyfile). Idempotent: rows upsert by env_key.

Run from the repo root:
    .venv/bin/python deploy/migrate_tokens_to_neon.py
Re-run after linking any new bank locally (link_helper writes to the local
store only).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv

load_dotenv()

import storage  # noqa: E402


def main() -> int:
    src_url = os.environ.get("PFM_TOKENS_DATABASE_URL")
    dst_url = os.environ.get("DATABASE_URL")
    if not src_url or not dst_url:
        print("need PFM_TOKENS_DATABASE_URL (source) and DATABASE_URL (dest) in env/.env",
              file=sys.stderr)
        return 2
    if src_url == dst_url:
        print("source and destination are the same database; nothing to migrate")
        return 0

    src = storage.open_db(src_url)
    try:
        rows = src.execute(
            "SELECT env_key, token_ciphertext FROM plaid_tokens ORDER BY env_key"
        ).fetchall()
    finally:
        src.close()

    dst = storage.open_db(dst_url)
    try:
        for env_key, ciphertext in rows:
            dst.execute(
                """
                INSERT INTO plaid_tokens (env_key, token_ciphertext)
                VALUES (%s, %s)
                ON CONFLICT (env_key) DO UPDATE SET
                    token_ciphertext = EXCLUDED.token_ciphertext,
                    updated_at = now()
                """,
                (env_key, ciphertext),
            )
        dest_keys = [r[0] for r in dst.execute(
            "SELECT env_key FROM plaid_tokens ORDER BY env_key"
        ).fetchall()]
    finally:
        dst.close()

    print(f"copied {len(rows)} token row(s): {', '.join(k for k, _ in rows) or '(none)'}")
    print(f"destination plaid_tokens now holds: {', '.join(dest_keys) or '(none)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
