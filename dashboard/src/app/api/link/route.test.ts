import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./[...path]/route";

const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) });

afterEach(() => vi.unstubAllGlobals());

describe("/api/link proxy", () => {
  it("rejects unknown paths", async () => {
    const res = await GET(new Request("http://x/api/link/nope"), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("maps status → upstream /api/status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"institutions":[]}', { headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(new Request("http://x/api/link/status"), ctx("status"));
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:8765/api/status");
  });

  it("rejects GET on POST-only endpoints", async () => {
    const res = await GET(new Request("http://x/api/link/sync"), ctx("sync"));
    expect(res.status).toBe(405);
  });

  it("forwards POST body and returns 502 when link_helper is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const res = await POST(
      new Request("http://x/api/link/sync", { method: "POST" }),
      ctx("sync"),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ service: "link_helper" });
  });

  it("allows the reset-item route (POST)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const res = await POST(
      new Request("http://x/api/link/reset-item", { method: "POST", body: "{}" }),
      ctx("reset-item"),
    );
    expect(res.status).not.toBe(404);
  });
});
