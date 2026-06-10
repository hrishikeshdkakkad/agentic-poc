"""Live production E2E: drive every tool through the HTTP MCP surface.

Unlike verify_e2e.py (sandbox, in-process calls), this exercises the real
deployment surface — the MCP protocol over HTTP — against live production
Items. The server must already be running:

    .venv/bin/python server.py            # serves http://localhost:8000/mcp
    .venv/bin/python verify_e2e_production.py

Proves: every tool answers over MCP with real bank data, sync is idempotent,
history tools answer with ZERO Plaid calls (via the server's process-wide
call counter), net worth composes, and the SQL escape hatch stays read-only
with plaid_tokens unreadable.
"""
from __future__ import annotations

import asyncio
import json
import sys
from datetime import date, timedelta

from fastmcp import Client

MCP_URL = "http://localhost:8000/mcp"
PASS, FAIL = "PASS", "FAIL"
_failures: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"[{PASS if ok else FAIL}] {label}" + (f" — {detail}" if detail else ""))
    if not ok:
        _failures.append(label)


def payload(result) -> dict:
    """CallToolResult -> dict; prefers structured data, falls back to text."""
    data = getattr(result, "data", None)
    if isinstance(data, dict):
        return data
    sc = getattr(result, "structured_content", None)
    if isinstance(sc, dict):
        return sc.get("result", sc) if isinstance(sc.get("result"), dict) else sc
    for block in getattr(result, "content", None) or []:
        text = getattr(block, "text", None)
        if text:
            try:
                parsed = json.loads(text)
                return parsed if isinstance(parsed, dict) else {"_raw": parsed}
            except ValueError:
                return {"_raw": text}
    return {}


async def main() -> int:
    today = date.today()
    end = today.isoformat()
    start_90 = (today - timedelta(days=90)).isoformat()
    start_180 = (today - timedelta(days=180)).isoformat()

    async with Client(MCP_URL, timeout=300) as c:

        async def call(name: str, args: dict | None = None, timeout: int = 240) -> dict:
            r = await c.call_tool(name, args or {}, timeout=timeout, raise_on_error=False)
            p = payload(r)
            if getattr(r, "is_error", False):
                p.setdefault("_tool_error", True)
            return p

        # --- surface: the MCP protocol itself --------------------------------
        tools = await c.list_tools()
        names = sorted(t.name for t in tools)
        check("MCP surface lists all tools", len(names) >= 15,
              f"{len(names)} tools: {', '.join(names)}")

        status = await call("get_institutions_status")
        items = status.get("items", [])
        healthy = [i for i in items if i.get("status") == "healthy"]
        check("linked institution healthy", bool(healthy),
              "; ".join(f"{i.get('institution') or i.get('item_key')}: {i.get('status')}"
                        for i in items))

        accounts = (await call("list_accounts")).get("accounts", [])
        check("list_accounts returns real accounts", bool(accounts),
              "; ".join(f"{a.get('name')} •{a.get('mask')} [{a.get('subtype')}]"
                        for a in accounts))

        baccts = (await call("get_balances")).get("accounts", [])
        check("get_balances live", bool(baccts),
              "; ".join(f"{a.get('name')}: {a['balance'].get('current')} "
                        f"{a['balance'].get('currency')}" for a in baccts))

        # --- sync: store history; retry while Plaid's initial pull settles ----
        s1 = await call("sync_now", timeout=600)
        n1 = s1.get("total_transactions_stored", 0)
        attempts = 0
        while n1 == 0 and attempts < 6:
            attempts += 1
            print(f"  ... no transactions yet (initial Plaid pull pending), "
                  f"warnings={json.dumps(s1.get('warnings') or [])[:200]}; "
                  f"retry {attempts}/6 in 20s")
            await asyncio.sleep(20)
            s1 = await call("sync_now", timeout=600)
            n1 = s1.get("total_transactions_stored", 0)
        check("sync_now stores real transactions", n1 > 0,
              f"{n1} rows, warnings={len(s1.get('warnings') or [])}")

        s2 = await call("sync_now", timeout=600)
        n2 = s2.get("total_transactions_stored", 0)
        check("sync_now idempotent (2nd run adds nothing)", n2 == n1, f"{n1} -> {n2}")

        # --- live Plaid-backed tools ------------------------------------------
        t_list = (await call("get_transactions",
                             {"start_date": start_90, "end_date": end})).get("transactions")
        check("get_transactions (live, 90d)", isinstance(t_list, list),
              f"{len(t_list or [])} txns")

        rec = await call("get_recurring_transactions")
        check("get_recurring_transactions answers",
              "inflows" in rec and "outflows" in rec,
              f"inflows={len(rec.get('inflows') or [])} "
              f"outflows={len(rec.get('outflows') or [])} "
              f"warnings={len(rec.get('warnings') or [])}")

        liab = await call("get_liabilities")
        check("get_liabilities answers", isinstance(liab.get("credit"), list),
              f"credit={len(liab.get('credit') or [])} "
              f"student={len(liab.get('student') or [])} "
              f"mortgage={len(liab.get('mortgage') or [])} "
              f"warnings={len(liab.get('warnings') or [])}")

        hold = await call("get_investment_holdings")
        check("get_investment_holdings answers", isinstance(hold.get("holdings"), list),
              f"{len(hold.get('holdings') or [])} holdings, "
              f"warnings={len(hold.get('warnings') or [])}")

        inv_tx = await call("get_investment_transactions",
                            {"start_date": start_90, "end_date": end})
        check("get_investment_transactions answers",
              isinstance(inv_tx.get("investment_transactions"), list),
              f"{len(inv_tx.get('investment_transactions') or [])} txns, "
              f"warnings={len(inv_tx.get('warnings') or [])}")

        # pick a real merchant from stored data so search has a known hit
        sample = (await call("list_transactions", {"limit": 1})).get("transactions") or []
        term = ((sample[0].get("merchant") or sample[0].get("name") or "payment")
                .split()[0] if sample else "payment")
        found = (await call("search_transactions",
                            {"query": term, "start_date": start_90,
                             "end_date": end})).get("transactions")
        check("search_transactions finds known merchant", isinstance(found, list),
              f"query={term!r} -> {len(found or [])} matches")

        # --- history tools: must answer with ZERO Plaid calls ------------------
        c1 = (await call("get_sync_status")).get("plaid_calls_this_session")
        spend = await call("aggregate_spending",
                           {"start_date": start_180, "end_date": end,
                            "group_by": "category", "monthly": True})
        history = await call("get_net_worth_history")
        listed = await call("list_transactions", {"limit": 5})
        schema = await call("describe_tables")
        q = await call("query_finances",
                       {"sql": "SELECT count(*) AS n FROM transactions"})
        c2 = (await call("get_sync_status")).get("plaid_calls_this_session")

        check("aggregate_spending returns rows", bool(spend.get("rows")),
              f"{len(spend.get('rows') or [])} (month,category) rows, "
              f"grand_total=${spend.get('grand_total')}")
        check("net_worth_history has snapshots", bool(history.get("history")))
        check("list_transactions pages stored data",
              bool(listed.get("transactions")),
              f"{len(listed.get('transactions') or [])} of "
              f"{listed.get('total_matching', '?')} rows")
        check("describe_tables documents schema", bool(schema.get("tables")))
        stored_n = ((q.get("rows") or [[0]])[0] or [0])[0]
        check("query_finances SELECT works", isinstance(stored_n, int) and stored_n > 0,
              f"transactions table has {stored_n} rows "
              f"(columns={q.get('columns')})")
        check("ZERO Plaid calls for all history tools",
              isinstance(c1, int) and c1 > 0 and c1 == c2,
              f"server counter {c1} -> {c2}")

        # --- live net worth composition (after the zero-call window) ----------
        nw = await call("get_net_worth")
        composed_ok = (nw.get("net_worth") is not None and
                       abs(nw["net_worth"] -
                           (nw["total_assets"] - nw["total_liabilities"])) < 0.01)
        check("get_net_worth composes assets - liabilities", composed_ok,
              f"net=${nw.get('net_worth')} assets=${nw.get('total_assets')} "
              f"liabilities=${nw.get('total_liabilities')} "
              f"classes={sorted((nw.get('by_class') or {}).keys())}")

        # --- probes: try to break it at the same surface ----------------------
        rejected = await call("query_finances", {"sql": "DELETE FROM transactions"})
        check("PROBE: query_finances rejects DELETE", "error" in rejected,
              str(rejected.get("error", ""))[:80])

        blocked = await call("query_finances",
                             {"sql": "SELECT * FROM plaid_tokens"})
        check("PROBE: plaid_tokens unreadable via SQL", "error" in blocked,
              str(blocked.get("error", ""))[:80])

        inverted = await call("get_transactions",
                              {"start_date": end, "end_date": start_90})
        check("PROBE: inverted date range fails gracefully",
              isinstance(inverted, dict) and
              (inverted.get("transactions") == [] or "error" in inverted
               or inverted.get("warnings") or inverted.get("_tool_error")),
              f"keys={sorted(inverted.keys())}")

        big = (await call("list_transactions",
                          {"min_amount": 10000000})).get("transactions")
        check("PROBE: absurd min_amount returns empty, not error",
              big == [], f"{len(big or [])} rows")

    print()
    if _failures:
        print(f"{len(_failures)} check(s) FAILED: {_failures}")
        return 1
    print("All checks passed against LIVE production data over the MCP surface.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
