"use client";

// Per-category budgeted-vs-actual table for the Spend log. Pure presentation over
// plannedVsActual; money renders sharp via compactInr (small actuals stay visible).

import type { plannedVsActual } from "@/lib/realestate/actuals";
import { compactInr } from "@/lib/realestate/format";
import { cx } from "@/components/ui";

export function PlannedVsActual({ pva }: { pva: ReturnType<typeof plannedVsActual> }) {
  const rows = pva.rows.filter((r) => r.actual > 0);
  return (
    <div className="rounded-[var(--radius)] border border-line bg-card p-4">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">
        Planned vs actual (by category)
      </div>
      {rows.length ? (
        <div className="overflow-hidden rounded-[var(--radius-sm)] border border-line">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="bg-surface text-left text-mut">
                <th className="px-3 py-1.5 font-medium">Category</th>
                <th className="px-3 py-1.5 text-right font-medium">Budgeted</th>
                <th className="px-3 py-1.5 text-right font-medium">Actual</th>
                <th className="px-3 py-1.5 text-right font-medium">Variance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.category} className="border-t border-line">
                  <td className="px-3 py-1.5 text-txt">{r.category}</td>
                  <td className="nums px-3 py-1.5 text-right text-mut">{compactInr(r.budgeted)}</td>
                  <td className="nums px-3 py-1.5 text-right text-txt">{compactInr(r.actual)}</td>
                  <td
                    className={cx(
                      "nums px-3 py-1.5 text-right font-medium",
                      r.variance > 0 ? "text-red" : "text-green",
                    )}
                  >
                    {r.variance > 0 ? "+" : ""}
                    {compactInr(r.variance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-[12px] text-faint">No actuals logged against budget categories yet.</div>
      )}
    </div>
  );
}
