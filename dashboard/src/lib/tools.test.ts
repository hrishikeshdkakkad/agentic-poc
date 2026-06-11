import { describe, expect, it } from "vitest";
import { ALLOWED_TOOLS, parseToolResult } from "./tools";

describe("ALLOWED_TOOLS", () => {
  it("contains the read tools and allowed writes", () => {
    for (const t of ["get_net_worth", "list_transactions", "query_finances",
                     "sync_now", "set_category_override"]) {
      expect(ALLOWED_TOOLS.has(t)).toBe(true);
    }
  });
  it("never exposes unknown names", () => {
    expect(ALLOWED_TOOLS.has("drop_tables")).toBe(false);
  });
});

describe("parseToolResult", () => {
  it("prefers structuredContent", () => {
    expect(parseToolResult({ structuredContent: { a: 1 }, content: [] })).toEqual({ a: 1 });
  });
  it("falls back to text JSON", () => {
    expect(parseToolResult({ content: [{ type: "text", text: '{"b":2}' }] })).toEqual({ b: 2 });
  });
  it("throws on empty result", () => {
    expect(() => parseToolResult({ content: [] })).toThrow();
  });
});
