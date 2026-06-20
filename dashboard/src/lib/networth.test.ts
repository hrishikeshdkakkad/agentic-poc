import { describe, expect, it } from "vitest";
import { latestNetWorth } from "./networth";

describe("latestNetWorth", () => {
  it("returns null when history is missing or empty", () => {
    expect(latestNetWorth(undefined)).toBeNull();
    expect(latestNetWorth(null)).toBeNull();
    expect(latestNetWorth({ history: [] })).toBeNull();
  });

  it("picks the most-recent snapshot regardless of array order", () => {
    const h = {
      history: [
        { date: "2026-06-14", net_worth: 271_739.76 },
        { date: "2026-06-16", net_worth: 275_579.13 },
        { date: "2026-06-15", net_worth: 272_216.16 },
      ],
    };
    expect(latestNetWorth(h)).toBe(275_579.13);
  });
});
