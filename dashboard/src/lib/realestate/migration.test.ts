import { describe, expect, it } from "vitest";
import { parseLegacyStore, needsMigration } from "./migration";
import { DEFAULTS } from "./defaults";

describe("parseLegacyStore", () => {
  it("returns [] for null / empty / malformed input", () => {
    expect(parseLegacyStore(null)).toEqual([]);
    expect(parseLegacyStore("")).toEqual([]);
    expect(parseLegacyStore("{not json")).toEqual([]);
    expect(parseLegacyStore(JSON.stringify({ deals: [] }))).toEqual([]);
  });

  it("parses a v1 store and normalizes each deal's inputs", () => {
    const raw = JSON.stringify({
      currentId: "d1",
      deals: [
        { id: "d1", name: "A", strategy: "sellAll", usdRate: 86, inputs: DEFAULTS, createdAt: 1, updatedAt: 2 },
      ],
    });
    const deals = parseLegacyStore(raw);
    expect(deals).toHaveLength(1);
    expect(deals[0].id).toBe("d1");
    expect(deals[0].inputs.units).toBe(DEFAULTS.units);
    expect(deals[0].createdAt).toBe(1);
  });

  it("upgrades a legacy manoj1/manoj2 deal into an investors array", () => {
    const legacyInputs: Record<string, unknown> = { ...DEFAULTS, manoj1: 8_500_000, manoj2: 7_000_000 };
    delete legacyInputs.investors;
    const raw = JSON.stringify({
      currentId: "d1",
      deals: [
        { id: "d1", name: "Legacy", strategy: "sellAll", usdRate: 86, inputs: legacyInputs, createdAt: 1, updatedAt: 2 },
      ],
    });
    const deals = parseLegacyStore(raw);
    expect(deals[0].inputs.investors[0].id).toBe("manoj");
    expect(deals[0].inputs.investors[0].tranches[0].amount).toBe(8_500_000);
  });
});

describe("needsMigration", () => {
  const d = { id: "x" } as never;
  it("true only when server empty + has legacy + not yet migrated", () => {
    expect(needsMigration([], [d], false)).toBe(true);
  });
  it("false when the server already has deals", () => {
    expect(needsMigration([d], [d], false)).toBe(false);
  });
  it("false when already migrated", () => {
    expect(needsMigration([], [d], true)).toBe(false);
  });
  it("false when there is nothing to migrate", () => {
    expect(needsMigration([], [], false)).toBe(false);
  });
});
