// Proves the provenance trees reconcile to the rupee and never drift from the
// engine. The core contract of "cent-accurate drill-downs": every `sum` node
// equals the sum of its children, and each tree root equals the engine figure
// it claims to explain.

import { describe, expect, it } from "vitest";
import { DEFAULTS, normalizeInputs, type Inputs } from "./defaults";
import { totalCost, buildSubtotal, landSubtotal } from "./model";
import { netBreakdown, correctedAnnualIrrByMode } from "./reality";
import {
  costTrace,
  revenueTrace,
  netProfitTrace,
  irrTrace,
  type TraceNode,
} from "./trace";

/** Walk the tree; every `sum` node must equal Σ children.value to the rupee. */
function expectSumsReconcile(node: TraceNode) {
  if (node.op === "sum" && node.children?.length) {
    const sum = node.children.reduce((s, c) => s + c.value, 0);
    expect(Math.abs(node.value - sum)).toBeLessThan(0.5);
  }
  node.children?.forEach(expectSumsReconcile);
}

const find = (node: TraceNode, key: string): TraceNode | undefined => {
  if (node.key === key) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, key);
    if (hit) return hit;
  }
  return undefined;
};

// A deliberately awkward deal: fractional rates and a unit count that doesn't
// divide the built-up area evenly, so products (contingency, carry) and per-unit
// revenue are non-integer. Reconciliation must still hold within ₹0.5.
const stress: Inputs = normalizeInputs({
  ...DEFAULTS,
  units: 7,
  contingencyPct: 0.037,
  loanRate: 0.0825,
  loanMonths: 18,
  baseSaleRate: 11_750,
});

const fullEmi: Inputs = normalizeInputs({ ...DEFAULTS, repayment: "fullEMI", loanTenureYears: 3 });

describe("trace reconciliation — every sum node sums to the rupee", () => {
  for (const [name, i] of [
    ["SMV default", DEFAULTS],
    ["stress (fractional)", stress],
    ["full-EMI", fullEmi],
  ] as const) {
    it(`${name}: cost / revenue / net-profit trees reconcile`, () => {
      expectSumsReconcile(costTrace(i));
      expectSumsReconcile(revenueTrace(i));
      expectSumsReconcile(netProfitTrace(i));
    });
  }
});

describe("trace roots equal the engine figures they explain", () => {
  it("cost tree root == totalCost (and the parity ₹5,96,26,000 default)", () => {
    expect(costTrace(DEFAULTS).value).toBe(totalCost(DEFAULTS));
    expect(costTrace(DEFAULTS).value).toBe(59_626_000);
  });

  it("revenue root == netBreakdown.revenue", () => {
    expect(revenueTrace(DEFAULTS).value).toBe(netBreakdown(DEFAULTS).revenue);
  });

  it("net-profit root == netBreakdown.netProfit, and == revenue − cost − capReturns", () => {
    const t = netProfitTrace(DEFAULTS);
    const b = netBreakdown(DEFAULTS);
    expect(t.value).toBe(b.netProfit);
    const [rev, cost, cap] = t.children!;
    expect(Math.abs(t.value - (rev.value - cost.value - cap.value))).toBeLessThan(0.5);
  });
});

describe("integer subtrees reconcile EXACTLY (whole-rupee line items)", () => {
  it("land = exact sum of its 4 source leaves", () => {
    const land = find(costTrace(DEFAULTS), "land")!;
    const sum = land.children!.reduce((s, c) => s + c.value, 0);
    expect(sum).toBe(landSubtotal(DEFAULTS));
    expect(sum).toBe(land.value);
  });

  it("build = exact sum of categories, each = exact sum of its line items", () => {
    const build = find(costTrace(DEFAULTS), "build")!;
    expect(build.op).toBe("sum");
    const catSum = build.children!.reduce((s, c) => s + c.value, 0);
    expect(catSum).toBe(buildSubtotal(DEFAULTS));
    for (const cat of build.children!) {
      const itemSum = cat.children!.reduce((s, it) => s + it.value, 0);
      expect(itemSum).toBe(cat.value);
    }
  });

  it("every construction line item appears exactly once across the build tree", () => {
    const build = find(costTrace(DEFAULTS), "build")!;
    const leafKeys = build.children!.flatMap((c) => c.children!.map((it) => it.key));
    expect(leafKeys.length).toBe(DEFAULTS.constructionExpenses.length);
    expect(new Set(leafKeys).size).toBe(leafKeys.length);
  });
});

describe("revenue tree drills into the area + price math", () => {
  const r = revenueTrace(DEFAULTS);

  it("market sales = full-market units × unit value, with the plot→FAR→per-unit chain", () => {
    expect(find(r, "rev:market:units")!.value).toBe(2); // 4 total − 1 pre-bought − 1 bridge
    expect(find(r, "builtUp")!.value).toBe(7200); // 2400 × FAR 3
    expect(find(r, "perUnit")!.value).toBe(1800); // 7200 ÷ 4 units
    expect(find(r, "rev:market:unitval")!.value).toBeCloseTo(11_500 * 1800, 6); // ₹2.07 Cr
    expect(find(r, "rev:market")!.value).toBeCloseTo(2 * 11_500 * 1800, 0); // ₹4.14 Cr
    expect(find(r, "spec:plot")!.value).toBe(DEFAULTS.plotArea);
    expect(find(r, "spec:far")!.value).toBe(DEFAULTS.far);
  });

  it("bridge node carries the configurable price; pre-buy reconciles to investor tranches", () => {
    expect(find(r, "rev:bridge")!.value).toBe(DEFAULTS.bridgePrice); // 1 unit × ₹1.7 Cr
    const prebuy = find(r, "rev:prebuy")!;
    expect(prebuy.op).toBe("sum");
    expect(find(r, "rev:prebuy:manoj")!.value).toBe(15_500_000); // ₹85L + ₹70L
    expect(prebuy.children!.reduce((s, c) => s + c.value, 0)).toBe(prebuy.value);
  });

  it("the bridge price flows through to the tree", () => {
    const raised = revenueTrace({ ...DEFAULTS, bridgePrice: 20_000_000 });
    expect(find(raised, "rev:bridge")!.value).toBe(20_000_000);
    expect(raised.value).toBe(revenueTrace(DEFAULTS).value + 3_000_000); // revenue tracks it
  });
});

describe("IRR tree is a separate, annotated basis", () => {
  it("value matches the canonical IRR function (corrected, base rate)", () => {
    const t = irrTrace(DEFAULTS, { corrected: true });
    expect(t.value).toBe(correctedAnnualIrrByMode(DEFAULTS, DEFAULTS.baseSaleRate));
    expect(t.children).toHaveLength(9); // CF_MONTHS
  });

  it("annotates the ₹7,50,000 M3 prep outflow not in total cost", () => {
    expect(irrTrace(DEFAULTS, { corrected: true }).note).toMatch(/7,50,000|750/);
  });

  it("full-EMI corrected IRR tree value matches the EMI-schedule IRR", () => {
    const t = irrTrace(fullEmi, { corrected: true });
    expect(t.value).toBe(correctedAnnualIrrByMode(fullEmi, fullEmi.baseSaleRate));
  });
});
