import { describe, expect, it } from "vitest";
import { persistMode } from "./use-deals-store";

describe("persistMode", () => {
  it("debounces live field edits", () => {
    expect(persistMode("edit")).toBe("debounce");
  });
  it("persists structural actions immediately", () => {
    expect(persistMode("create")).toBe("immediate");
    expect(persistMode("duplicate")).toBe("immediate");
    expect(persistMode("delete")).toBe("immediate");
    expect(persistMode("reset")).toBe("immediate");
  });
  it("does not hit the DB just to switch the selected deal", () => {
    expect(persistMode("select")).toBe("none");
  });
});
