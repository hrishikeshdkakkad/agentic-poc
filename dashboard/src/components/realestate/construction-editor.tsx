"use client";

// Construction-budget workspace (wide drawer): a Budget tab (category-grouped
// line items with rename/add/delete categories + copy-to-other-deals) and an
// Actuals tab (real-world expense tracking). Edits flow up via onChange →
// updateCurrent → the engine recomputes buildSubtotal from the itemized total.

import { useEffect, useMemo, useState } from "react";
import type { Inputs } from "@/lib/realestate/defaults";
import type { Deal } from "@/lib/realestate/deals";
import {
  CONSTRUCTION_CATEGORIES,
  type ConstructionExpense,
} from "@/lib/realestate/construction-defaults";
import {
  blankExpense,
  constructionPerSqft,
  constructionReconciliation,
  constructionTotal,
  renameCategory,
  removeCategory,
  addCategoryLine,
} from "@/lib/realestate/construction";
import { cr, rate } from "@/lib/realestate/format";
import { Badge, Button, NumberInput, Segmented, inputCls, cx } from "@/components/ui";
import { ActualsEditor } from "@/components/realestate/actuals-editor";

const CF_GRID = [0, 3, 6, 9, 12, 15, 18, 21, 24];
const UNITS = ["lumpsum", "sqft", "cum", "kg", "MT", "nos", "rmt", "point", "day", "month"];

export function ConstructionEditor({
  inputs,
  onChange,
  deals,
  currentId,
  onCopyBudgetTo,
}: {
  inputs: Inputs;
  onChange: (patch: Partial<Inputs>) => void;
  deals: Deal[];
  currentId: string;
  onCopyBudgetTo: (ids: string[]) => void;
}) {
  const [tab, setTab] = useState<"budget" | "actuals">("budget");
  const actuals = inputs.actualExpenses?.length ?? 0;

  return (
    <div className="space-y-5">
      <Segmented
        layoutId="ce-tab"
        value={tab}
        onChange={setTab}
        options={[
          { value: "budget", label: "Budget" },
          { value: "actuals", label: actuals ? `Actuals (${actuals})` : "Actuals" },
        ]}
      />
      {tab === "budget" ? (
        <BudgetTab
          inputs={inputs}
          onChange={onChange}
          deals={deals}
          currentId={currentId}
          onCopyBudgetTo={onCopyBudgetTo}
        />
      ) : (
        <ActualsEditor inputs={inputs} onChange={onChange} />
      )}
    </div>
  );
}

function BudgetTab({
  inputs,
  onChange,
  deals,
  currentId,
  onCopyBudgetTo,
}: {
  inputs: Inputs;
  onChange: (patch: Partial<Inputs>) => void;
  deals: Deal[];
  currentId: string;
  onCopyBudgetTo: (ids: string[]) => void;
}) {
  const list = inputs.constructionExpenses ?? [];
  const recon = constructionReconciliation(inputs);

  const groups = useMemo(() => {
    const byCat = new Map<string, { e: ConstructionExpense; idx: number }[]>();
    list.forEach((e, idx) => {
      const arr = byCat.get(e.category) ?? [];
      arr.push({ e, idx });
      byCat.set(e.category, arr);
    });
    const known = CONSTRUCTION_CATEGORIES.filter((c) => byCat.has(c));
    const extras = [...byCat.keys()].filter((c) => !CONSTRUCTION_CATEGORIES.includes(c as never));
    return [...known, ...extras].map((category) => ({ category, rows: byCat.get(category)! }));
  }, [list]);

  const patch = (idx: number, field: keyof ConstructionExpense, value: string | number) => {
    const next = list.map((e, i) => {
      if (i !== idx) return e;
      const u = { ...e, [field]: value } as ConstructionExpense;
      if ((field === "qty" || field === "rate") && u.unit !== "lumpsum") {
        u.amount = Math.round((u.qty || 0) * (u.rate || 0));
      }
      return u;
    });
    onChange({ constructionExpenses: next });
  };
  const removeLine = (idx: number) =>
    onChange({ constructionExpenses: list.filter((_, i) => i !== idx) });
  const addLine = (category: string) =>
    onChange({ constructionExpenses: [...list, blankExpense(category)] });
  const renameCat = (from: string, to: string) =>
    onChange({ constructionExpenses: renameCategory(list, from, to) });
  const removeCat = (category: string) =>
    onChange({ constructionExpenses: removeCategory(list, category) });
  const addCat = (name: string) =>
    onChange({ constructionExpenses: addCategoryLine(list, name) });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 rounded-[var(--radius)] border border-line bg-card px-4 py-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">Total build</div>
          <div className="nums text-lg font-semibold text-txt">
            {cr(constructionTotal(inputs))}{" "}
            <span className="text-[12px] font-normal text-mut">
              · {rate(constructionPerSqft(inputs))}/sqft · {list.length} items
            </span>
          </div>
        </div>
        <Badge tone={recon.matched ? "green" : "amber"} dot>
          {recon.matched ? "reconciled to budget" : `${recon.variance > 0 ? "+" : "−"}${cr(Math.abs(recon.variance))} vs budget`}
        </Badge>
      </div>

      <CopyBudget deals={deals} currentId={currentId} onCopy={onCopyBudgetTo} />

      <div className="gap-x-7 xl:columns-2">
      {groups.map((g) => (
        <div key={g.category} className="mb-5 break-inside-avoid">
          <CategoryHeader
            name={g.category}
            subtotal={g.rows.reduce((s, r) => s + r.e.amount, 0)}
            onRename={(to) => renameCat(g.category, to)}
            onDelete={() => removeCat(g.category)}
          />
          <div className="space-y-1.5">
            {g.rows.map(({ e, idx }) => (
              <div key={e.id} className="rounded-[var(--radius-sm)] border border-line bg-surface p-2">
                <div className="flex items-center gap-2">
                  <input
                    value={e.item}
                    onChange={(ev) => patch(idx, "item", ev.target.value)}
                    className={cx(inputCls, "min-w-0 flex-1 py-1.5")}
                    placeholder="Line item"
                  />
                  <button
                    onClick={() => removeLine(idx)}
                    className="shrink-0 px-1.5 text-base leading-none text-mut transition-colors hover:text-red"
                    title="Remove line"
                    aria-label="Remove line"
                  >
                    ×
                  </button>
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-5">
                  <NumCell label="Qty" value={e.qty} onChange={(v) => patch(idx, "qty", v)} />
                  <SelectCell label="Unit" value={e.unit} options={UNITS} onChange={(v) => patch(idx, "unit", v)} />
                  <NumCell label="Rate ₹" value={e.rate} onChange={(v) => patch(idx, "rate", v)} />
                  <NumCell label="Amount ₹" value={e.amount} onChange={(v) => patch(idx, "amount", v)} strong />
                  <SelectCell
                    label="Month"
                    value={String(e.month)}
                    options={CF_GRID.map(String)}
                    render={(m) => `M${m}`}
                    onChange={(v) => patch(idx, "month", Number(v))}
                  />
                </div>
              </div>
            ))}
          </div>
          <button
            onClick={() => addLine(g.category)}
            className="mt-1.5 text-[11px] font-medium text-accent hover:underline"
          >
            + Add line
          </button>
        </div>
      ))}
      </div>

      <AddCategory existing={groups.map((g) => g.category)} onAdd={addCat} />
    </div>
  );
}

function CategoryHeader({
  name,
  subtotal,
  onRename,
  onDelete,
}: {
  name: string;
  subtotal: number;
  onRename: (to: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(name);
  useEffect(() => setVal(name), [name]);
  const commit = () => {
    setEditing(false);
    const next = val.trim();
    if (next && next !== name) onRename(next);
    else setVal(name);
  };
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2">
      {editing ? (
        <input
          autoFocus
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setVal(name);
              setEditing(false);
            }
          }}
          className={cx(inputCls, "min-w-0 flex-1 py-1 text-[12px] font-semibold uppercase tracking-[0.06em]")}
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="group flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-mut hover:text-txt"
          title="Rename category"
        >
          <span className="truncate">{name}</span>
          <span className="text-faint opacity-0 transition-opacity group-hover:opacity-100">✎</span>
        </button>
      )}
      <div className="flex shrink-0 items-center gap-2">
        <span className="nums text-[11px] text-faint">{cr(subtotal)}</span>
        <button
          onClick={onDelete}
          className="text-base leading-none text-faint transition-colors hover:text-red"
          title="Delete category and all its lines"
          aria-label="Delete category"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function AddCategory({ existing, onAdd }: { existing: string[]; onAdd: (name: string) => void }) {
  const [name, setName] = useState("");
  const add = () => {
    const n = name.trim();
    if (!n || existing.includes(n)) return;
    onAdd(n);
    setName("");
  };
  return (
    <div className="flex items-center gap-2 border-t border-line pt-3">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
        }}
        placeholder="New category name…"
        className={cx(inputCls, "min-w-0 flex-1 py-1.5")}
      />
      <Button size="sm" variant="secondary" onClick={add} disabled={!name.trim() || existing.includes(name.trim())}>
        + Add category
      </Button>
    </div>
  );
}

function CopyBudget({
  deals,
  currentId,
  onCopy,
}: {
  deals: Deal[];
  currentId: string;
  onCopy: (ids: string[]) => void;
}) {
  const others = deals.filter((d) => d.id !== currentId);
  const [sel, setSel] = useState<string[]>([]);
  const [done, setDone] = useState(0);
  if (!others.length) {
    return (
      <p className="rounded-[var(--radius-sm)] border border-dashed border-line px-3 py-2 text-[11px] text-faint">
        Create another deal to copy this construction budget into it.
      </p>
    );
  }
  const toggle = (id: string) => {
    setDone(0);
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };
  const copy = () => {
    if (!sel.length) return;
    onCopy(sel);
    setDone(sel.length);
    setSel([]);
  };
  return (
    <div className="rounded-[var(--radius-sm)] border border-line bg-surface px-3 py-2.5">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">
        Copy this budget to another deal
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {others.map((d) => (
          <button
            key={d.id}
            onClick={() => toggle(d.id)}
            className={cx(
              "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
              sel.includes(d.id)
                ? "border-accent bg-[var(--accent-soft)] text-accent"
                : "border-line text-mut hover:text-txt",
            )}
          >
            {d.name}
          </button>
        ))}
        <Button size="sm" variant="secondary" onClick={copy} disabled={!sel.length} className="ml-auto">
          Copy to {sel.length || ""} deal{sel.length === 1 ? "" : "s"}
        </Button>
      </div>
      {done > 0 && (
        <p className="mt-1.5 text-[11px] text-green">
          Copied this budget to {done} deal{done === 1 ? "" : "s"} — overwrote their construction budget.
        </p>
      )}
    </div>
  );
}

function NumCell({
  label,
  value,
  onChange,
  strong,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  strong?: boolean;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[9px] uppercase tracking-wide text-faint">{label}</span>
      <NumberInput
        value={value}
        onChange={onChange}
        className={cx(inputCls, "w-full py-1 text-right text-[12px]", strong && "font-semibold text-txt")}
      />
    </label>
  );
}

function SelectCell({
  label,
  value,
  options,
  onChange,
  render,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  render?: (v: string) => string;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[9px] uppercase tracking-wide text-faint">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cx(inputCls, "w-full py-1 text-[12px]")}
      >
        {!options.includes(value) && <option value={value}>{render ? render(value) : value}</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {render ? render(o) : o}
          </option>
        ))}
      </select>
    </label>
  );
}
