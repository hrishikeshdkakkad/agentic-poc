import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/realestate/db", () => ({
  listDeals: vi.fn(),
  upsertDeal: vi.fn(),
  deleteDeal: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { listDeals, upsertDeal, deleteDeal } from "@/lib/realestate/db";
import { auth } from "@/auth";
import { GET } from "./deals/route";
import { PUT, DELETE } from "./deals/[id]/route";
import { DEFAULTS } from "@/lib/realestate/defaults";

const asRoles = (roles: string[] | null) =>
  vi.mocked(auth).mockResolvedValue((roles === null ? null : { user: { roles } }) as never);

const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
beforeEach(() => {
  vi.clearAllMocks();
  asRoles(["admin"]);
});

describe("GET /api/realestate/deals", () => {
  it("returns the deal list", async () => {
    vi.mocked(listDeals).mockResolvedValue([{ id: "a" } as never]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deals: [{ id: "a" }] });
  });

  it("502 with service tag when the DB is down", async () => {
    vi.mocked(listDeals).mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await GET();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ service: "realestate-db" });
  });

  it("realestate-viewer may read deals (realestate:read)", async () => {
    asRoles(["realestate-viewer"]);
    vi.mocked(listDeals).mockResolvedValue([]);
    expect((await GET()).status).toBe(200);
  });

  it("401s an unauthenticated reader", async () => {
    asRoles(null);
    expect((await GET()).status).toBe(401);
    expect(listDeals).not.toHaveBeenCalled();
  });
});

describe("PUT /api/realestate/deals/[id]", () => {
  it("upserts a deal built from the path id + body", async () => {
    vi.mocked(upsertDeal).mockImplementation(async (d) => d);
    const body = { name: "X", strategy: "hold1", usdRate: 84, inputs: DEFAULTS, createdAt: 5 };
    const res = await PUT(
      new Request("http://x/api/realestate/deals/pid", { method: "PUT", body: JSON.stringify(body) }),
      idCtx("pid"),
    );
    expect(res.status).toBe(200);
    const saved = (await res.json()).deal;
    expect(saved.id).toBe("pid");
    expect(saved.name).toBe("X");
    expect(vi.mocked(upsertDeal)).toHaveBeenCalledOnce();
  });

  it("allows a realestate-viewer to write a deal (shared workspace: realestate:write granted)", async () => {
    asRoles(["realestate-viewer"]);
    vi.mocked(upsertDeal).mockImplementation(async (d) => d);
    const res = await PUT(
      new Request("http://x/api/realestate/deals/pid", { method: "PUT", body: JSON.stringify({ inputs: DEFAULTS }) }),
      idCtx("pid"),
    );
    expect(res.status).toBe(200);
    expect(upsertDeal).toHaveBeenCalledOnce();
  });

  it("still 401s an unauthenticated writer", async () => {
    asRoles(null);
    const res = await PUT(
      new Request("http://x/api/realestate/deals/pid", { method: "PUT", body: JSON.stringify({ inputs: DEFAULTS }) }),
      idCtx("pid"),
    );
    expect(res.status).toBe(401);
    expect(upsertDeal).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON body", async () => {
    const res = await PUT(
      new Request("http://x/api/realestate/deals/pid", { method: "PUT", body: "not json" }),
      idCtx("pid"),
    );
    expect(res.status).toBe(400);
    expect(upsertDeal).not.toHaveBeenCalled();
  });

  it("502 when the write fails", async () => {
    vi.mocked(upsertDeal).mockRejectedValue(new Error("write failed"));
    const res = await PUT(
      new Request("http://x/api/realestate/deals/pid", {
        method: "PUT",
        body: JSON.stringify({ inputs: DEFAULTS }),
      }),
      idCtx("pid"),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ service: "realestate-db" });
  });
});

describe("DELETE /api/realestate/deals/[id]", () => {
  it("deletes and returns ok", async () => {
    vi.mocked(deleteDeal).mockResolvedValue();
    const res = await DELETE(new Request("http://x", { method: "DELETE" }), idCtx("gone"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deleteDeal).toHaveBeenCalledWith("gone");
  });
});
