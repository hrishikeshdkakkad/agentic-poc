import { describe, expect, it } from "vitest";
import { rowToDeal, dealFromPayload, dealToInsertParams, type DealRow } from "./db-serialize";
import { DEFAULTS } from "./defaults";

const row: DealRow = {
  id: "abc12345",
  name: "SMV Layout",
  strategy: "sellAll",
  usd_rate: 86,
  inputs: DEFAULTS,
  created_at: new Date(1_700_000_000_000),
  updated_at: new Date(1_700_000_500_000),
};

describe("rowToDeal", () => {
  it("maps a DB row to a Deal with epoch-ms timestamps", () => {
    const d = rowToDeal(row);
    expect(d.id).toBe("abc12345");
    expect(d.createdAt).toBe(1_700_000_000_000);
    expect(d.updatedAt).toBe(1_700_000_500_000);
    expect(d.usdRate).toBe(86);
    expect(d.inputs.units).toBe(DEFAULTS.units);
  });

  it("coerces unknown strategy to sellAll and numeric-string usd_rate", () => {
    const d = rowToDeal({ ...row, strategy: "garbage", usd_rate: "90" });
    expect(d.strategy).toBe("sellAll");
    expect(d.usdRate).toBe(90);
  });
});

describe("dealFromPayload", () => {
  it("takes id from the path and normalizes the body inputs", () => {
    const d = dealFromPayload("path-id", {
      name: "Edited",
      strategy: "hold1",
      usdRate: 84,
      inputs: { ...DEFAULTS, units: 6 },
      createdAt: 123,
    });
    expect(d.id).toBe("path-id");
    expect(d.name).toBe("Edited");
    expect(d.strategy).toBe("hold1");
    expect(d.usdRate).toBe(84);
    expect(d.inputs.units).toBe(6);
    expect(d.createdAt).toBe(123);
    expect(typeof d.updatedAt).toBe("number");
  });

  it("falls back to safe defaults for a junk body", () => {
    const d = dealFromPayload("x", null);
    expect(d.name).toBe("Untitled deal");
    expect(d.strategy).toBe("sellAll");
    expect(d.inputs.units).toBe(DEFAULTS.units);
  });
});

describe("dealToInsertParams", () => {
  it("produces positional params with inputs JSON-stringified", () => {
    const params = dealToInsertParams(rowToDeal(row));
    expect(params[0]).toBe("abc12345");
    expect(params[3]).toBe(86);
    expect(typeof params[4]).toBe("string");
    expect(JSON.parse(params[4]).units).toBe(DEFAULTS.units);
    expect(params[5]).toBeInstanceOf(Date);
  });

  it("serializes baseline as the last param (null when absent)", () => {
    expect(dealToInsertParams(rowToDeal(row))[6]).toBeNull();
  });
});

describe("baseline round-trips through write → read", () => {
  it("survives normalize on both the deal and the nested baseline inputs", () => {
    const deal = rowToDeal({
      ...row,
      baseline: {
        name: "Approved budget",
        pinnedAt: 1_700_000_900_000,
        inputs: { ...DEFAULTS, baseSaleRate: 11_000, units: 5 },
      },
    });
    expect(deal.baseline?.name).toBe("Approved budget");
    expect(deal.baseline?.inputs.baseSaleRate).toBe(11_000);
    expect(deal.baseline?.inputs.units).toBe(5);

    // Round-trip: stringify (as the DB column would store) → read back.
    const baselineJson = dealToInsertParams(deal)[6] as string;
    const reread = rowToDeal({ ...row, baseline: JSON.parse(baselineJson) });
    expect(reread.baseline?.inputs.baseSaleRate).toBe(11_000);
    expect(reread.baseline?.inputs.units).toBe(5);
    expect(reread.baseline?.name).toBe("Approved budget");
  });

  it("absent baseline stays undefined", () => {
    expect(rowToDeal(row).baseline).toBeUndefined();
    expect(rowToDeal({ ...row, baseline: null }).baseline).toBeUndefined();
  });
});
