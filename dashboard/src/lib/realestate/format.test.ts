import { describe, expect, it } from "vitest";
import { compactInr, inrToUsd } from "./format";

describe("inrToUsd magnitude boundaries", () => {
  it("promotes to $M instead of rendering $1000K just under a million", () => {
    // $999,600 rounds to 1000K → must show as $1.00M, not $1000K
    expect(inrToUsd(999_600, 1)).toBe("$1.00M");
    expect(inrToUsd(999_400, 1)).toBe("$999K"); // genuinely below the rounding boundary
    expect(inrToUsd(1_000_000, 1)).toBe("$1.00M");
  });
  it("handles K and unit ranges and sign", () => {
    expect(inrToUsd(12_300, 1)).toBe("$12K");
    expect(inrToUsd(-999_600, 1)).toBe("-$1.00M");
    expect(inrToUsd(500, 1)).toBe("$500");
  });
  it("guards bad inputs", () => {
    expect(inrToUsd(NaN, 86)).toBe("—");
    expect(inrToUsd(1000, 0)).toBe("—");
  });
});

describe("compactInr magnitude boundaries", () => {
  it("promotes to Cr instead of rendering ₹100L just under a crore", () => {
    // ₹99.6 L rounds to 100L → must show as ₹1.0Cr, not ₹100L
    expect(compactInr(9_960_000)).toBe("₹1.0Cr");
    expect(compactInr(9_900_000)).toBe("₹99L"); // genuinely below the rounding boundary
    expect(compactInr(10_000_000)).toBe("₹1.0Cr");
  });
});
