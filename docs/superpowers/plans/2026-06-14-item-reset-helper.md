# Item Reset Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A safe, repeatable helper that retires a Plaid Item at Plaid, backs up and wipes its local state across all `item_key` tables and both token stores, leaving a clean slate to re-link with `days_requested=730`.

**Architecture:** One shared core module `reset_item.py` owns the ordered, multi-store sequence (backup → `/item/remove` → atomic wipe → two-store token clear). A CLI and a `link_helper` endpoint are thin wrappers. Mirrors the codebase's "one shared shaper" pattern so call sites can't drift.

**Tech Stack:** Python 3.11, psycopg3, FastAPI (link_helper), plaid-python SDK, pytest (test Postgres `db` fixture), Next.js/React + vitest (dashboard).

**Spec:** `docs/superpowers/specs/2026-06-13-item-reset-helper-design.md`

---

## File Structure

- **Create** `reset_item.py` — core module + CLI (`preview_reset`, `reset_item`, `reset_all`, `restore_from_backup`, `main`).
- **Create** `tests/test_reset_item.py` — unit tests against the test Postgres.
- **Modify** `secure_tokens.py` — add optional `url=` to `remove_token` so a specific store can be targeted.
- **Modify** `link_helper.py` — add `POST /reset-item`.
- **Modify** `tests/test_link_helper.py` — endpoint test.
- **Modify** `dashboard/src/app/api/link/[...path]/route.ts` — allowlist `reset-item`.
- **Modify** `dashboard/src/app/api/link/route.test.ts` — allowlist test.
- **Modify** `dashboard/src/app/connections/page.tsx` — per-bank "Reset & re-link" button.
- **Modify** `.gitignore` — ignore `resets/`.

Run all Python tests with: `.venv/bin/python -m pytest tests/test_reset_item.py -v`
Full suite: `.venv/bin/python -m pytest -q`

---

### Task 0: Capture the already-implemented `days_requested=730` change on this branch

The working tree already contains the tested `days_requested=730` change to `link_helper.py` and `tests/test_link_helper.py` (from earlier in this session). Commit it first so this branch is self-contained.

- [ ] **Step 1: Verify the change is present and tests pass**

Run: `.venv/bin/python -m pytest tests/test_link_helper.py -q`
Expected: PASS (6 passed)

- [ ] **Step 2: Commit**

```bash
git add link_helper.py tests/test_link_helper.py
git commit -m "feat: request 730 days of transaction history on new Plaid links

New Items now seed 24 months instead of Plaid's 90-day default. Immutable
once set, so it only affects links created from here on (or fresh re-links).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1: Scaffold `reset_item.py` with `preview_reset`

**Files:**
- Create: `reset_item.py`
- Create: `tests/test_reset_item.py`
- Modify: `.gitignore`

- [ ] **Step 1: Ignore the backup directory**

Append to `.gitignore`:

```
# Item-reset backups (contain financial data: balances, transactions)
resets/
```

- [ ] **Step 2: Write the failing test**

Create `tests/test_reset_item.py`:

```python
import json
import os

import pytest

import reset_item


def _seed_item(conn, key):
    """Insert one row per item_key table plus a tag, for item_key=key."""
    conn.execute(
        "INSERT INTO accounts (account_id, item_key, institution, name, type, subtype, currency, updated_at)"
        " VALUES (%s,%s,%s,'Acct','depository','checking','USD', now())",
        (f"{key}_acct", key, key.title()),
    )
    conn.execute(
        "INSERT INTO transactions (transaction_id, account_id, item_key, date, amount, currency, name)"
        " VALUES (%s,%s,%s,'2026-01-01', 9.99,'USD','Coffee')",
        (f"{key}_tx", f"{key}_acct", key),
    )
    conn.execute(
        "INSERT INTO transaction_tags (transaction_id, tag, source) VALUES (%s,'coffee','rule')",
        (f"{key}_tx",),
    )
    conn.execute(
        "INSERT INTO balance_snapshots (snapshot_date, account_id, item_key, institution, type, subtype, current)"
        " VALUES ('2026-01-01', %s,%s,'X','depository','checking', 100.0)",
        (f"{key}_acct", key),
    )
    conn.execute(
        "INSERT INTO holdings_snapshots (snapshot_date, account_id, item_key, security_id, quantity)"
        " VALUES ('2026-01-01', %s,%s,'sec1', 1.0)",
        (f"{key}_acct", key),
    )
    conn.execute(
        "INSERT INTO liabilities_snapshots (snapshot_date, account_id, item_key, liability_type, current)"
        " VALUES ('2026-01-01', %s,%s,'credit', 50.0)",
        (f"{key}_acct", key),
    )
    conn.execute(
        "INSERT INTO investment_transactions (investment_transaction_id, account_id, item_key, date, name, type, amount)"
        " VALUES (%s,%s,%s,'2026-01-01','Buy','buy', 10.0)",
        (f"{key}_inv", f"{key}_acct", key),
    )
    conn.execute(
        "INSERT INTO sync_state (item_key, cursor) VALUES (%s,'cur123')",
        (key,),
    )


def test_preview_counts_rows_for_item(db):
    _seed_item(db, "CHASE")
    _seed_item(db, "SOFI")
    counts = reset_item.preview_reset("CHASE")
    assert counts["transactions"] == 1
    assert counts["transaction_tags"] == 1
    assert counts["balance_snapshots"] == 1
    assert counts["holdings_snapshots"] == 1
    assert counts["liabilities_snapshots"] == 1
    assert counts["investment_transactions"] == 1
    assert counts["accounts"] == 1
    assert counts["sync_state"] == 1


def test_preview_normalizes_prefixed_key(db):
    _seed_item(db, "CHASE")
    assert reset_item.preview_reset("PLAID_TOKEN_chase")["transactions"] == 1
```

- [ ] **Step 3: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_reset_item.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'reset_item'`

- [ ] **Step 4: Write the minimal module**

Create `reset_item.py`:

```python
"""Safely retire a Plaid Item and reset its local state for a fresh re-link.

Re-linking is the only way to deepen an existing Item's transaction history
(days_requested is immutable once set). This helper removes the old Item at
Plaid, backs up and wipes its local rows, and clears its token from both the
local and Neon stores, leaving a clean slate to re-link with days_requested=730.

See docs/superpowers/specs/2026-06-13-item-reset-helper-design.md.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

import storage
import secure_tokens

# Tables keyed by item_key. Ordered child-first (snapshots/investments before
# accounts) for readable backups; the wipe also removes transaction_tags, which
# are keyed by transaction_id rather than item_key (handled separately).
_ITEM_TABLES = (
    "balance_snapshots",
    "holdings_snapshots",
    "liabilities_snapshots",
    "investment_transactions",
    "accounts",
    "transactions",
    "sync_state",
)

_BACKUP_DIR = "resets"


@dataclass
class ResetResult:
    env_key: str
    institution: str | None
    deleted: dict = field(default_factory=dict)
    backup_path: str | None = None
    plaid_removed: str = "skipped"   # "removed" | "already_absent" | "skipped"
    token_cleared: list = field(default_factory=list)
    dry_run: bool = False


def preview_reset(env_key: str, *, db_url: str | None = None) -> dict:
    """Return per-table row counts for this item_key. No mutation."""
    key = secure_tokens._norm(env_key)
    conn = storage.open_readonly(db_url)
    try:
        counts = {
            "transaction_tags": conn.execute(
                "SELECT count(*) FROM transaction_tags t "
                "JOIN transactions x ON t.transaction_id = x.transaction_id "
                "WHERE x.item_key = %s",
                (key,),
            ).fetchone()[0]
        }
        for table in _ITEM_TABLES:
            counts[table] = conn.execute(
                f"SELECT count(*) FROM {table} WHERE item_key = %s", (key,)
            ).fetchone()[0]
    finally:
        conn.close()
    return counts
```

- [ ] **Step 5: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_reset_item.py -q`
Expected: PASS (2 passed)

- [ ] **Step 6: Commit**

```bash
git add reset_item.py tests/test_reset_item.py .gitignore
git commit -m "feat(reset): preview_reset + module scaffold

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Add `url=` to `secure_tokens.remove_token`

The reset must clear the token from BOTH the local token store and the Neon copy. `remove_token` currently hits only `_tokens_db_url()`. Add an optional `url`.

**Files:**
- Modify: `secure_tokens.py` (the `remove_token` function)
- Modify: `tests/test_reset_item.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_reset_item.py`:

```python
import secure_tokens


def test_remove_token_targets_explicit_url(db):
    # Both DATABASE_URL and PFM_TOKENS_DATABASE_URL point at the test DB here.
    db.execute(
        "INSERT INTO plaid_tokens (env_key, token_ciphertext) VALUES ('CHASE','ct')"
    )
    removed = secure_tokens.remove_token("CHASE", url=os.environ["DATABASE_URL"])
    assert removed is True
    left = db.execute(
        "SELECT count(*) FROM plaid_tokens WHERE env_key='CHASE'"
    ).fetchone()[0]
    assert left == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_reset_item.py::test_remove_token_targets_explicit_url -q`
Expected: FAIL with `TypeError: remove_token() got an unexpected keyword argument 'url'`

- [ ] **Step 3: Edit `remove_token`**

In `secure_tokens.py`, replace the existing `remove_token`:

```python
def remove_token(env_key: str, url: str | None = None) -> bool:
    import storage
    conn = storage.open_db(url or _tokens_db_url())
    try:
        cur = conn.execute(
            "DELETE FROM plaid_tokens WHERE env_key = %s", (_norm(env_key),)
        )
        return cur.rowcount > 0
    finally:
        conn.close()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_reset_item.py::test_remove_token_targets_explicit_url -q`
Expected: PASS

- [ ] **Step 5: Run the existing secure_tokens tests to confirm no regression**

Run: `.venv/bin/python -m pytest tests/ -k secure_token -q`
Expected: PASS (or "no tests ran" if none exist — acceptable)

- [ ] **Step 6: Commit**

```bash
git add secure_tokens.py tests/test_reset_item.py
git commit -m "feat(reset): remove_token can target a specific store url

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Backup-to-JSON helper

**Files:**
- Modify: `reset_item.py`
- Modify: `tests/test_reset_item.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_reset_item.py`:

```python
from datetime import datetime


def test_backup_writes_all_item_rows(db, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)  # so resets/ is created under tmp
    _seed_item(db, "CHASE")
    path = reset_item._backup("CHASE", os.environ["DATABASE_URL"],
                              datetime(2026, 6, 14, 10, 45, 0))
    assert path == os.path.join("resets", "CHASE-2026-06-14-104500.json")
    data = json.loads(open(path).read())
    assert data["env_key"] == "CHASE"
    assert len(data["tables"]["transactions"]) == 1
    assert len(data["tables"]["transaction_tags"]) == 1
    assert data["tables"]["transactions"][0]["name"] == "Coffee"
    # The token is a secret and must never be written to a backup.
    assert "plaid_tokens" not in data["tables"]
    assert "token" not in json.dumps(data).lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_reset_item.py::test_backup_writes_all_item_rows -q`
Expected: FAIL with `AttributeError: module 'reset_item' has no attribute '_backup'`

- [ ] **Step 3: Add the backup helpers to `reset_item.py`**

```python
def _rows(conn, sql: str, params: tuple) -> list[dict]:
    cur = conn.execute(sql, params)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def _backup(env_key: str, db_url: str | None, now) -> str:
    key = secure_tokens._norm(env_key)
    conn = storage.open_readonly(db_url)
    try:
        tables = {
            "transaction_tags": _rows(
                conn,
                "SELECT t.* FROM transaction_tags t "
                "JOIN transactions x ON t.transaction_id = x.transaction_id "
                "WHERE x.item_key = %s",
                (key,),
            )
        }
        for table in _ITEM_TABLES:
            tables[table] = _rows(
                conn, f"SELECT * FROM {table} WHERE item_key = %s", (key,)
            )
    finally:
        conn.close()
    data = {"env_key": key, "backed_up_at": now.isoformat(), "tables": tables}
    os.makedirs(_BACKUP_DIR, exist_ok=True)
    path = os.path.join(_BACKUP_DIR, f"{key}-{now:%Y-%m-%d-%H%M%S}.json")
    with open(path, "w") as fh:
        json.dump(data, fh, indent=2, default=str)
    return path
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_reset_item.py::test_backup_writes_all_item_rows -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add reset_item.py tests/test_reset_item.py
git commit -m "feat(reset): JSON backup of all item rows (token excluded)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Core `reset_item` sequence

**Files:**
- Modify: `reset_item.py`
- Modify: `tests/test_reset_item.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_reset_item.py`:

```python
from unittest.mock import MagicMock

from plaid.exceptions import ApiException


def _api_raising(error_code):
    api = MagicMock()
    exc = ApiException(status=400)
    exc.body = json.dumps({"error_code": error_code})
    api.item_remove.side_effect = exc
    return api


def _store_token(conn, key, url_env="DATABASE_URL"):
    conn.execute(
        "INSERT INTO plaid_tokens (env_key, token_ciphertext) VALUES (%s,%s)"
        " ON CONFLICT (env_key) DO NOTHING",
        (key, "ct-unused-because-api-mocked"),
    )


def test_reset_wipes_target_and_preserves_others(db, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _seed_item(db, "CHASE")
    _seed_item(db, "SOFI")
    _store_token(db, "CHASE")
    # Make load_tokens return a revealable token for CHASE without real crypto.
    from pydantic import SecretStr
    monkeypatch.setattr(reset_item.plaid_client, "load_tokens",
                        lambda: {"CHASE": SecretStr("access-prod-x")})
    api = MagicMock()  # item_remove succeeds

    result = reset_item.reset_item("CHASE", confirm=True, api=api)

    assert result.plaid_removed == "removed"
    api.item_remove.assert_called_once()
    # CHASE fully wiped
    for table in ("transactions", "accounts", "balance_snapshots",
                  "holdings_snapshots", "liabilities_snapshots",
                  "investment_transactions", "sync_state"):
        assert db.execute(f"SELECT count(*) FROM {table} WHERE item_key='CHASE'").fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM transaction_tags WHERE transaction_id='CHASE_tx'").fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM plaid_tokens WHERE env_key='CHASE'").fetchone()[0] == 0
    # SOFI untouched — the consistency guard
    assert db.execute("SELECT count(*) FROM transactions WHERE item_key='SOFI'").fetchone()[0] == 1
    assert db.execute("SELECT count(*) FROM accounts WHERE item_key='SOFI'").fetchone()[0] == 1
    assert os.path.exists(result.backup_path)


def test_reset_dry_run_changes_nothing(db, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _seed_item(db, "CHASE")
    from pydantic import SecretStr
    monkeypatch.setattr(reset_item.plaid_client, "load_tokens",
                        lambda: {"CHASE": SecretStr("access-prod-x")})
    result = reset_item.reset_item("CHASE", confirm=False, api=MagicMock())
    assert result.dry_run is True
    assert result.deleted["transactions"] == 1
    assert db.execute("SELECT count(*) FROM transactions WHERE item_key='CHASE'").fetchone()[0] == 1


def test_reset_aborts_when_plaid_remove_fails(db, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _seed_item(db, "CHASE")
    _store_token(db, "CHASE")
    from pydantic import SecretStr
    monkeypatch.setattr(reset_item.plaid_client, "load_tokens",
                        lambda: {"CHASE": SecretStr("access-prod-x")})
    api = _api_raising("INTERNAL_SERVER_ERROR")
    with pytest.raises(ApiException):
        reset_item.reset_item("CHASE", confirm=True, api=api)
    # Nothing deleted — local data and token intact.
    assert db.execute("SELECT count(*) FROM transactions WHERE item_key='CHASE'").fetchone()[0] == 1
    assert db.execute("SELECT count(*) FROM plaid_tokens WHERE env_key='CHASE'").fetchone()[0] == 1


def test_reset_treats_item_not_found_as_done(db, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _seed_item(db, "CHASE")
    _store_token(db, "CHASE")
    from pydantic import SecretStr
    monkeypatch.setattr(reset_item.plaid_client, "load_tokens",
                        lambda: {"CHASE": SecretStr("access-prod-x")})
    api = _api_raising("ITEM_NOT_FOUND")
    result = reset_item.reset_item("CHASE", confirm=True, api=api)
    assert result.plaid_removed == "already_absent"
    assert db.execute("SELECT count(*) FROM transactions WHERE item_key='CHASE'").fetchone()[0] == 0


def test_reset_refuses_env_var_token(db, monkeypatch):
    monkeypatch.setenv("PLAID_TOKEN_CHASE", "access-prod-x")
    with pytest.raises(RuntimeError, match="env-var-backed"):
        reset_item.reset_item("CHASE", confirm=True, api=MagicMock())


def test_reset_errors_on_unknown_connection(db, monkeypatch):
    from pydantic import SecretStr
    monkeypatch.setattr(reset_item.plaid_client, "load_tokens", lambda: {})
    with pytest.raises(RuntimeError, match="no token"):
        reset_item.reset_item("NOPE", confirm=True, api=MagicMock())
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_reset_item.py -k reset -q`
Expected: FAIL with `AttributeError: module 'reset_item' has no attribute 'reset_item'` (and `plaid_client`)

- [ ] **Step 3: Implement the core in `reset_item.py`**

Add the `plaid_client` import at the top (with the other imports):

```python
import plaid_client
from plaid.exceptions import ApiException
from plaid.model.item_remove_request import ItemRemoveRequest
```

Add these functions:

```python
def _is_item_not_found(exc: ApiException) -> bool:
    try:
        body = json.loads(getattr(exc, "body", "") or "{}")
    except (ValueError, TypeError):
        return False
    return isinstance(body, dict) and body.get("error_code") == "ITEM_NOT_FOUND"


def _institution(key: str, db_url: str | None) -> str | None:
    conn = storage.open_readonly(db_url)
    try:
        row = conn.execute(
            "SELECT institution FROM accounts WHERE item_key = %s LIMIT 1", (key,)
        ).fetchone()
    finally:
        conn.close()
    return row[0] if row else None


def _wipe(key: str, db_url: str | None) -> dict:
    conn = storage.open_db(db_url)
    deleted: dict = {}
    try:
        with conn.transaction():
            cur = conn.execute(
                "DELETE FROM transaction_tags WHERE transaction_id IN "
                "(SELECT transaction_id FROM transactions WHERE item_key = %s)",
                (key,),
            )
            deleted["transaction_tags"] = cur.rowcount
            for table in _ITEM_TABLES:
                cur = conn.execute(
                    f"DELETE FROM {table} WHERE item_key = %s", (key,)
                )
                deleted[table] = cur.rowcount
    finally:
        conn.close()
    return deleted


def reset_item(env_key: str, *, confirm: bool = False, api=None,
               db_url: str | None = None, tokens_url: str | None = None,
               now=None) -> ResetResult:
    from datetime import datetime

    key = secure_tokens._norm(env_key)
    db_url = db_url or storage.database_url()
    tokens_url = tokens_url or secure_tokens._tokens_db_url() or db_url

    if os.environ.get(f"PLAID_TOKEN_{key}"):
        raise RuntimeError(
            f"{key} token is env-var-backed; unset PLAID_TOKEN_{key} and retry"
        )

    token = plaid_client.load_tokens().get(key)
    if token is None:
        raise RuntimeError(
            f"no token for {key}: unknown or already-cleared connection"
        )

    institution = _institution(key, db_url)
    preview = preview_reset(key, db_url=db_url)

    if not confirm:
        return ResetResult(key, institution, deleted=preview, dry_run=True)

    now = now or datetime.now()
    backup_path = _backup(key, db_url, now)

    api = api or plaid_client.build_api()
    try:
        api.item_remove(ItemRemoveRequest(access_token=token.reveal()))
        plaid_removed = "removed"
    except ApiException as exc:
        if not _is_item_not_found(exc):
            raise  # abort: local data + token untouched
        plaid_removed = "already_absent"

    deleted = _wipe(key, db_url)

    cleared: list = []
    for url in dict.fromkeys([tokens_url, db_url]):  # dedupe, keep order
        if secure_tokens.remove_token(key, url=url):
            cleared.append(url)

    return ResetResult(key, institution, deleted=deleted,
                       backup_path=backup_path, plaid_removed=plaid_removed,
                       token_cleared=cleared)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_reset_item.py -k reset -q`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
git add reset_item.py tests/test_reset_item.py
git commit -m "feat(reset): core reset_item sequence (backup, /item/remove, wipe, token clear)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `reset_all`

**Files:**
- Modify: `reset_item.py`
- Modify: `tests/test_reset_item.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_reset_item.py`:

```python
def test_reset_all_resets_every_connection(db, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _seed_item(db, "CHASE")
    _seed_item(db, "SOFI")
    _store_token(db, "CHASE")
    _store_token(db, "SOFI")
    from pydantic import SecretStr
    monkeypatch.setattr(reset_item.plaid_client, "load_tokens",
                        lambda: {"CHASE": SecretStr("a"), "SOFI": SecretStr("b")})
    results = reset_item.reset_all(confirm=True, api=MagicMock())
    assert {r.env_key for r in results} == {"CHASE", "SOFI"}
    assert db.execute("SELECT count(*) FROM transactions").fetchone()[0] == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_reset_item.py::test_reset_all_resets_every_connection -q`
Expected: FAIL with `AttributeError: module 'reset_item' has no attribute 'reset_all'`

- [ ] **Step 3: Implement `reset_all`**

Add to `reset_item.py`:

```python
def reset_all(*, confirm: bool = False, api=None, db_url: str | None = None,
              tokens_url: str | None = None, now=None) -> list:
    api = api or plaid_client.build_api()
    results = []
    for key in list(plaid_client.load_tokens().keys()):
        results.append(
            reset_item(key, confirm=confirm, api=api, db_url=db_url,
                       tokens_url=tokens_url, now=now)
        )
    return results
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_reset_item.py::test_reset_all_resets_every_connection -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add reset_item.py tests/test_reset_item.py
git commit -m "feat(reset): reset_all loops every connection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `restore_from_backup`

**Files:**
- Modify: `reset_item.py`
- Modify: `tests/test_reset_item.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_reset_item.py`:

```python
def test_restore_reinserts_data_rows(db, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _seed_item(db, "CHASE")
    path = reset_item._backup("CHASE", os.environ["DATABASE_URL"],
                              datetime(2026, 6, 14, 10, 45, 0))
    db.execute("DELETE FROM transaction_tags WHERE transaction_id='CHASE_tx'")
    for table in ("transactions", "accounts", "balance_snapshots",
                  "holdings_snapshots", "liabilities_snapshots",
                  "investment_transactions", "sync_state"):
        db.execute(f"DELETE FROM {table} WHERE item_key='CHASE'")
    counts = reset_item.restore_from_backup(path)
    assert counts["transactions"] == 1
    assert db.execute("SELECT count(*) FROM transactions WHERE item_key='CHASE'").fetchone()[0] == 1
    assert db.execute("SELECT count(*) FROM transaction_tags WHERE transaction_id='CHASE_tx'").fetchone()[0] == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_reset_item.py::test_restore_reinserts_data_rows -q`
Expected: FAIL with `AttributeError: module 'reset_item' has no attribute 'restore_from_backup'`

- [ ] **Step 3: Implement `restore_from_backup`**

Add to `reset_item.py`. Postgres casts ISO date/timestamp strings from the JSON
backup into date/timestamp columns automatically, so the string values insert
cleanly.

```python
def restore_from_backup(path: str, *, db_url: str | None = None) -> dict:
    db_url = db_url or storage.database_url()
    with open(path) as fh:
        data = json.load(fh)
    conn = storage.open_db(db_url)
    counts: dict = {}
    try:
        with conn.transaction():
            for table, rows in data["tables"].items():
                inserted = 0
                for row in rows:
                    cols = list(row.keys())
                    collist = ", ".join(cols)
                    placeholders = ", ".join(["%s"] * len(cols))
                    cur = conn.execute(
                        f"INSERT INTO {table} ({collist}) VALUES ({placeholders}) "
                        f"ON CONFLICT DO NOTHING",
                        tuple(row[c] for c in cols),
                    )
                    inserted += cur.rowcount
                counts[table] = inserted
    finally:
        conn.close()
    return counts
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_reset_item.py::test_restore_reinserts_data_rows -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add reset_item.py tests/test_reset_item.py
git commit -m "feat(reset): restore_from_backup re-inserts data rows

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: CLI entrypoint

**Files:**
- Modify: `reset_item.py`
- Modify: `tests/test_reset_item.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_reset_item.py`:

```python
def test_cli_preview_prints_counts_without_confirm(db, capsys, monkeypatch):
    _seed_item(db, "CHASE")
    from pydantic import SecretStr
    monkeypatch.setattr(reset_item.plaid_client, "load_tokens",
                        lambda: {"CHASE": SecretStr("a")})
    rc = reset_item.main(["CHASE"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "DRY RUN" in out
    assert "transactions" in out
    # nothing deleted
    assert db.execute("SELECT count(*) FROM transactions WHERE item_key='CHASE'").fetchone()[0] == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_reset_item.py::test_cli_preview_prints_counts_without_confirm -q`
Expected: FAIL with `AttributeError: module 'reset_item' has no attribute 'main'`

- [ ] **Step 3: Implement `main` + `__main__`**

Add to `reset_item.py`:

```python
def _print_result(result: ResetResult) -> None:
    tag = "DRY RUN" if result.dry_run else "RESET"
    print(f"[{tag}] {result.env_key} ({result.institution or '—'})")
    for table, n in result.deleted.items():
        print(f"    {table:24} {n}")
    if not result.dry_run:
        print(f"    plaid_item: {result.plaid_removed}")
        print(f"    token_cleared_from: {len(result.token_cleared)} store(s)")
        print(f"    backup: {result.backup_path}")
    else:
        print("    (no changes — pass --confirm to execute)")


def main(argv: list | None = None) -> int:
    import argparse
    from dotenv import load_dotenv
    load_dotenv()

    parser = argparse.ArgumentParser(description="Reset a Plaid Item for re-link.")
    parser.add_argument("target", nargs="?",
                        help="env key (e.g. CHASE) or 'restore'")
    parser.add_argument("backup", nargs="?", help="backup file (with 'restore')")
    parser.add_argument("--all", action="store_true", help="reset every connection")
    parser.add_argument("--confirm", action="store_true", help="execute (default is dry run)")
    args = parser.parse_args(argv)

    if args.target == "restore":
        if not args.backup:
            parser.error("restore requires a backup file path")
        counts = restore_from_backup(args.backup)
        print(f"restored from {args.backup}: {counts}")
        return 0

    if args.all:
        for result in reset_all(confirm=args.confirm):
            _print_result(result)
        return 0

    if not args.target:
        parser.error("provide an env key (e.g. CHASE), --all, or 'restore <file>'")

    _print_result(reset_item(args.target, confirm=args.confirm))
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main(sys.argv[1:]))
```

Invoke as: `python reset_item.py CHASE` (dry run), `python reset_item.py CHASE --confirm`, `python reset_item.py --all --confirm`, `python reset_item.py restore resets/CHASE-….json`.

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_reset_item.py::test_cli_preview_prints_counts_without_confirm -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add reset_item.py tests/test_reset_item.py
git commit -m "feat(reset): CLI (preview/confirm/--all/restore)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `POST /reset-item` in link_helper

**Files:**
- Modify: `link_helper.py`
- Modify: `tests/test_link_helper.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_link_helper.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_link_helper.py::test_reset_item_endpoint -q`
Expected: FAIL (404 — route not defined)

- [ ] **Step 3: Add the endpoint to `link_helper.py`**

After the `exchange` endpoint, add:

```python
class ResetReq(BaseModel):
    env_key: str


@app.post("/reset-item")
def reset_item_endpoint(req: ResetReq) -> dict:
    """Retire a Plaid Item and wipe its local state, ready for a fresh re-link."""
    from dataclasses import asdict
    import reset_item
    try:
        result = reset_item.reset_item(req.env_key, confirm=True, api=api)
        return {"ok": True, **asdict(result)}
    except Exception as e:
        return {"ok": False, "error": str(e), "env_key": req.env_key}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_link_helper.py::test_reset_item_endpoint -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add link_helper.py tests/test_link_helper.py
git commit -m "feat(reset): POST /reset-item link_helper endpoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Dashboard — proxy allowlist + Connections button

**Files:**
- Modify: `dashboard/src/app/api/link/[...path]/route.ts`
- Modify: `dashboard/src/app/api/link/route.test.ts`
- Modify: `dashboard/src/app/connections/page.tsx`

- [ ] **Step 1: Write the failing allowlist test**

Append a case to `dashboard/src/app/api/link/route.test.ts` (match the file's existing style):

```ts
it("allows the reset-item route (POST)", async () => {
  const res = await POST(
    new Request("http://x/api/link/reset-item", { method: "POST", body: "{}" }),
    ctx("reset-item"),
  );
  // 502 (upstream unreachable in test) proves it passed the allowlist;
  // a blocked route returns 404 "unknown link_helper path".
  expect(res.status).not.toBe(404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- route.test`
Expected: FAIL (route returns 404 — not yet allowlisted)

- [ ] **Step 3: Add `reset-item` to the proxy allowlist**

In `dashboard/src/app/api/link/[...path]/route.ts`, add to `ROUTES`:

```ts
  "reset-item": { upstream: "reset-item", method: "POST" },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- route.test`
Expected: PASS

- [ ] **Step 5: Add the Connections button (no test — UI wiring)**

In `dashboard/src/app/connections/page.tsx`, add a handler inside the
`Connections` component (near `syncNow`/`linkBank`):

```tsx
  const [resetting, setResetting] = useState<string | null>(null);
  async function resetItem(envKey: string, name: string) {
    if (!window.confirm(
      `Reset ${name}? This removes the Plaid Item (stops billing) and wipes its ` +
      `local history (a JSON backup is written first). You'll re-link it next to ` +
      `pull 24 months.`)) return;
    setResetting(envKey);
    try {
      await linkFetch(`reset-item`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ env_key: envKey }),
      });
      status.mutate();
      await linkBank(); // chain straight into the fresh link flow
    } finally {
      setResetting(null);
    }
  }
```

Then in the institutions table row (the `status.data.institutions.map(...)`),
add a cell with the button, guarded so CSV-import items (no Plaid Item) don't
show it:

```tsx
                      <td className="px-5 py-3">
                        {i.status !== "csv_import" && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => resetItem(i.env_key, i.institution)}
                            disabled={resetting === i.env_key}
                          >
                            {resetting === i.env_key ? "Resetting…" : "Reset & re-link"}
                          </Button>
                        )}
                      </td>
```

Add a matching `<th>` (e.g. empty header or "Actions") to the table head row so
columns line up.

- [ ] **Step 6: Verify the dashboard builds**

Run: `cd dashboard && npm run build`
Expected: build succeeds (no type errors).

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/app/api/link/ dashboard/src/app/connections/page.tsx
git commit -m "feat(reset): dashboard reset-item proxy route + Connections button

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Full-suite verification

- [ ] **Step 1: Run the complete Python suite**

Run: `.venv/bin/python -m pytest -q`
Expected: all pass (DB tests require the `finance-test-pg` container on :5433).

- [ ] **Step 2: Run the dashboard suite**

Run: `cd dashboard && npm test`
Expected: all pass.

- [ ] **Step 3: Confirm the dashboard contract guard still passes**

Run: `.venv/bin/python -m pytest tests/test_dashboard_contract.py -q`
Expected: PASS (reset-item is a link_helper route, not an MCP tool, so the tool allowlist is unaffected).

- [ ] **Step 4: Final review commit (if any cleanup)**

```bash
git status
# commit any stragglers, then the branch is ready for PR.
```

---

## Notes for the implementer

- **Test DB caveat:** the `db` fixture pins both `DATABASE_URL` and `PFM_TOKENS_DATABASE_URL` to the same test Postgres, so the "two store" token clear writes to one DB in tests (the dedupe in `reset_item` collapses them). The isolation guard (`SOFI` untouched) is the real correctness test.
- **psycopg autocommit + `conn.transaction()`:** `storage.open_db` opens with `autocommit=True`; psycopg3's `with conn.transaction():` still issues a proper BEGIN/COMMIT, giving the wipe its atomicity. Do not "simplify" it to bare `execute` calls.
- **Do not** add `/item/remove` retries that could mask a real failure — the abort-on-failure behavior is the safety property (test `test_reset_aborts_when_plaid_remove_fails` locks it in).
- After merge, this is **local-only** (link_helper isn't deployed). Re-linked Items' tokens must still be copied local→Neon for the Lambda to sync them (the same step done for Citibank).
