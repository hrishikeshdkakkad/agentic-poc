const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function usd(n: number | null | undefined): string {
  return n == null ? "—" : usdFmt.format(n);
}

/** Plaid sign convention: amount > 0 is an outflow (spend), < 0 an inflow. */
export function signedUsd(amount: number): { text: string; inflow: boolean } {
  const inflow = amount < 0;
  return { text: inflow ? `+${usdFmt.format(-amount)}` : usdFmt.format(amount), inflow };
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s.length === 10 ? `${s}T00:00:00` : s);
  return isNaN(d.getTime())
    ? s
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function fmtDateTime(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}

export function pct(n: number | null | undefined): string {
  return n == null ? "—" : `${n.toFixed(1)}%`;
}
