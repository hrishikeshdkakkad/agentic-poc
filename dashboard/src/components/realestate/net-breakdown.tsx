"use client";

// "How the net figure is built" — a waterfall/derivation of the after-debt base
// profit, on the SAME honest basis as the verdict hero (netBreakdown ===
// dilutionScenario at base). Pure presentation over ./reality; the faithful
// engine is never touched.

import type { Inputs } from "@/lib/realestate/defaults";
import { netBreakdown } from "@/lib/realestate/reality";
import { perUnit } from "@/lib/realestate/model";
import { cr, pct, mult, inrToUsd } from "@/lib/realestate/format";
import { Badge, Card, cx } from "@/components/ui";

function Row({
  label,
  value,
  sub,
  op,
  strong,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: string;
  op?: "+" | "−";
  strong?: boolean;
}) {
  return (
    <tr className={cx("border-t border-line", strong && "bg-[var(--accent-soft)]")}>
      <td className="py-2 pr-2 align-top">
        <span className={cx("text-[13px]", strong ? "font-semibold text-txt" : "text-mut")}>
          {op && <span className="mr-1.5 inline-block w-2 text-faint">{op}</span>}
          {label}
        </span>
        {sub && <div className="ml-[18px] text-[11px] text-faint">{sub}</div>}
      </td>
      <td
        className={cx(
          "nums py-2 text-right align-top tabular-nums",
          strong ? "text-[14px] font-semibold text-txt" : "text-[13px] text-txt",
        )}
      >
        {value}
      </td>
    </tr>
  );
}

export function NetBreakdown({ inputs, usdRate }: { inputs: Inputs; usdRate: number }) {
  const b = netBreakdown(inputs);
  const unitValue = inputs.baseSaleRate * perUnit(inputs);
  const bridgeDiscount = unitValue > 0 ? (unitValue - inputs.bridgePrice) / unitValue : 0;
  const bridgeSub =
    b.bridgeSale > 0
      ? `1 unit @ ${cr(inputs.bridgePrice)} · ${pct(Math.abs(bridgeDiscount))} ${bridgeDiscount >= 0 ? "below" : "above"} ${cr(unitValue)} market`
      : "no market unit available to bridge-sell";

  return (
    <Card
      title="How the net figure is built"
      subtitle="after-debt profit, derived line by line"
      right={
        <Badge tone={b.netProfit >= 0 ? "green" : "red"}>
          {cr(b.netProfit)} · {mult(b.roe)}
        </Badge>
      }
    >
      <table className="w-full">
        <tbody>
          <Row label="Market-unit sales" value={cr(b.marketSales)} op="+" sub="units sold at market rate" />
          <Row label="Bridge unit sale" value={cr(b.bridgeSale)} op="+" sub={bridgeSub} />
          <Row label="Pre-bought units" value={cr(b.prebuy)} op="+" sub="at what their buyers actually pay" />
          <Row label="Revenue" value={cr(b.revenue)} strong />

          <Row label="Land" value={cr(b.land)} op="−" sub="site + registration + brokerage + khata" />
          <Row label="Build" value={cr(b.build)} op="−" sub="itemized construction budget" />
          <Row label="Contingency" value={cr(b.contingency)} op="−" />
          <Row label="Financing interest" value={cr(b.financingInterest)} op="−" sub="real interest over the build" />
          <Row label="Total cost" value={cr(b.cost)} strong />

          <Row label="Capital-partner returns" value={cr(b.capitalReturns)} op="−" sub="agreed return paid at exit" />

          <Row
            label="Net profit"
            value={`${cr(b.netProfit)} · ${inrToUsd(b.netProfit, usdRate)}`}
            sub={`ROE ${mult(b.roe)} · corrected IRR ${pct(b.correctedIrr)}`}
            strong
          />
        </tbody>
      </table>

      <p className="mt-3 text-[11px] leading-relaxed text-faint">
        Loan principal {cr(b.loanRepaid)}
        {b.capitalPrincipal > 0 ? ` + capital principal ${cr(b.capitalPrincipal)}` : ""} is repaid at exit
        — it doesn&rsquo;t change net profit (principal is a wash) but it depresses the corrected IRR, and is
        already netted in the cash flows that drive it.
      </p>
    </Card>
  );
}
