import { describe, it, expect } from "vitest";
import {
  permissionsForRoles, can, isAdmin, canUseTool, canAccessPage, allowedPages,
} from "./rbac";

describe("rbac", () => {
  const admin = permissionsForRoles(["admin"]);
  const viewer = permissionsForRoles(["realestate-viewer"]);
  const none = permissionsForRoles([]);

  it("admin is wildcard and can do everything", () => {
    expect(isAdmin(admin)).toBe(true);
    expect(can(admin, "transactions:read")).toBe(true);
    expect(canUseTool(admin, "query_finances")).toBe(true);
    expect(canAccessPage(admin, "/transactions")).toBe(true);
  });

  it("realestate-viewer is scoped to real estate only", () => {
    expect(isAdmin(viewer)).toBe(false);
    expect(can(viewer, "realestate:read")).toBe(true);
    expect(canAccessPage(viewer, "/real-estate")).toBe(true);
    expect(canAccessPage(viewer, "/transactions")).toBe(false);
    expect(canAccessPage(viewer, "/")).toBe(false);
    expect(allowedPages(viewer)).toEqual(["/real-estate"]);
  });

  it("viewer cannot reach the real-estate context strip's tools", () => {
    expect(canUseTool(viewer, "get_net_worth_history")).toBe(false);
    expect(canUseTool(viewer, "get_portfolio_analysis")).toBe(false);
  });

  it("raw SQL tools are admin-only", () => {
    expect(canUseTool(viewer, "query_finances")).toBe(false);
    expect(canUseTool(none, "describe_tables")).toBe(false);
    expect(canUseTool(admin, "describe_tables")).toBe(true);
  });

  it("unknown tools and unknown pages are denied by default", () => {
    expect(canUseTool(viewer, "rm_minus_rf")).toBe(false);
    expect(canUseTool(admin, "rm_minus_rf")).toBe(false);
    expect(canAccessPage(none, "/")).toBe(false);
  });

  it("no roles grants nothing", () => {
    expect(can(none, "realestate:read")).toBe(false);
    expect(allowedPages(none)).toEqual([]);
  });
});
