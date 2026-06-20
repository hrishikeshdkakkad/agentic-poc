"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Button, cx, inputCls, Segmented } from "@/components/ui";
import { IconCheck, IconChevronDown, IconClose, IconSearch } from "@/components/icons";

/* ───────────────────────────  types  ────────────────────────────────────── */

export type DateValue = { preset: string; start: string; end: string };
export type AmountValue = { min: string; max: string; direction: "all" | "out" | "in"; pendingOnly: boolean };
export type Opt = { value: string; label: string; count: number };

export const DATE_PRESETS: Array<{ key: string; label: string }> = [
  { key: "all", label: "All time" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "last_7", label: "Last 7 days" },
  { key: "last_30", label: "Last 30 days" },
  { key: "last_90", label: "Last 90 days" },
  { key: "ytd", label: "Year to date" },
  { key: "last_year", label: "Last year" },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function presetRange(v: DateValue): { start_date?: string; end_date?: string } {
  const now = new Date();
  const today = iso(now);
  switch (v.preset) {
    case "this_month":
      return { start_date: iso(new Date(now.getFullYear(), now.getMonth(), 1)), end_date: today };
    case "last_month":
      return {
        start_date: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        end_date: iso(new Date(now.getFullYear(), now.getMonth(), 0)),
      };
    case "last_7":
      return { start_date: iso(new Date(Date.now() - 7 * 864e5)), end_date: today };
    case "last_30":
      return { start_date: iso(new Date(Date.now() - 30 * 864e5)), end_date: today };
    case "last_90":
      return { start_date: iso(new Date(Date.now() - 90 * 864e5)), end_date: today };
    case "ytd":
      return { start_date: iso(new Date(now.getFullYear(), 0, 1)), end_date: today };
    case "last_year":
      return { start_date: iso(new Date(now.getFullYear() - 1, 0, 1)), end_date: iso(new Date(now.getFullYear() - 1, 11, 31)) };
    case "custom":
      return { start_date: v.start || undefined, end_date: v.end || undefined };
    default:
      return {};
  }
}

export function dateLabel(v: DateValue): string {
  if (v.preset === "custom") return `${v.start || "…"} → ${v.end || "…"}`;
  return DATE_PRESETS.find((p) => p.key === v.preset)?.label ?? "All time";
}

/* ───────────────────────────  popover shell  ────────────────────────────── */

function triggerCls(active: boolean) {
  return cx(
    "inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-2 text-[13px] font-medium transition-colors",
    active
      ? "border-[color-mix(in_oklab,var(--accent)_55%,transparent)] bg-[var(--accent-soft)] text-txt"
      : "border-line bg-surface text-mut hover:border-line-strong hover:text-txt",
  );
}

export function Popover({
  label,
  summary,
  active = false,
  align = "left",
  width = "16rem",
  children,
}: {
  label: React.ReactNode;
  summary?: React.ReactNode;
  active?: boolean;
  align?: "left" | "right";
  width?: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} className={triggerCls(active)}>
        <span className="whitespace-nowrap">{label}</span>
        {summary != null && (
          <span className="grid min-w-[18px] place-items-center rounded bg-accent px-1 text-[10px] font-bold text-[var(--accent-contrast)]">
            {summary}
          </span>
        )}
        <IconChevronDown size={14} className={cx("text-faint transition-transform", open && "rotate-180")} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            style={{ width }}
            className={cx(
              "absolute z-30 mt-2 overflow-hidden rounded-[var(--radius)] border border-line-strong bg-elevated shadow-[var(--shadow-lg)]",
              align === "right" ? "right-0" : "left-0",
            )}
          >
            {children(() => setOpen(false))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ───────────────────────────  multi-select  ─────────────────────────────── */

export function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: Opt[];
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
}) {
  const [q, setQ] = useState("");
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())) : options;
  const toggle = (v: string) => {
    const n = new Set(selected);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    onChange(n);
  };
  return (
    <Popover label={label} summary={selected.size || undefined} active={selected.size > 0} width="17rem">
      {() => (
        <div>
          {options.length > 7 && (
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <IconSearch size={14} className="text-mut" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={`Filter ${label.toLowerCase()}…`}
                className="w-full bg-transparent text-[13px] text-txt outline-none placeholder:text-faint"
                autoFocus
              />
            </div>
          )}
          <div className="max-h-64 overflow-y-auto p-1.5">
            {filtered.length === 0 ? (
              <div className="px-2 py-4 text-center text-xs text-mut">No matches</div>
            ) : (
              filtered.map((o) => {
                const on = selected.has(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => toggle(o.value)}
                    className="flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-left transition-colors hover:bg-hover"
                  >
                    <span
                      className={cx(
                        "grid h-4 w-4 shrink-0 place-items-center rounded border transition-colors",
                        on ? "border-accent bg-accent text-[var(--accent-contrast)]" : "border-line-strong",
                      )}
                    >
                      {on && <IconCheck size={11} />}
                    </span>
                    <span className="flex-1 truncate text-[13px] capitalize text-txt">{o.label}</span>
                    <span className="nums text-xs text-faint">{o.count}</span>
                  </button>
                );
              })
            )}
          </div>
          <div className="flex items-center justify-between border-t border-line px-3 py-2">
            <span className="text-xs text-mut">{selected.size} selected</span>
            <button
              type="button"
              disabled={selected.size === 0}
              onClick={() => onChange(new Set())}
              className="text-xs font-semibold text-accent disabled:opacity-40"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}

/* ───────────────────────────  date  ─────────────────────────────────────── */

export function DateRangeFilter({ value, onChange }: { value: DateValue; onChange: (v: DateValue) => void }) {
  const [start, setStart] = useState(value.start);
  const [end, setEnd] = useState(value.end);
  return (
    <Popover label={dateLabel(value)} active={value.preset !== "all"} width="18rem">
      {(close) => (
        <div className="p-1.5">
          <div className="grid grid-cols-2 gap-1">
            {DATE_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => {
                  onChange({ preset: p.key, start: "", end: "" });
                  close();
                }}
                className={cx(
                  "rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-hover",
                  value.preset === p.key ? "bg-[var(--accent-soft)] font-semibold text-accent" : "text-txt",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="mt-2 border-t border-line px-1.5 pt-2.5">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">Custom range</div>
            <div className="flex items-center gap-1.5">
              <input type="date" className={`${inputCls} w-full`} value={start} onChange={(e) => setStart(e.target.value)} />
              <span className="text-mut">–</span>
              <input type="date" className={`${inputCls} w-full`} value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="mt-2 w-full"
              disabled={!start && !end}
              onClick={() => {
                onChange({ preset: "custom", start, end });
                close();
              }}
            >
              Apply range
            </Button>
          </div>
        </div>
      )}
    </Popover>
  );
}

/* ───────────────────────────  amount + status  ──────────────────────────── */

export function AmountFilter({ value, onChange }: { value: AmountValue; onChange: (v: AmountValue) => void }) {
  const active = value.min !== "" || value.max !== "" || value.direction !== "all" || value.pendingOnly;
  return (
    <Popover label="Amount" active={active} width="17rem" summary={active ? "•" : undefined}>
      {() => (
        <div className="space-y-3 p-3">
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">Amount range</div>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                placeholder="Min $"
                className={`${inputCls} w-full`}
                value={value.min}
                onChange={(e) => onChange({ ...value, min: e.target.value })}
              />
              <span className="text-mut">–</span>
              <input
                type="number"
                placeholder="Max $"
                className={`${inputCls} w-full`}
                value={value.max}
                onChange={(e) => onChange({ ...value, max: e.target.value })}
              />
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">Direction</div>
            <Segmented
              size="sm"
              value={value.direction}
              onChange={(d) => onChange({ ...value, direction: d })}
              options={[
                { value: "all", label: "All" },
                { value: "out", label: "Money out" },
                { value: "in", label: "Money in" },
              ]}
            />
          </div>
          <label className="flex cursor-pointer items-center gap-2.5 pt-1">
            <span
              className={cx(
                "grid h-4 w-4 place-items-center rounded border transition-colors",
                value.pendingOnly ? "border-accent bg-accent text-[var(--accent-contrast)]" : "border-line-strong",
              )}
            >
              {value.pendingOnly && <IconCheck size={11} />}
            </span>
            <input type="checkbox" className="sr-only" checked={value.pendingOnly} onChange={(e) => onChange({ ...value, pendingOnly: e.target.checked })} />
            <span className="text-[13px] text-txt">Pending only</span>
          </label>
        </div>
      )}
    </Popover>
  );
}

/* ───────────────────────────  chips  ────────────────────────────────────── */

export function FilterChip({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-line bg-elevated py-1 pl-2.5 pr-1 text-xs font-medium text-txt">
      <span className="capitalize">{children}</span>
      <button type="button" onClick={onRemove} aria-label="Remove filter" className="grid h-4 w-4 place-items-center rounded-full text-mut transition-colors hover:bg-hover hover:text-txt">
        <IconClose size={11} />
      </button>
    </span>
  );
}
