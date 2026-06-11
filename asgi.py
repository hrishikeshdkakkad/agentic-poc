"""Local ASGI entrypoint for the MCP server, for uvicorn with hot reload.

The local twin of lambda_app.py, minus Mangum and the bearer gate (this
binds localhost only). Running through uvicorn instead of ``python
server.py`` enables ``--reload``, matching how the link_helper dashboard
job runs — so local code edits are picked up instead of a long-running
process silently serving stale code.

    .venv/bin/uvicorn asgi:app --host 127.0.0.1 --port 8000 --reload

Sessions are dropped on reload; MCP clients must reconnect (the Next.js
dashboard's BFF client does this automatically).
"""
from server import mcp

app = mcp.http_app()
