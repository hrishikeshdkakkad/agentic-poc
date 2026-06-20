"use client";

// Real-world expense tracker: a planned-vs-actual rollup plus a full information-
// gathering form per logged expense (name, amount, date, category, vendor,
// method, reference, receipt URL, status, notes). Edits flow up via
// onChange({ actualExpenses }) → the deal persists to Neon.

import type { Inputs } from "@/lib/realestate/defaults";
import {
  ACTUAL_STATUSES,
  PAYMENT_METHODS,
  blankActual,
  type ActualExpense,
  type ActualStatus,
} from "@/lib/realestate/actuals-defaults";
import { plannedVsActual } from "@/lib/realestate/actuals";
import { constructionByCategory } from "@/lib/realestate/construction";
import { cr } from "@/lib/realestate/format";
import { Badge, Button, EmptyState, Field, inputCls, NumberInput, cx } from "@/components/ui";

const STATUS_TONE: Record<ActualStatus, "green" | "amber" | "accent"> = {
  paid: "green",
  pending: "amber",
  partial: "accent",
};

export function ActualsEditor({
  inputs,
  onChange,
}: {
  inputs: Inputs;
  onChange: (patch: Partial<Inputs>) => void;
}) {
  const list = inputs.actualExpenses ?? [];
  const pva = plannedVsActual(inputs);
  const categories = constructionByCategory(inputs).map((c) => c.category);

  const patch = (idx: number, field: keyof ActualExpense, value: string | number) =>
    onChange({
      actualExpenses: list.map((a, i) => (i === idx ? ({ ...a, [field]: value } as ActualExpense) : a)),
    });
  const remove = (idx: number) => onChange({ actualExpenses: list.filter((_, i) => i !== idx) });
  const add = () => onChange({ actualExpenses: [...list, blankActual(categories[0])] });

  return (
    <div className="space-y-5">
      <PvaRollup pva={pva} />

      {list.length === 0 ? (
        <EmptyState
          title="No expenses logged yet"
          description="Record real-world spend against the budget — vendor, date, receipt link, amount — to track planned vs actual."
          action={
            <Button variant="secondary" onClick={add}>
              Log your first expense
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {list.map((a, idx) => (
            <div key={a.id} className="rounded-[var(--radius)] border border-line bg-card p-3">
              <div className="flex items-center gap-2">
                <input
                  value={a.name}
                  onChange={(e) => patch(idx, "name", e.target.value)}
                  placeholder="Expense name (e.g. TMT steel — order 1)"
                  className={cx(inputCls, "min-w-0 flex-1 font-medium")}
                />
                <Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge>
                <button
                  onClick={() => remove(idx)}
                  className="px-1.5 text-base leading-none text-mut transition-colors hover:text-red"
                  title="Delete expense"
                  aria-label="Delete expense"
                >
                  ×
                </button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Field label="Amount ₹">
                  <NumberInput
                    value={a.amount}
                    onChange={(n) => patch(idx, "amount", n)}
                    className={cx(inputCls, "w-full py-1.5 text-right")}
                  />
                </Field>
                <Field label="Date">
                  <input
                    type="date"
                    value={a.date}
                    onChange={(e) => patch(idx, "date", e.target.value)}
                    className={cx(inputCls, "w-full py-1.5")}
                  />
                </Field>
                <Field label="Status">
                  <select
                    value={a.status}
                    onChange={(e) => patch(idx, "status", e.target.value)}
                    className={cx(inputCls, "w-full py-1.5")}
                  >
                    {ACTUAL_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Category">
                  <select
                    value={a.category ?? ""}
                    onChange={(e) => patch(idx, "category", e.target.value)}
                    className={cx(inputCls, "w-full py-1.5")}
                  >
                    <option value="">Unassigned</option>
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                    {a.category && !categories.includes(a.category) && (
                      <option value={a.category}>{a.category}</option>
                    )}
                  </select>
                </Field>
                <Field label="Vendor / paid to">
                  <input
                    value={a.vendor ?? ""}
                    onChange={(e) => patch(idx, "vendor", e.target.value)}
                    className={cx(inputCls, "w-full py-1.5")}
                  />
                </Field>
                <Field label="Method">
                  <select
                    value={a.method ?? ""}
                    onChange={(e) => patch(idx, "method", e.target.value)}
                    className={cx(inputCls, "w-full py-1.5")}
                  >
                    <option value="">—</option>
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Reference / invoice #">
                  <input
                    value={a.reference ?? ""}
                    onChange={(e) => patch(idx, "reference", e.target.value)}
                    className={cx(inputCls, "w-full py-1.5")}
                  />
                </Field>
                <Field label="Receipt / invoice URL" className="sm:col-span-2">
                  <input
                    value={a.url ?? ""}
                    onChange={(e) => patch(idx, "url", e.target.value)}
                    placeholder="https://…"
                    className={cx(inputCls, "w-full py-1.5")}
                  />
                </Field>
              </div>
              <Field label="Notes" className="mt-2">
                <textarea
                  value={a.description ?? ""}
                  onChange={(e) => patch(idx, "description", e.target.value)}
                  rows={2}
                  className={cx(inputCls, "w-full py-1.5")}
                />
              </Field>
              {a.url && (
                <a
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-block text-[11px] font-medium text-accent hover:underline"
                >
                  Open receipt ↗
                </a>
              )}
            </div>
          ))}
          <Button variant="secondary" onClick={add} className="w-full justify-center">
            + Log an expense
          </Button>
        </div>
      )}
    </div>
  );
}

function PvaRollup({ pva }: { pva: ReturnType<typeof plannedVsActual> }) {
  const overallPct = pva.totalBudget > 0 ? pva.totalActual / pva.totalBudget : 0;
  const rows = pva.rows.filter((r) => r.actual > 0 || r.budgeted > 0);
  return (
    <div className="rounded-[var(--radius)] border border-line bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">Spent vs budget</div>
          <div className="nums mt-0.5 text-lg font-semibold text-txt">
            {cr(pva.totalActual)} <span className="text-[12px] font-normal text-mut">of {cr(pva.totalBudget)}</span>
          </div>
        </div>
        <Badge tone={pva.totalActual > pva.totalBudget ? "red" : overallPct > 0.9 ? "amber" : "green"} dot>
          {(overallPct * 100).toFixed(0)}% spent
        </Badge>
      </div>
      {rows.some((r) => r.actual > 0) && (
        <div className="mt-3 overflow-hidden rounded-[var(--radius-sm)] border border-line">
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
              {rows
                .filter((r) => r.actual > 0)
                .map((r) => (
                  <tr key={r.category} className="border-t border-line">
                    <td className="px-3 py-1.5 text-txt">{r.category}</td>
                    <td className="nums px-3 py-1.5 text-right text-mut">{cr(r.budgeted)}</td>
                    <td className="nums px-3 py-1.5 text-right text-txt">{cr(r.actual)}</td>
                    <td
                      className={cx(
                        "nums px-3 py-1.5 text-right font-medium",
                        r.variance > 0 ? "text-red" : "text-green",
                      )}
                    >
                      {r.variance > 0 ? "+" : ""}
                      {cr(r.variance)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
