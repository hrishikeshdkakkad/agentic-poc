"use client";

import type { Inputs, RateType, Repayment } from "@/lib/realestate/defaults";
import type { Strategy } from "@/lib/realestate/model";
import { cr, lakh, rate } from "@/lib/realestate/format";
import { constructionPerSqft, constructionTotal } from "@/lib/realestate/construction";
import { Button, Field, inputCls, NumberInput, Segmented, cx } from "@/components/ui";
import { FundingMix } from "@/components/realestate/funding-mix";

type Kind = "int" | "money" | "rate" | "pct";
// Only the scalar (number) inputs are driven by this flat grid; `investors` has
// its own editor (FundingMix), so exclude non-numeric keys at the type level.
type NumericKey = { [K in keyof Inputs]: Inputs[K] extends number ? K : never }[keyof Inputs];
type FieldDef = { key: NumericKey; label: string; kind: Kind; step?: number };
type Group = { title: string; fields: FieldDef[] };

const GROUPS: Group[] = [
  {
    title: "Project",
    fields: [
      { key: "plotArea", label: "Plot area (sqft)", kind: "int", step: 100 },
      { key: "far", label: "FAR", kind: "int", step: 0.5 },
      { key: "units", label: "Units", kind: "int", step: 1 },
    ],
  },
  {
    title: "Land & approvals",
    fields: [
      { key: "siteCost", label: "Site cost", kind: "money", step: 100000 },
      { key: "registration", label: "Registration", kind: "money", step: 10000 },
      { key: "brokerage", label: "Brokerage", kind: "money", step: 10000 },
      { key: "khata", label: "Khata", kind: "money", step: 5000 },
    ],
  },
  {
    title: "Build",
    fields: [{ key: "contingencyPct", label: "Contingency", kind: "pct", step: 1 }],
  },
  {
    title: "Financing",
    fields: [
      { key: "loanAmount", label: "Loan amount", kind: "money", step: 500000 },
      { key: "loanRate", label: "Loan rate (annual)", kind: "pct", step: 0.25 },
      { key: "loanMonths", label: "Loan months", kind: "int", step: 1 },
      { key: "loanTenureYears", label: "Tenure (yr)", kind: "int", step: 1 },
      { key: "processingFeePct", label: "Processing fee", kind: "pct", step: 0.1 },
      { key: "bpiDays", label: "BPI days", kind: "int", step: 1 },
    ],
  },
  {
    title: "Funding mix",
    fields: [{ key: "equity", label: "Your equity", kind: "money", step: 100000 }],
  },
  {
    title: "Pricing",
    fields: [
      { key: "baseSaleRate", label: "Base sale rate (₹/sqft)", kind: "rate", step: 250 },
      { key: "bridgePrice", label: "Bridge unit price (₹)", kind: "money", step: 100000 },
    ],
  },
];

function hint(kind: Kind, v: number): string | null {
  if (kind !== "money") return null;
  return v >= 1e7 ? cr(v) : lakh(v);
}

export function InputPanel({
  inputs,
  onChange,
  strategy,
  onStrategy,
  onReset,
  onEditBudget,
}: {
  inputs: Inputs;
  onChange: (patch: Partial<Inputs>) => void;
  strategy: Strategy;
  onStrategy: (s: Strategy) => void;
  onReset: () => void;
  onEditBudget: (origin: { x: number; y: number }) => void;
}) {
  return (
    <div className="space-y-5">
      <Field label="Exit strategy">
        <Segmented
          value={strategy}
          onChange={onStrategy}
          options={[
            { value: "sellAll", label: "Sell all 4" },
            { value: "hold1", label: "Sell 3, hold 1" },
          ]}
        />
      </Field>

      <div className="space-y-4">
        {GROUPS.map((g) => (
          <div key={g.title}>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-faint">
              {g.title}
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {g.fields.map((f) => {
                const v = inputs[f.key];
                const h = hint(f.kind, v);
                return (
                  <Field key={String(f.key)} label={f.label}>
                    <NumberInput
                      value={v}
                      scale={f.kind === "pct" ? 0.01 : 1}
                      onChange={(n) => onChange({ [f.key]: n } as Partial<Inputs>)}
                      className={cx(inputCls, "w-full text-right")}
                    />
                    {h && <span className="mt-0.5 text-right text-[10px] text-faint">{h}</span>}
                  </Field>
                );
              })}
            </div>
            {g.title === "Build" && (
              <div className="mt-3 flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-line bg-surface px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">
                    Construction budget
                  </div>
                  <div className="nums mt-0.5 text-[13px] font-semibold text-txt">
                    {cr(constructionTotal(inputs))}{" "}
                    <span className="font-normal text-mut">
                      · {rate(constructionPerSqft(inputs))}/sqft · {inputs.constructionExpenses?.length ?? 0} items
                    </span>
                  </div>
                </div>
                <Button size="sm" variant="secondary" onClick={(e) => onEditBudget({ x: e.clientX, y: e.clientY })}>
                  Edit →
                </Button>
              </div>
            )}
            {g.title === "Financing" && (
              <div className="mt-3 grid grid-cols-1 gap-2.5">
                <Field label="Rate type">
                  <Segmented<RateType>
                    size="sm"
                    layoutId="ip-rateType"
                    value={inputs.rateType}
                    onChange={(v) => onChange({ rateType: v })}
                    options={[
                      { value: "fixed", label: "Fixed" },
                      { value: "floating", label: "Floating" },
                    ]}
                  />
                </Field>
                <Field label="Repayment">
                  <Segmented<Repayment>
                    size="sm"
                    layoutId="ip-repayment"
                    value={inputs.repayment}
                    onChange={(v) => onChange({ repayment: v })}
                    options={[
                      { value: "interestOnly", label: "Interest-only" },
                      { value: "fullEMI", label: "Full EMI" },
                    ]}
                  />
                </Field>
              </div>
            )}
            {g.title === "Funding mix" && (
              <div className="mt-3">
                <FundingMix
                  investors={inputs.investors}
                  units={inputs.units}
                  onChange={(investors) => onChange({ investors })}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <Button size="sm" variant="ghost" onClick={onReset} className="w-full justify-center">
        Reset to defaults
      </Button>
    </div>
  );
}
