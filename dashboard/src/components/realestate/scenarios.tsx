"use client";

import type { Inputs } from "@/lib/realestate/defaults";
import { netScenarios, type NetScenario } from "@/lib/realestate/reality";
import { cr, pct, mult, rate, inrToUsd } from "@/lib/realestate/format";
import { Card, cx } from "@/components/ui";

const ROWS: Array<{
  key: string;
  label: string;
  fn: (s: NetScenario, usd: number) => React.ReactNode;
  tone?: (s: NetScenario) => boolean;
}> = [
  { key: "rate", label: "Sale rate", fn: (s) => `${rate(s.saleRate)}/sqft` },
  { key: "unit", label: "Unit value", fn: (s) => cr(s.unitValue) },
  { key: "rev", label: "Revenue", fn: (s) => cr(s.revenue) },
  {
    key: "profit",
    label: "Net profit",
    fn: (s, usd) => `${cr(s.profit)} · ${inrToUsd(s.profit, usd)}`,
    tone: (s) => s.profit < 0,
  },
  { key: "margin", label: "Margin", fn: (s) => pct(s.margin), tone: (s) => s.margin < 0 },
  { key: "roe", label: "ROE", fn: (s) => mult(s.roe), tone: (s) => s.roe < 0 },
  { key: "irr", label: "Annual IRR", fn: (s) => pct(s.annualIrr) },
];

export function Scenarios({ inputs, usdRate }: { inputs: Inputs; usdRate: number }) {
  const { bear, base, bull } = netScenarios(inputs);
  const cols: Array<{ key: string; label: string; scenario: NetScenario }> = [
    { key: "bear", label: "Bear", scenario: bear },
    { key: "base", label: "Base", scenario: base },
    { key: "bull", label: "Bull", scenario: bull },
  ];

  return (
    <Card title="Scenarios" subtitle="net · after loan + partners repaid">
      {/* Bear/Base/Bull cells (e.g. "₹4.2 Cr · $145K") exceed a phone's width —
          scroll the table horizontally rather than letting it break the card. */}
      <div className="-mx-5 overflow-x-auto px-5">
      <table className="w-full min-w-[24rem] text-[13px]">
        <thead>
          <tr className="text-left text-mut">
            <th className="pb-2 font-medium"></th>
            {cols.map((c) => (
              <th key={c.key} className="pb-2 text-right font-semibold text-txt">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.key} className="border-t border-line">
              <td className="py-2 text-mut">{r.label}</td>
              {cols.map((c) => (
                <td
                  key={c.key}
                  className={cx(
                    "nums py-2 text-right",
                    c.key === "base" ? "font-semibold text-txt" : "text-txt",
                    r.tone?.(c.scenario) && "text-red",
                  )}
                >
                  {r.fn(c.scenario, usdRate)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </Card>
  );
}
