"""Pre-deploy check: drive lambda_app.handler with synthetic Function URL
events, exactly as AWS will. Run from the repo root:

    MCP_AUTH_TOKEN=local-test .venv/bin/python deploy/test_lambda_local.py

Asserts the auth gate (401 without/with-wrong token, /health open) and the
MCP protocol over the buffered Lambda path (initialize, tools/list,
tools/call). tools/list runs twice on purpose: each Lambda invocation
re-enters the ASGI lifespan, and a warm container must survive the second
entry (the mcp SDK session manager is single-use; FastMCP rebuilds it per
lifespan — this is the regression that would 500 in production).
"""
from __future__ import annotations

import base64
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv

load_dotenv()
os.environ.setdefault("MCP_AUTH_TOKEN", "local-test")
TOKEN = os.environ["MCP_AUTH_TOKEN"]

import lambda_app  # noqa: E402  (import after env is ready: fails closed without token)


def fn_url_event(method: str, path: str, body: dict | None = None,
                 auth: str | None = None) -> dict:
    headers = {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
    }
    if auth is not None:
        headers["authorization"] = auth
    return {
        "version": "2.0",
        "routeKey": "$default",
        "rawPath": path,
        "rawQueryString": "",
        "headers": headers,
        "requestContext": {
            "http": {"method": method, "path": path, "sourceIp": "127.0.0.1",
                     "protocol": "HTTP/1.1", "userAgent": "local-test"},
            "requestId": "local",
            "stage": "$default",
        },
        "body": json.dumps(body) if body is not None else None,
        "isBase64Encoded": False,
    }


def invoke(event: dict) -> tuple[int, dict | str]:
    resp = lambda_app.handler(event, None)
    body = resp.get("body") or ""
    if resp.get("isBase64Encoded"):
        body = base64.b64decode(body).decode()
    try:
        return resp["statusCode"], json.loads(body)
    except (ValueError, TypeError):
        return resp["statusCode"], body


def rpc(method: str, params: dict | None = None, id_: int = 1) -> dict:
    msg: dict = {"jsonrpc": "2.0", "id": id_, "method": method}
    if params is not None:
        msg["params"] = params
    return msg


failures = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))
    if not ok:
        failures.append(name)


status, body = invoke(fn_url_event("GET", "/health"))
check("health open, no auth", status == 200 and body == {"ok": True})

status, _ = invoke(fn_url_event("POST", "/mcp", rpc("tools/list")))
check("no token rejected", status == 401)

status, _ = invoke(fn_url_event("POST", "/mcp", rpc("tools/list"), auth="Bearer wrong"))
check("wrong token rejected", status == 401)

good = f"Bearer {TOKEN}"

status, body = invoke(fn_url_event("POST", "/mcp", rpc("initialize", {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": {"name": "local-test", "version": "0"},
}), auth=good))
server_name = (body.get("result", {}).get("serverInfo", {}) or {}).get("name") \
    if isinstance(body, dict) else None
check("initialize", status == 200 and server_name == "personal-finance-mcp",
      f"status={status} server={server_name}")

for round_ in (1, 2):
    status, body = invoke(fn_url_event("POST", "/mcp", rpc("tools/list", id_=2), auth=good))
    tools = body.get("result", {}).get("tools", []) if isinstance(body, dict) else []
    check(f"tools/list invocation #{round_} (lifespan re-entry)",
          status == 200 and len(tools) == 28, f"status={status} tools={len(tools)}")

status, body = invoke(fn_url_event("POST", f"/t/{TOKEN}/mcp", rpc("tools/list", id_=4)))
tools = body.get("result", {}).get("tools", []) if isinstance(body, dict) else []
check("path-secret URL accepted (claude.ai connector path)",
      status == 200 and len(tools) == 28, f"status={status} tools={len(tools)}")

status, _ = invoke(fn_url_event("POST", "/t/wrong-secret/mcp", rpc("tools/list", id_=5)))
check("wrong path-secret rejected", status == 401)

status, body = invoke(fn_url_event("POST", "/mcp", rpc("tools/call", {
    "name": "get_sync_status", "arguments": {},
}, id_=3), auth=good))
payload = {}
if isinstance(body, dict):
    sc = body.get("result", {}).get("structuredContent")
    if sc:
        payload = sc
    else:
        content = body.get("result", {}).get("content") or []
        if content and content[0].get("type") == "text":
            payload = json.loads(content[0]["text"])
check("tools/call get_sync_status hits the history DB",
      status == 200 and "table_counts" in payload,
      f"tables={payload.get('table_counts')}")

print()
if failures:
    print(f"{len(failures)} FAILED: {failures}")
    raise SystemExit(1)
print("all local lambda checks passed")
