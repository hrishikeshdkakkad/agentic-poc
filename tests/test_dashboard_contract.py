"""The dashboard BFF must track the MCP server's tool registry.

dashboard/src/lib/tools.ts hard-codes the allowlist of tools its
/api/mcp/[tool] route may call. If a tool is added to (or renamed in)
server.py without updating that list, the dashboard silently loses access —
this test turns that drift into a CI failure. Both sides are parsed from
source so the test needs neither a running server nor node.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _server_tools() -> set[str]:
    src = (ROOT / "server.py").read_text()
    # Every registration reads: mcp.tool(..., name="<tool_name>")(...)
    return set(re.findall(r'name="([a-z_]+)"', src))


def _dashboard_tools() -> set[str]:
    src = (ROOT / "dashboard" / "src" / "lib" / "tools.ts").read_text()
    block = re.search(r"ALLOWED_TOOLS = new Set\(\[(.*?)\]\)", src, re.S)
    assert block, "ALLOWED_TOOLS literal not found in dashboard/src/lib/tools.ts"
    return set(re.findall(r'"([a-z_]+)"', block.group(1)))


def test_registries_parse():
    assert len(_server_tools()) >= 25
    assert len(_dashboard_tools()) >= 25


def test_dashboard_allowlist_matches_server_tools():
    server, dash = _server_tools(), _dashboard_tools()
    assert dash == server, (
        f"dashboard allowlist drift — missing from dashboard: {sorted(server - dash)}; "
        f"unknown to server: {sorted(dash - server)}"
    )
