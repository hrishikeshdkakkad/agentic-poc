"""Verify a deployed personal-finance-mcp endpoint, end to end, tool by tool.

Drives the REMOTE server through a real MCP client (fastmcp Client over
streamable HTTP), exactly the way a Claude agent will:

  1. auth gate: /health open; no token and wrong token both rejected
  2. protocol: initialize, tools/list (expects all 30 tools)
  3. every history/insight tool (answers from Postgres, zero Plaid calls)
  4. every live Plaid tool (proves Plaid creds + decrypted tokens work
     from the deployment)
  5. sync_now (proves the write path into the history store)
  6. statelessness: a second, fresh client session must work identically
     (Lambda gives no session affinity, so this must hold)

The set_category_override write tool is exercised with an inert rule that
matches nothing, then removed directly from the database afterwards.

Usage (reads MCP_REMOTE_URL and MCP_AUTH_TOKEN from .env or env):
    .venv/bin/python verify_remote.py [url]
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from datetime import date, timedelta

import httpx
from dotenv import load_dotenv

from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport

load_dotenv()

URL = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("MCP_REMOTE_URL", "")).strip()
TOKEN = os.environ.get("MCP_AUTH_TOKEN", "").strip()
if not URL or not TOKEN:
    sys.exit("need MCP_REMOTE_URL and MCP_AUTH_TOKEN (in .env or env)")

TODAY = date.today()
D30 = (TODAY - timedelta(days=30)).isoformat()
D14 = (TODAY - timedelta(days=14)).isoformat()
NOW = TODAY.isoformat()
PREV_MONTH = (TODAY.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
PREV_MONTH2 = ((TODAY.replace(day=1) - timedelta(days=1)).replace(day=1)
               - timedelta(days=1)).strftime("%Y-%m")
NOOP_OVERRIDE = "zzz-remote-verify-noop"

# (tool, arguments, assertion: payload -> bool, what the assertion proves)
TOOL_CHECKS: list[tuple[str, dict, object, str]] = [
    # History tools — answered by Postgres, zero Plaid traffic
    ("get_sync_status", {},
     lambda p: p["table_counts"]["transactions"] > 0, "history store reachable"),
    ("describe_tables", {},
     lambda p: "tables" in p or "transactions" in json.dumps(p), "schema docs"),
    ("list_transactions", {"limit": 5},
     lambda p: len(p["transactions"]) > 0 and p["total_matching"] > 0, "stored rows"),
    ("aggregate_spending", {"start_date": "2026-01-01", "end_date": NOW},
     lambda p: "groups" in p or "total" in json.dumps(p), "spend aggregation"),
    ("query_finances", {"sql": "SELECT count(*) AS n FROM transactions"},
     lambda p: p["rows"][0]["n"] > 0 if isinstance(p["rows"][0], dict)
     else p["rows"][0][0] > 0, "read-only SQL"),
    ("get_net_worth_history", {},
     lambda p: "history" in p or "snapshots" in json.dumps(p), "snapshot history"),
    ("get_optimizer_score", {},
     lambda p: "current_month" in p, "Optimizer game"),
    ("get_optimizer_plan", {},
     lambda p: "plan" in p and "directives" in p, "Optimizer planner"),
    ("get_debt_analysis", {},
     lambda p: "debts" in p or "total_debt" in json.dumps(p), "debt analytics"),
    ("get_portfolio_analysis", {},
     lambda p: "positions" in p or "portfolio" in json.dumps(p), "portfolio"),
    ("get_income_analysis", {"months": 3},
     lambda p: "monthly" in json.dumps(p) or "income" in json.dumps(p), "income buckets"),
    ("get_net_worth_trajectory", {"milestone": 100000, "months": 6},
     lambda p: "milestone" in json.dumps(p), "trajectory"),
    ("get_recurring_analysis", {"months": 6},
     lambda p: "streams" in json.dumps(p) or "recurring" in json.dumps(p), "recurring"),
    ("get_merchant_profile", {"merchant": "doordash"},
     lambda p: isinstance(p, dict), "merchant profile"),
    ("compare_periods", {"period_a": PREV_MONTH2, "period_b": PREV_MONTH},
     lambda p: "error" not in p, "period diff"),
    ("get_financial_health", {},
     lambda p: "flags" in json.dumps(p) or "net_worth" in json.dumps(p), "health view"),
    ("list_category_overrides", {},
     lambda p: "overrides" in p, "override rulebook"),
    # applied_to_transactions counts the WHOLE rulebook re-application (the
    # tool re-applies every override after adding one), so only ok+echo are
    # asserted; the rule itself matches nothing.
    ("set_category_override",
     {"match_type": "merchant", "match_value": NOOP_OVERRIDE,
      "note": "remote e2e probe; matches nothing"},
     lambda p: p.get("ok") is True and p.get("match_value") == NOOP_OVERRIDE,
     "write path (inert rule)"),
    # Live Plaid tools — exercised from the deployment with decrypted tokens
    ("get_institutions_status", {},
     lambda p: len(p["items"]) >= 1, "items enumerated"),
    ("list_accounts", {},
     lambda p: len(p["accounts"]) >= 1, "live accounts"),
    ("get_balances", {},
     lambda p: len(p["accounts"]) >= 1, "live balances"),
    ("get_net_worth", {},
     lambda p: "net_worth" in p, "live net worth"),
    ("get_transactions", {"start_date": D30, "end_date": NOW},
     lambda p: "transactions" in p, "live transactions"),
    ("search_transactions", {"query": "a", "start_date": D14, "end_date": NOW},
     lambda p: "transactions" in p, "live search"),
    ("get_recurring_transactions", {},
     lambda p: "inflows" in p and "outflows" in p, "live recurring"),
    ("get_liabilities", {},
     lambda p: "credit" in p, "live liabilities"),
    ("get_investment_holdings", {},
     lambda p: "holdings" in p, "live holdings"),
    ("get_investment_transactions", {"start_date": D30, "end_date": NOW},
     lambda p: "investment_transactions" in p, "live inv. transactions"),
    # Write path into the history store, last (slowest)
    ("sync_now", {},
     lambda p: p["total_transactions_stored"] > 0, "full sync write path"),
]

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  {detail}" if detail else ""))
    if not ok:
        failures.append(name)


def payload_of(result) -> dict:
    if getattr(result, "structured_content", None):
        sc = result.structured_content
        return sc.get("result", sc) if isinstance(sc, dict) else sc
    for block in result.content or []:
        if getattr(block, "type", "") == "text":
            return json.loads(block.text)
    return {}


async def main() -> None:
    base = URL.rsplit("/mcp", 1)[0]

    # -- auth gate ----------------------------------------------------------
    async with httpx.AsyncClient(timeout=30) as http:
        r = await http.get(f"{base}/health")
        check("auth: /health open without token", r.status_code == 200)
        mcp_body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        hdrs = {"content-type": "application/json",
                "accept": "application/json, text/event-stream"}
        r = await http.post(URL, json=mcp_body, headers=hdrs)
        check("auth: request without token rejected", r.status_code == 401,
              f"(HTTP {r.status_code})")
        r = await http.post(URL, json=mcp_body,
                            headers={**hdrs, "authorization": "Bearer wrong-token"})
        check("auth: wrong token rejected", r.status_code == 401,
              f"(HTTP {r.status_code})")

    transport = StreamableHttpTransport(URL, headers={"Authorization": f"Bearer {TOKEN}"})

    # -- protocol + every tool, one client session ---------------------------
    async with Client(transport) as client:
        tools = await client.list_tools()
        check("protocol: tools/list returns all 30 tools", len(tools) == 30,
              f"({len(tools)} tools)")

        for name, args, assertion, proves in TOOL_CHECKS:
            t0 = time.monotonic()
            try:
                result = await client.call_tool(name, args, timeout=200)
                payload = payload_of(result)
                ok = bool(assertion(payload)) and not result.is_error
                detail = f"[{time.monotonic() - t0:5.1f}s] {proves}"
                if name == "get_sync_status":
                    detail += f" {payload.get('table_counts')}"
                if name == "list_accounts" and ok:
                    detail += f" ({len(payload['accounts'])} accounts)"
                if name == "get_institutions_status" and ok:
                    detail += " " + str([
                        (i.get("institution"), i.get("status"))
                        for i in payload.get("items", [])
                    ])
                if name == "sync_now" and ok:
                    detail += f" ({payload.get('total_transactions_stored')} tx stored)"
                check(f"tool: {name}", ok, detail)
            except Exception as e:
                check(f"tool: {name}", False,
                      f"[{time.monotonic() - t0:5.1f}s] {type(e).__name__}: {e}")

    # -- statelessness: a brand-new session must work just as well -----------
    transport2 = StreamableHttpTransport(URL, headers={"Authorization": f"Bearer {TOKEN}"})
    async with Client(transport2) as client2:
        result = await client2.call_tool("get_sync_status", {}, timeout=60)
        payload = payload_of(result)
        check("stateless: fresh second session works",
              payload.get("table_counts", {}).get("transactions", 0) > 0)

    # -- clean up the inert override rule ------------------------------------
    db_url = os.environ.get("DATABASE_URL")
    if db_url:
        import psycopg
        with psycopg.connect(db_url, autocommit=True) as conn:
            cur = conn.execute(
                "DELETE FROM category_overrides WHERE match_value = %s",
                (NOOP_OVERRIDE,),
            )
            check("cleanup: inert override removed", cur.rowcount == 1)

    print()
    total = 5 + len(TOOL_CHECKS) + (1 if db_url else 0)
    if failures:
        print(f"{len(failures)}/{total} FAILED: {failures}")
        raise SystemExit(1)
    print(f"all {total} remote checks passed — endpoint fully verified")


if __name__ == "__main__":
    asyncio.run(main())
