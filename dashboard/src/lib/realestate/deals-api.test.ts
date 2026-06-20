import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDeals, putDeal, deleteDealReq } from "./deals-api";
import { blankDeal } from "./deals";

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("deals-api", () => {
  it("fetchDeals unwraps the deals array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ deals: [{ id: "a" }] })));
    expect(await fetchDeals()).toEqual([{ id: "a" }]);
  });

  it("putDeal PUTs to the id route and returns the saved deal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ deal: { id: "z" } }));
    vi.stubGlobal("fetch", fetchMock);
    const deal = { ...blankDeal("n"), id: "z" };
    const saved = await putDeal(deal);
    expect(saved).toEqual({ id: "z" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/realestate/deals/z");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PUT" });
  });

  it("throws the server error message on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "boom" }), { status: 502 })),
    );
    await expect(fetchDeals()).rejects.toThrow("boom");
  });

  it("deleteDealReq DELETEs the id route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await deleteDealReq("gone");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/realestate/deals/gone");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "DELETE" });
  });
});
