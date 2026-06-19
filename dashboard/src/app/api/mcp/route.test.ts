import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp", () => ({ callMcpTool: vi.fn() }));
// Auth is loaded lazily by callerRoles(); mock it so unit tests run without next-auth.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { callMcpTool } from "@/lib/mcp";
import { auth } from "@/auth";
import { POST } from "./[tool]/route";

const asRoles = (roles: string[] | null) =>
  vi.mocked(auth).mockResolvedValue((roles === null ? null : { user: { roles } }) as never);

const post = (tool: string, body?: unknown) =>
  POST(
    new Request("http://x/api/mcp/" + tool, {
      method: "POST",
      body: body === undefined ? null : JSON.stringify(body),
    }),
    { params: Promise.resolve({ tool }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  asRoles(["admin"]); // default caller is admin unless a test overrides
});

describe("POST /api/mcp/[tool]", () => {
  it("rejects unknown tools", async () => {
    const res = await post("drop_tables", {});
    expect(res.status).toBe(404);
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it("dispatches allowlisted tool with args", async () => {
    vi.mocked(callMcpTool).mockResolvedValue({ net_worth: 1 });
    const res = await post("get_net_worth", { args: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ net_worth: 1 });
    expect(callMcpTool).toHaveBeenCalledWith("get_net_worth", {});
  });

  it("treats empty body as no args", async () => {
    vi.mocked(callMcpTool).mockResolvedValue({ ok: true });
    const res = await post("get_sync_status");
    expect(res.status).toBe(200);
  });

  it("returns 502 with service tag when MCP is down", async () => {
    vi.mocked(callMcpTool).mockRejectedValue(new Error("fetch failed"));
    const res = await post("get_net_worth", {});
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ service: "mcp" });
  });

  // --- RBAC ---
  it("401s when there is no session", async () => {
    asRoles(null);
    const res = await post("get_net_worth", {});
    expect(res.status).toBe(401);
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it("403s when the role lacks the tool (viewer → portfolio)", async () => {
    asRoles(["realestate-viewer"]);
    const res = await post("get_portfolio_analysis", {});
    expect(res.status).toBe(403);
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it("403s a viewer trying raw SQL (query_finances is admin-only)", async () => {
    asRoles(["realestate-viewer"]);
    const res = await post("query_finances", { args: { sql: "SELECT 1" } });
    expect(res.status).toBe(403);
    expect(callMcpTool).not.toHaveBeenCalled();
  });
});
