// Covers the three workspace additions: actuals (normalize + planned-vs-actual),
// category ops, and copy-budget-across-deals. Engine parity must stay intact.
import { describe, expect, it } from "vitest";
import { DEFAULTS, normalizeInputs, cloneInputs, type Inputs } from "./defaults";
import { compute } from "./model";
import { normalizeActualExpenses, blankActual, isBlankActual, meaningfulActualsCount } from "./actuals-defaults";
import { actualsTotal, plannedVsActual, actualsForItem } from "./actuals";
import { copyConstructionBudget, type Store, type Deal } from "./deals";
import { renameCategory, removeCategory, addCategoryLine } from "./construction";
import { sumExpenses } from "./construction-defaults";

describe("actuals normalization", () => {
  it("defaults to [] and coerces fields", () => {
    expect(normalizeActualExpenses(undefined)).toEqual([]);
    expect(normalizeActualExpenses("nope")).toEqual([]);
    const [a] = normalizeActualExpenses([
      { name: "Cement", amount: -5, status: "weird", date: "2026-06-01", url: "http://x" },
    ]);
    expect(a.name).toBe("Cement");
    expect(a.amount).toBe(0); // negative floored
    expect(a.status).toBe("paid"); // invalid status → paid
    expect(a.url).toBe("http://x");
    expect(typeof a.id).toBe("string");
  });
  it("normalizeInputs carries actuals; the engine ignores them (parity)", () => {
    const i = normalizeInputs({
      ...DEFAULTS,
      actualExpenses: [{ name: "X", amount: 1000, category: "Electrical" }],
    } as unknown as Partial<Inputs>);
    expect(i.actualExpenses).toHaveLength(1);
    expect(compute(i, "sellAll").totalCost).toBe(59_626_000);
  });
  it("cloneInputs deep-clones actuals", () => {
    const src: Inputs = { ...DEFAULTS, actualExpenses: [blankActual("Electrical")] };
    const c = cloneInputs(src);
    expect(c.actualExpenses).not.toBe(src.actualExpenses);
    expect(c.actualExpenses[0]).not.toBe(src.actualExpenses[0]);
  });
});

describe("planned vs actual", () => {
  const i: Inputs = {
    ...DEFAULTS,
    actualExpenses: [
      { id: "a1", name: "Steel order 1", amount: 1_000_000, date: "", category: "RCC — reinforcement steel", status: "paid", createdAt: 0 },
      { id: "a2", name: "Steel order 2", amount: 1_200_000, date: "", category: "RCC — reinforcement steel", status: "paid", createdAt: 0 },
      { id: "a3", name: "Misc permit", amount: 50_000, date: "", category: "Off-budget thing", status: "paid", createdAt: 0 },
    ],
  };
  it("sums actuals", () => expect(actualsTotal(i)).toBe(2_250_000));
  it("rolls up budgeted vs actual per category", () => {
    const steel = plannedVsActual(i).rows.find((r) => r.category === "RCC — reinforcement steel")!;
    expect(steel.budgeted).toBe(2_050_000);
    expect(steel.actual).toBe(2_200_000);
    expect(steel.variance).toBe(150_000);
  });
  it("appends actual-only categories after budget ones, with totals", () => {
    const pva = plannedVsActual(i);
    const off = pva.rows.find((r) => r.category === "Off-budget thing")!;
    expect(off.budgeted).toBe(0);
    expect(off.actual).toBe(50_000);
    expect(pva.totalActual).toBe(2_250_000);
    expect(pva.totalBudget).toBe(20_520_000);
  });
  it("links actuals to a specific budget line item", () => {
    const withItem: Inputs = {
      ...DEFAULTS,
      actualExpenses: [{ id: "x", name: "y", amount: 1, date: "", expenseId: "steel-found", status: "paid", createdAt: 0 }],
    };
    expect(actualsForItem(withItem, "steel-found")).toHaveLength(1);
    expect(actualsForItem(withItem, "nope")).toHaveLength(0);
  });
});

describe("blank-actual hygiene (no phantom ₹0 rows persisted or counted)", () => {
  it("flags a freshly-added blank row as blank (only a default category, nothing entered)", () => {
    expect(isBlankActual(blankActual("Preliminaries & site setup"))).toBe(true);
    expect(isBlankActual(blankActual())).toBe(true);
  });
  it("treats any real content as non-blank — amount, name, vendor, date, ref, url, or notes", () => {
    const base = blankActual("X");
    expect(isBlankActual({ ...base, amount: 10_000 })).toBe(false);
    expect(isBlankActual({ ...base, name: "Steel order 1" })).toBe(false);
    expect(isBlankActual({ ...base, vendor: "HDFC Bank" })).toBe(false);
    expect(isBlankActual({ ...base, date: "2026-06-19" })).toBe(false);
    expect(isBlankActual({ ...base, reference: "INV-1" })).toBe(false);
    expect(isBlankActual({ ...base, url: "http://x" })).toBe(false);
    expect(isBlankActual({ ...base, description: "note" })).toBe(false);
  });
  it("normalizeActualExpenses prunes fully-blank rows but keeps real ones", () => {
    const rows = normalizeActualExpenses([
      { name: "", amount: 0, category: "Preliminaries & site setup", status: "paid" }, // phantom → drop
      { name: "Loan processing fee", amount: 10_000, status: "paid" }, // keep
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Loan processing fee");
  });
  it("keeps an amount-0 row that carries a name (a legitimately pending placeholder)", () => {
    const rows = normalizeActualExpenses([{ name: "Awaiting invoice", amount: 0, status: "pending" }]);
    expect(rows).toHaveLength(1);
  });
  it("meaningfulActualsCount ignores blank rows (drives the Actuals (N) badge)", () => {
    expect(
      meaningfulActualsCount([{ ...blankActual("X"), name: "Real", amount: 10_000 }, blankActual("X")]),
    ).toBe(1);
  });
});

describe("category workspace ops", () => {
  it("renames a category across its items, amounts unchanged", () => {
    const renamed = renameCategory(DEFAULTS.constructionExpenses, "Electrical", "Electrical & low-voltage");
    expect(renamed.some((e) => e.category === "Electrical")).toBe(false);
    expect(renamed.filter((e) => e.category === "Electrical & low-voltage").length).toBeGreaterThan(0);
    expect(sumExpenses(renamed)).toBe(20_520_000);
  });
  it("removes a category and its items", () => {
    const removed = removeCategory(DEFAULTS.constructionExpenses, "Painting & finishes");
    expect(removed.some((e) => e.category === "Painting & finishes")).toBe(false);
    expect(removed.length).toBeLessThan(DEFAULTS.constructionExpenses.length);
  });
  it("adds a category via a starter line", () => {
    const added = addCategoryLine(DEFAULTS.constructionExpenses, "Solar & EV");
    expect(added.filter((e) => e.category === "Solar & EV")).toHaveLength(1);
    expect(added.length).toBe(DEFAULTS.constructionExpenses.length + 1);
  });
});

describe("copy construction budget across deals", () => {
  const deal = (id: string, ce: Inputs["constructionExpenses"]): Deal => ({
    id,
    name: id.toUpperCase(),
    inputs: { ...DEFAULTS, constructionExpenses: ce },
    strategy: "sellAll",
    usdRate: 86,
    createdAt: 0,
    updatedAt: 0,
  });
  it("deep-copies the source budget into targets only", () => {
    const store: Store = {
      currentId: "a",
      deals: [deal("a", DEFAULTS.constructionExpenses), deal("b", []), deal("c", [])],
    };
    const next = copyConstructionBudget(store, "a", ["b"]);
    expect(sumExpenses(next.deals[1].inputs.constructionExpenses)).toBe(20_520_000);
    expect(next.deals[2].inputs.constructionExpenses).toHaveLength(0);
    expect(next.deals[1].inputs.constructionExpenses).not.toBe(store.deals[0].inputs.constructionExpenses);
  });
});
