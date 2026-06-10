"""One-command live verification against Plaid Sandbox.

Prereqs: PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV=sandbox (in env or .env).
Links a sandbox Item automatically if none exists, then proves the
acceptance criteria:

  1. one correct answer per category: cash, spending, investments,
     retirement, debt
  2. multi-month spend-by-category-by-month answered from Postgres with
     ZERO Plaid calls (proved via the process-wide call counter)
  3. get_net_worth composes correctly, and a second sync_now run is
     idempotent (no duplicate transactions)

Run:  python verify_e2e.py
"""
from __future__ import annotations

import os
import sys
from datetime import date, timedelta

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

PASS = "PASS"
FAIL = "FAIL"
_failures: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"[{PASS if ok else FAIL}] {label}" + (f" — {detail}" if detail else ""))
    if not ok:
        _failures.append(label)


def main() -> int:
    if os.environ.get("PLAID_ENV", "").lower() != "sandbox":
        print("Set PLAID_ENV=sandbox (plus PLAID_CLIENT_ID / PLAID_SECRET).", file=sys.stderr)
        return 2
    if not os.environ.get("DATABASE_URL"):
        print("Set DATABASE_URL to your Postgres (e.g. Neon) connection string.", file=sys.stderr)
        return 2

    from plaid_client import build_api, all_items, load_tokens, plaid_call_count
    import server as srv
    import sync as sync_mod

    # --- Phase 0: ensure at least one linked sandbox Item -----------------
    if not load_tokens():
        print("No linked Items found; creating a sandbox Item (First Platypus Bank)...")
        from sandbox_link import create_sandbox_item
        info = create_sandbox_item()
        print(f"  linked {info['env_key']}")

    api = build_api()
    healthy = [h for _, _, h in all_items(api) if h.status == "healthy"]
    check("at least one healthy Item", bool(healthy))

    # --- Phase 0: all 9 original tools return sane shapes ------------------
    today = date.today()
    start_90 = (today - timedelta(days=90)).isoformat()
    end = today.isoformat()

    accounts = srv._list_accounts_impl()
    check("list_accounts", bool(accounts["accounts"]), f"{len(accounts['accounts'])} accounts")
    balances = srv._get_balances_impl()
    check("get_balances", bool(balances["accounts"]))
    txns = srv._get_transactions_impl(start_90, end)
    check("get_transactions", isinstance(txns["transactions"], list),
          f"{len(txns['transactions'])} txns in 90d")
    rec = srv._get_recurring_transactions_impl()
    check("get_recurring_transactions", "inflows" in rec and "outflows" in rec)
    liab = srv._get_liabilities_impl()
    check("get_liabilities", any([liab["credit"], liab["student"], liab["mortgage"]]),
          f"credit={len(liab['credit'])} student={len(liab['student'])} mortgage={len(liab['mortgage'])}")
    hold = srv._get_investment_holdings_impl()
    check("get_investment_holdings", bool(hold["holdings"]), f"{len(hold['holdings'])} holdings")
    inv_tx = srv._get_investment_transactions_impl(start_90, end)
    check("get_investment_transactions", isinstance(inv_tx["investment_transactions"], list))
    status = srv._get_institutions_status_impl()
    check("get_institutions_status", bool(status["items"]))
    search = srv._search_transactions_impl("uber", start_90, end)
    check("search_transactions", isinstance(search["transactions"], list),
          f"{len(search['transactions'])} matches for 'uber'")

    # --- Phase 1: sync twice; second run must add nothing ------------------
    r1 = sync_mod.run_sync(api)
    n1 = r1["total_transactions_stored"]
    r2 = sync_mod.run_sync(api)
    n2 = r2["total_transactions_stored"]
    check("sync_now stores transactions", n1 > 0, f"{n1} rows")
    check("sync_now idempotent (no duplicates on 2nd run)", n1 == n2, f"{n1} == {n2}")

    # --- Phase 2: spend by category by month with ZERO Plaid calls ---------
    calls_before = plaid_call_count()
    spend = srv._aggregate_spending_impl(
        (today - timedelta(days=180)).isoformat(), end,
        group_by="category", monthly=True,
    )
    history = srv._get_net_worth_history_impl()
    q = srv._query_finances_impl("SELECT count(*) AS n FROM transactions")
    calls_after = plaid_call_count()
    check("aggregate_spending returns rows", bool(spend["rows"]),
          f"{len(spend['rows'])} (month,category) rows, total ${spend['grand_total']}")
    check("net_worth_history has snapshots", bool(history["history"]))
    check("query_finances works read-only", q.get("rows") is not None)
    check("ZERO Plaid calls for history-db tools", calls_before == calls_after,
          f"counter {calls_before} -> {calls_after}")
    rejected = srv._query_finances_impl("DELETE FROM transactions")
    check("query_finances rejects non-SELECT", "error" in rejected)

    # --- Phase 2: composed net worth ---------------------------------------
    nw = srv._get_net_worth_impl()
    composed_ok = abs(nw["net_worth"] - (nw["total_assets"] - nw["total_liabilities"])) < 0.01
    check("get_net_worth composes assets - liabilities", composed_ok,
          f"net=${nw['net_worth']} assets=${nw['total_assets']} liabilities=${nw['total_liabilities']}")

    # --- One answer per category -------------------------------------------
    print("\n--- Sample answers per category ---")
    by_class = nw["by_class"]
    cash = by_class.get("cash", {}).get("total")
    print(f"cash:        total cash across depository accounts = ${cash}")
    check("category: cash", cash is not None)
    top = max(spend["rows"], key=lambda r: r["total"]) if spend["rows"] else None
    if top:
        print(f"spending:    biggest (month,category) = {top['month']} {top['category']} ${top['total']}")
    check("category: spending", top is not None)
    inv = by_class.get("investments", {}).get("total")
    print(f"investments: taxable investment balance = ${inv}")
    check("category: investments", inv is not None)
    ret = by_class.get("retirement", {}).get("total")
    print(f"retirement:  401k/IRA balance = ${ret}")
    check("category: retirement (401k)", ret is not None)
    debt = nw["total_liabilities"]
    print(f"debt:        total liabilities (credit + loans) = ${debt}")
    check("category: debt", debt is not None)

    print()
    if _failures:
        print(f"{len(_failures)} check(s) FAILED: {_failures}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
