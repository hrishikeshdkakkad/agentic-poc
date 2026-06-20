"use client";

import type { Inputs } from "@/lib/realestate/defaults";
import { netSensitivityGrid } from "@/lib/realestate/reality";
import { Card, cx } from "@/components/ui";

/** Net profit (₹ Cr, after debt) heat across construction cost (rows) × sale rate (cols). */
export function Sensitivity({ inputs }: { inputs: Inputs }) {
  const { constructionRates, saleRates, grid } = netSensitivityGrid(inputs);
  const flat = grid.flat();
  const maxAbs = Math.max(1, ...flat.map((v) => Math.abs(v)));

  // nearest axis index to the live inputs, to mark the operating point
  const rowSel = nearest(constructionRates, inputs.constructionRate);
  const colSel = nearest(saleRates, inputs.baseSaleRate);

  const bg = (v: number) => {
    const pctMix = Math.min(80, (Math.abs(v) / maxAbs) * 80 + 6);
    const color = v >= 0 ? "var(--green)" : "var(--red)";
    return `color-mix(in oklab, ${color} ${pctMix}%, transparent)`;
  };

  return (
    <Card title="Sensitivity" subtitle="net profit ₹Cr · after debt">
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0.5 text-[11.5px]">
          <thead>
            <tr>
              <th className="px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-faint">
                ₹/sqft ↓ build · → sale
              </th>
              {saleRates.map((s, ci) => (
                <th
                  key={s}
                  className={cx(
                    "nums px-2 py-1 text-right font-medium",
                    ci === colSel ? "text-accent" : "text-mut",
                  )}
                >
                  {(s / 1000).toFixed(s % 1000 ? 1 : 0)}k
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {constructionRates.map((c, ri) => (
              <tr key={c}>
                <td
                  className={cx(
                    "nums px-2 py-1 text-right font-medium",
                    ri === rowSel ? "text-accent" : "text-mut",
                  )}
                >
                  {c.toLocaleString("en-IN")}
                </td>
                {saleRates.map((s, ci) => {
                  const v = grid[ri][ci];
                  const here = ri === rowSel && ci === colSel;
                  return (
                    <td
                      key={s}
                      className={cx(
                        "nums rounded-[5px] px-2 py-1.5 text-right tabular-nums",
                        v < 0 ? "text-red" : "text-txt",
                        here && "ring-2 ring-accent ring-offset-1 ring-offset-[var(--card)] font-semibold",
                      )}
                      style={{ background: bg(v) }}
                      title={`build ₹${c}/sqft · sale ₹${s}/sqft → ₹${v.toFixed(2)} Cr`}
                    >
                      {v.toFixed(1)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-faint">
        Ringed cell = your current inputs. Red = loss. Pre-bought units stay fixed at what their buyers
        actually pay; only market-sale units move with the column rate.
      </p>
    </Card>
  );
}

function nearest(arr: number[], target: number): number {
  let best = 0;
  let bestD = Infinity;
  arr.forEach((v, i) => {
    const d = Math.abs(v - target);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}
