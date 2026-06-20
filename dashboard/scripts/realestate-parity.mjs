// Independent parity + reality check for the ported real-estate engine.
// Re-implements the formulas from scratch (like the source verify.mjs) so
// agreement confirms the math, not the wiring. Now built on the generalized
// investor structure (which replaced the old flat manoj1/manoj2): the SMV
// default — a single "Manoj" unit-buyer — must still hit the source workbook's
// constants, and a multi-investor case sanity-checks the generalization.
// Run: node scripts/realestate-parity.mjs

const months = [0, 3, 6, 9, 12, 15, 18, 21, 24];
const exit = months[months.length - 1];

// ---- generic investor helpers (independent re-implementation of model.ts) ----
const trancheTotal = (inv) => inv.tranches.reduce((s, t) => s + t.amount, 0);
const unitBuyers = (I) => I.investors.filter((v) => v.kind === "unit");
const capitalPartners = (I) => I.investors.filter((v) => v.kind === "capital");
const prebuyUnits = (I) => unitBuyers(I).reduce((s, v) => s + (v.units ?? 1), 0);
const marketUnits = (I) => I.units - prebuyUnits(I);
const prebuyRevenue = (I) => unitBuyers(I).reduce((s, v) => s + trancheTotal(v), 0);
const investorCapital = (I) => I.investors.reduce((s, v) => s + trancheTotal(v), 0);
const capitalPrincipal = (I) => capitalPartners(I).reduce((s, v) => s + trancheTotal(v), 0);
const investorInflowAt = (I, m) =>
  I.investors.reduce(
    (s, v) => s + v.tranches.filter((t) => t.month === m).reduce((a, t) => a + t.amount, 0),
    0,
  );
const capitalReturns = (I) =>
  capitalPartners(I).reduce(
    (s, v) =>
      s + v.tranches.reduce((a, t) => a + t.amount * (v.returnPct ?? 0) * ((exit - t.month) / 12), 0),
    0,
  );

// ---- cost stack ----
function costStack(I) {
  const bu = I.plotArea * I.far;
  const perUnit = bu / I.units;
  const land = I.siteCost + I.registration + I.brokerage + I.khata;
  const build = (I.constructionRate + I.extrasRate) * bu;
  const contingency = build * I.contingencyPct;
  const carry = (I.loanAmount * I.loanRate * I.loanMonths) / 12;
  return { bu, perUnit, land, build, contingency, carry, total: land + build + contingency + carry };
}

// Levered flows. `repay` toggles the reality-layer obligations (loan principal +
// capital-partner principal & return) being paid back at exit.
function flows(I, saleRate, { repay }) {
  const { land, build, contingency, carry, perUnit } = costStack(I);
  const draw = (build + contingency) / 5;
  const sale = (saleRate * perUnit * marketUnits(I)) / 2; // market units, M21 & M24
  const repayAmt = repay ? I.loanAmount + capitalPrincipal(I) + capitalReturns(I) : 0;
  return months.map((m) => {
    let cf = 0;
    if (m === 0) cf += -land + I.loanAmount;
    if (m === 3) cf += -750_000;
    if ([6, 9, 12, 15, 18].includes(m)) cf += -draw;
    cf += investorInflowAt(I, m);
    if (m === 21) cf += -carry + sale;
    if (m === 24) cf += sale;
    if (m === exit) cf -= repayAmt;
    return cf;
  });
}

function irr(cfs) {
  const npv = (r) => cfs.reduce((s, cf, t) => s + cf / (1 + r) ** t, 0);
  let lo = -0.9, hi = 10, fLo = npv(lo);
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2, f = npv(mid);
    if (Math.abs(f) < 1) return mid;
    if (f * fLo > 0) { lo = mid; fLo = f; } else { hi = mid; }
  }
  return (lo + hi) / 2;
}
const annual = (q) => (1 + q) ** 4 - 1;

// ---- the SMV default, expressed in the generalized investor shape ----
const SMV = {
  plotArea: 2400, far: 3, units: 4,
  siteCost: 32_400_000, registration: 1_980_000, brokerage: 250_000, khata: 50_000,
  constructionRate: 2_250, extrasRate: 600, contingencyPct: 0.05,
  loanAmount: 20_000_000, loanRate: 0.085, loanMonths: 24,
  equity: 6_735_250,
  investors: [
    {
      id: "manoj", name: "Manoj", kind: "unit", units: 1,
      tranches: [{ amount: 8_500_000, month: 0 }, { amount: 7_000_000, month: 12 }],
    },
  ],
  baseSaleRate: 11_500,
};

const cs = costStack(SMV);
const unitValue = SMV.baseSaleRate * cs.perUnit;
const revenue = marketUnits(SMV) * unitValue + prebuyRevenue(SMV);
const profit = revenue - cs.total;
const margin = profit / revenue;
const roe = profit / SMV.equity;

const reportedIrr = annual(irr(flows(SMV, SMV.baseSaleRate, { repay: false })));
const correctedIrr = annual(irr(flows(SMV, SMV.baseSaleRate, { repay: true })));

// dilution bridge: one of the market units sold early at ₹1.7 Cr
const bridge = 17_000_000;
const dilProfit =
  (marketUnits(SMV) - 1) * unitValue + bridge + prebuyRevenue(SMV) - cs.total - capitalReturns(SMV);
const dilRoe = dilProfit / SMV.equity;

// unlevered engine, annualized over the build horizon
const unlevTotal = profit / cs.total;
const unlevAnnual = (1 + unlevTotal) ** (1 / (SMV.loanMonths / 12)) - 1;

// downside rungs (sale ₹/sqft) -> profit on the market units
const downside = (rate) =>
  marketUnits(SMV) * (rate * cs.perUnit) + prebuyRevenue(SMV) - cs.total - capitalReturns(SMV);

// ---- multi-investor sanity: 2 unit-buyers + 1 capital partner over 5 units ----
const MULTI = {
  ...SMV,
  units: 5,
  investors: [
    { id: "a", name: "A", kind: "unit", units: 1, tranches: [{ amount: 8_500_000, month: 0 }, { amount: 7_000_000, month: 12 }] },
    { id: "b", name: "B", kind: "unit", units: 1, tranches: [{ amount: 10_000_000, month: 12 }] },
    { id: "c", name: "C", kind: "capital", returnPct: 0.18, tranches: [{ amount: 5_000_000, month: 0 }] },
  ],
};

const checks = [
  // ---- faithful (must equal source verify.mjs) ----
  ["[faithful] built-up", cs.bu, 7200],
  ["[faithful] total cost", cs.total, 59_626_000],
  ["[faithful] base profit", profit, 17_974_000],
  ["[faithful] margin", margin, 0.231624],
  ["[faithful] ROE x", roe, 2.66865],
  ["[faithful] annual IRR", reportedIrr, 1.152669],
  // ---- corrected (the reality panel) ----
  ["[reality] corrected IRR (loan repaid)", correctedIrr, 0.631, 0.02],
  ["[reality] dilution profit ₹", dilProfit, 14_274_000, 1000],
  ["[reality] dilution ROE x", dilRoe, 2.1193, 0.01],
  ["[reality] unlevered annual", unlevAnnual, 0.1408, 0.002],
  // ---- downside must turn negative below breakeven ----
  ["[downside] soft -30% (₹8000) is a loss", downside(8000) < 0 ? 1 : 0, 1],
  ["[downside] hard -40% (₹7000) is a loss", downside(7000) < 0 ? 1 : 0, 1],
  // ---- generalization sanity (the new investor structure) ----
  ["[multi] market units = 5 − 2 prebought", marketUnits(MULTI), 3],
  ["[multi] prebuy revenue Σ unit tranches", prebuyRevenue(MULTI), 25_500_000],
  ["[multi] investor capital (both kinds)", investorCapital(MULTI), 30_500_000],
  ["[multi] capital return 50L·18%·2y", capitalReturns(MULTI), 1_800_000],
];

let ok = true;
for (const [name, got, want, absTol] of checks) {
  const tol = absTol ?? Math.max(1, Math.abs(want) * 0.0005);
  const pass = Math.abs(got - want) <= tol;
  ok = ok && pass;
  const g = typeof got === "number" && Math.abs(got) > 1 ? got.toFixed(2) : got.toFixed?.(4) ?? got;
  console.log(`${pass ? "✓" : "✗"} ${name.padEnd(42)} got=${String(g).padStart(14)}  want=${want}`);
}
console.log(ok ? "\nALL PARITY + REALITY CHECKS PASSED" : "\nFAILED");
process.exit(ok ? 0 : 1);
