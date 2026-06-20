"use client";

// Focused add/edit form for a single logged expense. Holds a DRAFT in local state;
// nothing is emitted until Save (and Save is blocked while the draft is blank), so
// abandoned/cancelled entries never reach the deal — no phantom rows by construction.

import { useState } from "react";
import {
  ACTUAL_STATUSES,
  PAYMENT_METHODS,
  blankActual,
  isBlankActual,
  type ActualExpense,
  type ActualStatus,
} from "@/lib/realestate/actuals-defaults";
import { Button, Field, inputCls, NumberInput, cx } from "@/components/ui";

export function ExpenseForm({
  initial,
  categories,
  onSave,
  onCancel,
}: {
  initial?: ActualExpense;
  categories: string[];
  onSave: (e: ActualExpense) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ActualExpense>(initial ?? blankActual(categories[0]));
  const set = <K extends keyof ActualExpense>(k: K, v: ActualExpense[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const error = isBlankActual(draft) ? "Add an amount or a name before saving." : null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Field label="Name" className="col-span-2 sm:col-span-3">
          <input
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. TMT steel — order 1"
            className={cx(inputCls, "w-full py-1.5")}
            autoFocus
          />
        </Field>
        <Field label="Amount ₹">
          <NumberInput value={draft.amount} onChange={(n) => set("amount", n)} className={cx(inputCls, "w-full py-1.5 text-right")} />
        </Field>
        <Field label="Date">
          <input type="date" value={draft.date} onChange={(e) => set("date", e.target.value)} className={cx(inputCls, "w-full py-1.5")} />
        </Field>
        <Field label="Status">
          <select value={draft.status} onChange={(e) => set("status", e.target.value as ActualStatus)} className={cx(inputCls, "w-full py-1.5")}>
            {ACTUAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Category">
          <select value={draft.category ?? ""} onChange={(e) => set("category", e.target.value)} className={cx(inputCls, "w-full py-1.5")}>
            <option value="">Unassigned</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
            {draft.category && !categories.includes(draft.category) && <option value={draft.category}>{draft.category}</option>}
          </select>
        </Field>
        <Field label="Vendor / paid to">
          <input value={draft.vendor ?? ""} onChange={(e) => set("vendor", e.target.value)} className={cx(inputCls, "w-full py-1.5")} />
        </Field>
        <Field label="Method">
          <select value={draft.method ?? ""} onChange={(e) => set("method", e.target.value)} className={cx(inputCls, "w-full py-1.5")}>
            <option value="">—</option>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reference / invoice #">
          <input value={draft.reference ?? ""} onChange={(e) => set("reference", e.target.value)} className={cx(inputCls, "w-full py-1.5")} />
        </Field>
        <Field label="Receipt / invoice URL" className="col-span-2 sm:col-span-3">
          <input value={draft.url ?? ""} onChange={(e) => set("url", e.target.value)} placeholder="https://…" className={cx(inputCls, "w-full py-1.5")} />
        </Field>
        <Field label="Notes" className="col-span-2 sm:col-span-3">
          <textarea value={draft.description ?? ""} onChange={(e) => set("description", e.target.value)} rows={2} className={cx(inputCls, "w-full py-1.5")} />
        </Field>
      </div>
      <div className="flex items-center justify-end gap-2">
        {error && <span className="mr-auto text-[11px] text-mut">{error}</span>}
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!!error} onClick={() => onSave(draft)}>
          Save
        </Button>
      </div>
    </div>
  );
}
