// Indian-format currency + percentage helpers (ported from smv-deal-simulator).
// Kept separate from the app-wide USD format.ts because this view speaks rupees.

const finite = (n: number) => Number.isFinite(n);

export const cr = (n: number) => (finite(n) ? `₹${(n / 1e7).toFixed(2)} Cr` : "—");
export const lakh = (n: number) => (finite(n) ? `₹${(n / 1e5).toFixed(1)} L` : "—");
export const pct = (n: number) => (finite(n) ? `${(n * 100).toFixed(1)}%` : "—");

// Spent-share label that never hides real progress: a nonzero fraction below 1%
// reads "<1%" instead of rounding down to a misleading "0%" (e.g. ₹10k of ₹2.03 Cr).
export const pctSpent = (frac: number) => {
  if (!finite(frac)) return "—";
  const p = frac * 100;
  if (p > 0 && p < 1) return "<1%";
  return `${Math.round(p)}%`;
};
export const mult = (n: number) => (finite(n) ? `${n.toFixed(2)}×` : "—");
export const inr = (n: number) => (finite(n) ? `₹${Math.round(n).toLocaleString("en-IN")}` : "—");
export const rate = (n: number) => (finite(n) ? `₹${Math.round(n).toLocaleString("en-IN")}` : "—");

// Compact ₹ for axis labels: shows Cr or L automatically.
export const compactInr = (n: number) => {
  if (!finite(n)) return "—";
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(1)}Cr`;
  // Promote to Cr when the rounded lakh value would hit 100L (= 1 Cr), so e.g.
  // ₹99.6 L renders "₹1.0Cr" rather than the misleading "₹100L".
  if (Math.round(a / 1e5) >= 100) return `${sign}₹${(a / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `${sign}₹${Math.round(a / 1e5)}L`;
  return inr(n);
};

// Convert an INR amount to USD (at `usdRate` ₹/$) and format compactly: $M / $K / $.
export const inrToUsd = (n: number, usdRate: number) => {
  if (!finite(n) || !finite(usdRate) || usdRate <= 0) return "—";
  const v = n / usdRate;
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  // Promote to $M when the rounded-K value reaches 1000K (= $1M), so e.g. $999.6K
  // renders "$1.00M" rather than "$1000K".
  if (Math.round(a / 1e3) >= 1000) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}K`;
  return `${sign}$${Math.round(a)}`;
};
