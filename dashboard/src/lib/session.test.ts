import { describe, it, expect } from "vitest";
import { denyTool, denyPerm } from "./session";

describe("session deny-helpers", () => {
  it("returns a 403 Response when role lacks the tool", () => {
    const res = denyTool(["realestate-viewer"], "query_finances");
    expect(res?.status).toBe(403);
  });
  it("returns null (allowed) when role has the tool", () => {
    expect(denyTool(["admin"], "query_finances")).toBeNull();
    expect(denyTool(["realestate-viewer"], "get_optimizer_plan")).not.toBeNull();
  });
  it("denyPerm gates a raw permission", () => {
    expect(denyPerm(["realestate-viewer"], "realestate:read")).toBeNull();
    expect(denyPerm(["realestate-viewer"], "transactions:read")?.status).toBe(403);
  });
});
