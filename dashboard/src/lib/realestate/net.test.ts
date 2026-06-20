import { describe, it, expect } from "vitest";
import { DEFAULTS, DEFAULT_BRIDGE_PRICE, normalizeInputs, type Inputs } from "./defaults";
import { dilutionScenario } from "./reality";
import { netScenario, netSensitivityGrid, netBreakdown } from "./reality";

describe("net (after-debt) layer", () => {
  it("base net scenario equals the hero's dilutionScenario profit exactly", () => {
    const net = netScenario(DEFAULTS, DEFAULTS.baseSaleRate).profit;
    const hero = dilutionScenario(DEFAULTS).profit;
    expect(net).toBe(hero);
  });

  it("base net scenario matches dilutionScenario revenue/roe/margin too", () => {
    const net = netScenario(DEFAULTS, DEFAULTS.baseSaleRate);
    const hero = dilutionScenario(DEFAULTS);
    expect(net.revenue).toBe(hero.revenue);
    expect(net.roe).toBe(hero.roe);
    expect(net.margin).toBe(hero.margin);
  });

  it("net profit increases monotonically bear < base < bull", () => {
    const bear = netScenario(DEFAULTS, DEFAULTS.baseSaleRate * (9_000 / 11_500)).profit;
    const base = netScenario(DEFAULTS, DEFAULTS.baseSaleRate).profit;
    const bull = netScenario(DEFAULTS, DEFAULTS.baseSaleRate * (14_000 / 11_500)).profit;
    expect(bear).toBeLessThan(base);
    expect(base).toBeLessThan(bull);
  });

  it("net sensitivity center cell is finite", () => {
    const { grid, constructionRates, saleRates } = netSensitivityGrid(DEFAULTS);
    const r = Math.floor(constructionRates.length / 2);
    const c = Math.floor(saleRates.length / 2);
    expect(Number.isFinite(grid[r][c])).toBe(true);
  });

  it("grid reconciles to netScenario at the operating rate — even with an edited budget", () => {
    // Replace the itemized budget with a single lumpsum so buildSubtotal diverges
    // from the coarse (constructionRate+extrasRate)·builtUp the grid used to assume.
    const edited: Inputs = {
      ...DEFAULTS,
      constructionExpenses: [
        { id: "lump", category: "Misc", item: "lump", qty: 1, unit: "lumpsum", rate: 50_000_000, amount: 50_000_000, month: 24 },
      ],
    };
    const { grid, constructionRates, saleRates } = netSensitivityGrid(edited);
    const row = constructionRates.indexOf(edited.constructionRate); // 2250 is on the axis
    expect(row).toBeGreaterThanOrEqual(0);
    // The row at the deal's own construction rate must equal the honest net scenario
    // (same itemized basis as the hero) at each sale rate, not a coarse-build figure.
    saleRates.forEach((sale, j) => {
      expect(grid[row][j]).toBeCloseTo(netScenario(edited, sale).profit / 1e7, 6);
    });
  });

  it("net breakdown components sum to net profit", () => {
    const b = netBreakdown(DEFAULTS);
    expect(b.marketSales + b.bridgeSale + b.prebuy).toBeCloseTo(b.revenue, 4);
    expect(b.land + b.build + b.contingency + b.financingInterest).toBeCloseTo(b.cost, 4);
    expect(b.revenue - b.cost - b.capitalReturns).toBeCloseTo(b.netProfit, 4);
  });

  it("net breakdown net profit equals the hero figure", () => {
    expect(netBreakdown(DEFAULTS).netProfit).toBe(dilutionScenario(DEFAULTS).profit);
  });
});

describe("configurable bridge price", () => {
  it("the default deal still uses the ₹1.7 Cr bridge price", () => {
    expect(DEFAULTS.bridgePrice).toBe(DEFAULT_BRIDGE_PRICE);
    expect(netBreakdown(DEFAULTS).bridgeSale).toBe(DEFAULT_BRIDGE_PRICE);
  });

  it("raising the bridge price lifts revenue and profit by exactly that amount", () => {
    const raised: Inputs = { ...DEFAULTS, bridgePrice: 20_000_000 };
    const base = netBreakdown(DEFAULTS);
    const hi = netBreakdown(raised);
    expect(hi.bridgeSale).toBe(20_000_000);
    expect(hi.revenue - base.revenue).toBe(3_000_000); // only the bridge unit moved
    expect(hi.netProfit - base.netProfit).toBe(3_000_000); // cost unchanged
  });

  it("normalizeInputs defaults a missing bridgePrice to ₹1.7 Cr (migration-safe)", () => {
    const legacy = normalizeInputs({ ...DEFAULTS, bridgePrice: undefined });
    expect(legacy.bridgePrice).toBe(DEFAULT_BRIDGE_PRICE);
    // a legacy deal with no stored bridgePrice reproduces the original profit
    expect(netBreakdown(legacy).netProfit).toBe(netBreakdown(DEFAULTS).netProfit);
  });
});
