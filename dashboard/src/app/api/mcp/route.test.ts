import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp", () => ({ callMcpTool: vi.fn() }));

import { callMcpTool } from "@/lib/mcp";
import { POST } from "./[tool]/route";

const post = (tool: string, body?: unknown) =>
  POST(
    new Request("http://x/api/mcp/" + tool, {
      method: "POST",
      body: body === undefined ? null : JSON.stringify(body),
    }),
    { params: Promise.resolve({ tool }) },
  );

beforeEach(() => vi.clearAllMocks());

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
});
