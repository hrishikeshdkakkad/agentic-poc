import { describe, expect, it } from "vitest";
import { usd, signedUsd, fmtDate, fmtDateTime, pct } from "./format";

describe("usd", () => {
  it("formats dollars", () => expect(usd(1234.5)).toBe("$1,234.50"));
  it("handles null", () => expect(usd(null)).toBe("—"));
  it("handles negatives", () => expect(usd(-20)).toBe("-$20.00"));
});

describe("signedUsd (Plaid sign: positive = outflow)", () => {
  // Display convention: spending shown as plain amount, inflows with a +.
  it("outflow", () => expect(signedUsd(42)).toEqual({ text: "$42.00", inflow: false }));
  it("inflow", () => expect(signedUsd(-42)).toEqual({ text: "+$42.00", inflow: true }));
});

describe("fmtDate", () => {
  it("formats ISO date", () => expect(fmtDate("2026-06-11")).toMatch(/2026/));
  it("handles null", () => expect(fmtDate(null)).toBe("—"));
  it("passes through junk", () => expect(fmtDate("not-a-date")).toBe("not-a-date"));
});

describe("fmtDateTime", () => {
  it("handles null", () => expect(fmtDateTime(null)).toBe("—"));
});

describe("pct", () => {
  it("formats", () => expect(pct(12.345)).toBe("12.3%"));
  it("handles null", () => expect(pct(null)).toBe("—"));
});
