"""AWS Lambda entrypoint: the MCP server over stateless streamable HTTP.

Chain: Lambda Function URL (buffered) -> Mangum (event->ASGI) -> bearer
gate -> FastMCP app.

- ``stateless_http=True``: every JSON-RPC POST is self-contained, so a
  request can land on any Lambda container — no session affinity exists.
- ``json_response=True``: plain application/json responses instead of SSE,
  so a buffered Function URL never holds a stream open.
- Mangum re-enters the ASGI lifespan on every invocation; FastMCP builds a
  fresh StreamableHTTPSessionManager per lifespan entry, so warm containers
  never trip the mcp SDK's run-once guard.

Auth: every request must send ``Authorization: Bearer $MCP_AUTH_TOKEN``.
``GET /health`` is the one open path (it returns no data) so connectivity
can be checked without the secret. The gate fails closed: with no
MCP_AUTH_TOKEN in the environment the module refuses to import rather than
serve financial data unauthenticated.

Required env vars (see deploy/deploy.sh): MCP_AUTH_TOKEN, PLAID_CLIENT_ID,
PLAID_SECRET, PLAID_ENV, DATABASE_URL, FERNET_KEY, HORIZON=1. Plaid token
ciphertext is read from the plaid_tokens table in DATABASE_URL (leave
PFM_TOKENS_DATABASE_URL unset); only FERNET_KEY can decrypt it.
"""
from __future__ import annotations

import os
import secrets

from mangum import Mangum

from server import mcp

_AUTH_TOKEN = os.environ.get("MCP_AUTH_TOKEN", "").strip()
if not _AUTH_TOKEN:
    raise RuntimeError(
        "MCP_AUTH_TOKEN is not set; refusing to serve the MCP endpoint "
        "without an auth gate"
    )


async def _send_plain(send, status: int, body: bytes,
                      extra_headers: list[tuple[bytes, bytes]] | None = None) -> None:
    headers = [(b"content-type", b"application/json")] + (extra_headers or [])
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


class BearerGate:
    """ASGI wrapper enforcing a constant-time bearer-token check."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        if scope.get("path") == "/health":
            await _send_plain(send, 200, b'{"ok": true}')
            return
        supplied = b""
        for key, value in scope.get("headers") or []:
            if key == b"authorization":
                supplied = value
                break
        expected = f"Bearer {_AUTH_TOKEN}".encode()
        if not secrets.compare_digest(supplied, expected):
            await _send_plain(
                send, 401,
                b'{"error": "unauthorized", "detail": '
                b'"send Authorization: Bearer <MCP_AUTH_TOKEN>"}',
                [(b"www-authenticate", b"Bearer")],
            )
            return
        await self.app(scope, receive, send)


app = BearerGate(mcp.http_app(stateless_http=True, json_response=True))

handler = Mangum(app, lifespan="auto")
