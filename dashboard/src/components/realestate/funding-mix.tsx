"use client";

// Editor for the deal's outside money — any number of investors, each paid in
// one or more dated tranches. Replaces the old hardcoded "Manoj tranche 1/2"
// fields. Two kinds (see ./lib/realestate/defaults Investor):
//   • Unit buyer  — pre-buys N units at a fixed price = Σ tranches.
//   • Capital      — funds the build for an annual return; takes no unit.
// Every edit produces a fresh investors array and hands it up via onChange; the
// component holds no state of its own.

import type { Investor, InvestorKind, Tranche } from "@/lib/realestate/defaults";
import { CF_MONTHS } from "@/lib/realestate/defaults";
import { newId } from "@/lib/realestate/deals";
import { cr, lakh } from "@/lib/realestate/format";
import { Button, inputCls, Segmented, cx } from "@/components/ui";

const moneyHint = (v: number) => (Math.abs(v) >= 1e7 ? cr(v) : lakh(v));
const sumTranches = (v: Investor) => v.tranches.reduce((a, t) => a + t.amount, 0);

function blankInvestor(kind: InvestorKind): Investor {
  const base = { id: newId(), tranches: [{ amount: 0, month: 0 }] };
  return kind === "unit"
    ? { ...base, name: "New buyer", kind, units: 1 }
    : { ...base, name: "New partner", kind, returnPct: 0.18 };
}

export function FundingMix({
  investors,
  units,
  onChange,
}: {
  investors: Investor[];
  units: number;
  onChange: (next: Investor[]) => void;
}) {
  const patch = (id: string, p: Partial<Investor>) =>
    onChange(investors.map((v) => (v.id === id ? { ...v, ...p } : v)));

  const patchTranche = (id: string, idx: number, p: Partial<Tranche>) =>
    patchTranches(id, (ts) => ts.map((t, i) => (i === idx ? { ...t, ...p } : t)));

  const patchTranches = (id: string, fn: (ts: Tranche[]) => Tranche[]) =>
    onChange(investors.map((v) => (v.id === id ? { ...v, tranches: fn(v.tranches) } : v)));

  const prebuyUnits = investors
    .filter((v) => v.kind === "unit")
    .reduce((s, v) => s + (v.units ?? 1), 0);
  const maxPrebuyUnits = Math.max(0, units - 1);
  const totalCapital = investors.reduce((s, v) => s + sumTranches(v), 0);

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-faint">
          Co-investors
        </div>
        <div className="nums text-[10px] text-faint">
          {prebuyUnits}/{units} units · {cr(totalCapital)}
        </div>
      </div>

      <div className="space-y-2.5">
        {investors.map((v) => (
          <div
            key={v.id}
            className="rounded-[var(--radius-sm)] border border-line bg-surface/60 p-2.5"
          >
            {/* name + remove */}
            <div className="mb-2 flex items-center gap-2">
              <input
                value={v.name}
                onChange={(e) => patch(v.id, { name: e.target.value })}
                className={cx(inputCls, "min-w-0 flex-1")}
                placeholder="Investor name"
                aria-label="Investor name"
              />
              <button
                type="button"
                onClick={() => onChange(investors.filter((x) => x.id !== v.id))}
                className="shrink-0 rounded-[6px] px-1.5 py-1 text-faint transition-colors hover:bg-hover hover:text-red"
                aria-label={`Remove ${v.name || "investor"}`}
                title="Remove investor"
              >
                ✕
              </button>
            </div>

            {/* kind toggle + the field that only its kind needs */}
            <div className="mb-2 flex items-end justify-between gap-2">
              {/*
                Unit pre-buys must leave at least one market-sale unit. Without
                that, sale-rate KPIs and downside ladders are undefined.
              */}
              <Segmented<InvestorKind>
                size="sm"
                layoutId={`kind-${v.id}`}
                value={v.kind}
                onChange={(k) => {
                  if (k === "capital") {
                    patch(v.id, { kind: "capital", returnPct: v.returnPct ?? 0.18 });
                    return;
                  }
                  const currentUnits = v.kind === "unit" ? v.units ?? 1 : 0;
                  const available = maxPrebuyUnits - (prebuyUnits - currentUnits);
                  if (available < 1) return;
                  patch(v.id, { kind: "unit", units: Math.min(v.units ?? 1, available) });
                }}
                options={[
                  { value: "unit", label: "Unit buyer" },
                  { value: "capital", label: "Capital" },
                ]}
              />
              {v.kind === "unit" ? (
                (() => {
                  const currentUnits = v.units ?? 1;
                  const otherPrebuys = prebuyUnits - currentUnits;
                  const maxUnits = Math.max(1, maxPrebuyUnits - otherPrebuys);
                  return (
                    <label className="flex flex-col items-end gap-1 text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">
                      Units
                      <input
                        type="number"
                        min={1}
                        max={maxUnits}
                        step={1}
                        value={v.units ?? 1}
                        onChange={(e) =>
                          patch(v.id, {
                            units: Math.min(
                              maxUnits,
                              Math.max(1, Math.round(Number(e.target.value) || 1)),
                            ),
                          })
                        }
                        className={cx(inputCls, "w-14 text-right")}
                      />
                    </label>
                  );
                })()
              ) : (
                <label className="flex flex-col items-end gap-1 text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">
                  Return %/yr
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={+(((v.returnPct ?? 0) * 100).toFixed(4))}
                    onChange={(e) => patch(v.id, { returnPct: Math.max(0, Number(e.target.value) || 0) / 100 })}
                    className={cx(inputCls, "w-16 text-right")}
                  />
                </label>
              )}
            </div>

            {/* tranches: amount + which quarter it lands on */}
            <div className="space-y-1.5">
              {v.tranches.map((t, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step={100000}
                    value={t.amount}
                    onChange={(e) => patchTranche(v.id, idx, { amount: Math.max(0, Number(e.target.value) || 0) })}
                    className={cx(inputCls, "min-w-0 flex-1 text-right")}
                    placeholder="Amount"
                    aria-label="Tranche amount"
                  />
                  <select
                    value={t.month}
                    onChange={(e) => patchTranche(v.id, idx, { month: Number(e.target.value) })}
                    className={cx(inputCls, "w-[66px] text-right")}
                    aria-label="Tranche month"
                  >
                    {CF_MONTHS.map((m) => (
                      <option key={m} value={m}>
                        M{m}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => patchTranches(v.id, (ts) => ts.filter((_, i) => i !== idx))}
                    className="shrink-0 rounded-[6px] px-1.5 py-1 text-faint transition-colors hover:bg-hover hover:text-red"
                    aria-label="Remove tranche"
                    title="Remove tranche"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div className="flex items-center justify-between pt-0.5">
                <button
                  type="button"
                  onClick={() =>
                    patchTranches(v.id, (ts) => [
                      ...ts,
                      { amount: 0, month: ts.length ? ts[ts.length - 1].month : 0 },
                    ])
                  }
                  className="text-[11px] font-medium text-accent hover:underline"
                >
                  + tranche
                </button>
                {v.tranches.length > 0 && (
                  <span className="nums text-[10px] text-faint">{moneyHint(sumTranches(v))}</span>
                )}
              </div>
            </div>
          </div>
        ))}

        {investors.length === 0 && (
          <p className="rounded-[var(--radius-sm)] border border-dashed border-line px-2.5 py-3 text-center text-[11px] text-faint">
            No co-investors — the build is funded by your equity and the loan alone.
          </p>
        )}
      </div>

      {/* add */}
      <div className="mt-2.5 flex gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={prebuyUnits >= maxPrebuyUnits}
          onClick={() => onChange([...investors, blankInvestor("unit")])}
        >
          + Unit buyer
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onChange([...investors, blankInvestor("capital")])}
        >
          + Capital partner
        </Button>
      </div>
    </div>
  );
}
