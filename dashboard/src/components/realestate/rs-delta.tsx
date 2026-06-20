"use client";

// Rupee-native delta chip. The shared <Delta>/<MoneyCell> render USD via the
// app-wide usd() formatter; this view speaks rupees, so it gets its own chip
// that mirrors <Delta>'s look but formats with the realestate ₹ helpers.

import { cr, pct, mult, rate } from "@/lib/realestate/format";
import { cx } from "@/components/ui";
import { IconArrowUpRight, IconArrowDownRight } from "@/components/icons";

export type DeltaUnit = "inr" | "pct" | "rate" | "x";

const fmtMag = (unit: DeltaUnit, mag: number) =>
  unit === "pct" ? pct(mag) : unit === "x" ? mult(mag) : unit === "rate" ? rate(mag) : cr(mag);

/** ▲▼ chip. Positive is green by default; pass invert for "lower is better". */
export function RupeeDelta({
  value,
  unit = "inr",
  invert = false,
  className = "",
}: {
  value: number | null | undefined;
  unit?: DeltaUnit;
  invert?: boolean;
  className?: string;
}) {
  if (value == null || !Number.isFinite(value)) return null;
  const positive = invert ? value <= 0 : value >= 0;
  const Arrow = value >= 0 ? IconArrowUpRight : IconArrowDownRight;
  return (
    <span
      className={cx(
        "nums inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold",
        positive ? "bg-[var(--green-soft)] text-green" : "bg-[var(--red-soft)] text-red",
        className,
      )}
    >
      <Arrow size={13} />
      {fmtMag(unit, Math.abs(value))}
    </span>
  );
}
