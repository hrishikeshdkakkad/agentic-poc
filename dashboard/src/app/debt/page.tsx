"use client";

import { useMemo, useState } from "react";
import { useTool } from "@/lib/hooks";
import { fmtDate, pct, usd } from "@/lib/format";
import {
  Badge,
  Button,
  Card,
  Drawer,
  EmptyState,
  ErrorBanner,
  inputCls,
  KpiCard,
  Loading,
  SkeletonStats,
  WarningsBanner,
  Warning,
} from "@/components/ui";
import {
  ChipCell,
  DataCard,
  numCol,
  pctFormatter,
  usdFormatter,
  type ColDef,
} from "@/components/data-grid";
import { IconAlert, IconDebt } from "@/components/icons";

type Scenario = { monthly_payment: number; months: number | null; total_interest: number | null; verdict: string };
type Debt = {
  account_id: string;
  institution: string | null;
  name: string | null;
  liability_type: string;
  balance: number;
  apr_percentage: number | null;
  minimum_payment: number | null;
  next_payment_due_date: string | null;
  is_overdue: boolean | null;
  credit_limit: number | null;
  utilization_pct: number | null;
  monthly_interest_if_carried: number | null;
  payoff_scenarios: Scenario[] | null;
};
type DebtAnalysis = {
  as_of: string | null;
  debts: Debt[];
  zero_balance_debts: number;
  total_debt: number;
  weighted_apr_percentage: number | null;
  total_monthly_interest_if_carried: number;
  total_minimum_payments: number;
};
type Liabilities = {
  credit: Array<Record<string, unknown>>;
  student: Array<Record<string, unknown>>;
  mortgage: Array<Record<string, unknown>>;
  warnings?: Warning[];
};

function UtilCell(p: { value: number | null }) {
  if (p.value == null) return <span className="ag-cell-num text-faint">—</span>;
  const hot = p.value > 30;
  return <span className={`ag-cell-num ${hot ? "text-red" : "text-mut"}`}>{pct(p.value)}</span>;
}

export default function DebtPage() {
  const [paymentInput, setPaymentInput] = useState("");
  const [payment, setPayment] = useState<number | null>(null);
  const debt = useTool<DebtAnalysis>("get_debt_analysis", payment ? { monthly_payment: payment } : {});
  const [showLive, setShowLive] = useState(false);
  const live = useTool<Liabilities>(showLive ? "get_liabilities" : "");
  const [openDebt, setOpenDebt] = useState<Debt | null>(null);

  const d = debt.data;

  const cols = useMemo<ColDef[]>(
    () => [
      {
        field: "institution",
        headerName: "Debt",
        flex: 2,
        minWidth: 200,
        pinned: "left",
        cellRenderer: (c: { data: Debt }) => (
          <span className="flex items-center gap-2">
            <span className="font-medium text-txt">
              {c.data.institution ?? "?"} {c.data.name ?? ""}
            </span>
            {c.data.is_overdue && <Badge tone="red">overdue</Badge>}
          </span>
        ),
      },
      { field: "liability_type", headerName: "Type", flex: 1, minWidth: 120, cellRenderer: ChipCell },
      { field: "balance", headerName: "Balance", ...numCol(), width: 130, valueFormatter: usdFormatter },
      { field: "apr_percentage", headerName: "APR", ...numCol(), width: 100, valueFormatter: pctFormatter },
      { field: "minimum_payment", headerName: "Min pay", ...numCol(), width: 120, valueFormatter: usdFormatter },
      { field: "utilization_pct", headerName: "Utilization", ...numCol(), width: 120, cellRenderer: UtilCell },
      { field: "monthly_interest_if_carried", headerName: "Interest/mo", ...numCol(), width: 130, valueFormatter: usdFormatter },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <ErrorBanner error={debt.error} />

      {d ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard label="Total debt" value={usd(d.total_debt)} icon={<IconDebt size={15} />} footnote={d.zero_balance_debts ? `${d.zero_balance_debts} paid-off hidden` : undefined} accent />
          <KpiCard label="Weighted APR" value={pct(d.weighted_apr_percentage)} />
          <KpiCard label="Interest / mo" value={usd(d.total_monthly_interest_if_carried)} footnote="if carried" />
          <KpiCard label="Minimum payments" value={usd(d.total_minimum_payments)} footnote="per month" />
        </div>
      ) : debt.error ? null : (
        <SkeletonStats n={4} />
      )}

      {d ? (
        d.debts.length ? (
          <DataCard<Debt>
            title="Carried debts"
            subtitle={`Click a row for payoff scenarios${d.as_of ? ` · snapshot ${d.as_of}` : ""}`}
            icon={<IconDebt size={16} />}
            rowData={d.debts}
            columnDefs={cols}
            getRowId={(p) => `${p.data.account_id}-${p.data.liability_type}`}
            onRowClicked={(e) => setOpenDebt(e.data)}
            countLabel="debts"
            exportName="debts"
            pagination={false}
            height={Math.min(480, 120 + d.debts.length * 44)}
            actions={
              <form
                className="flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  setPayment(Number(paymentInput) || null);
                }}
              >
                <input className={`${inputCls} w-32`} type="number" placeholder="Simulate $/mo" value={paymentInput} onChange={(e) => setPaymentInput(e.target.value)} />
                <Button type="submit" size="sm" variant="secondary">
                  Simulate
                </Button>
              </form>
            }
          />
        ) : (
          <Card>
            <EmptyState icon={<IconDebt size={20} />} title="No carried debt 🎉" description="Every balance is paid off. Nothing accruing interest." />
          </Card>
        )
      ) : debt.error ? null : (
        <Loading />
      )}

      <Card
        title="Live liability detail"
        subtitle="Statement balances, due dates, and overdue flags straight from each institution"
        right={
          <Button variant="secondary" size="sm" onClick={() => setShowLive(!showLive)}>
            {showLive ? "Hide" : "Load (live Plaid)"}
          </Button>
        }
      >
        {!showLive ? (
          <div className="text-sm text-mut">On-demand — pulls fresh data directly from each bank.</div>
        ) : live.data ? (
          <>
            <WarningsBanner warnings={live.data.warnings} />
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {(["credit", "student", "mortgage"] as const).flatMap((kind) =>
                live.data![kind].map((item, i) => (
                  <div key={`${kind}-${i}`} className="rounded-[var(--radius)] border border-line bg-elevated p-4">
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-mut">{kind}</div>
                    <dl className="space-y-1.5 text-sm">
                      {Object.entries(item)
                        .filter(([k, v]) => v != null && k !== "account_id")
                        .map(([k, v]) => (
                          <div key={k} className="flex justify-between gap-3">
                            <dt className="text-mut">{k.replace(/_/g, " ")}</dt>
                            <dd className="nums font-medium text-txt">{typeof v === "number" ? (k.includes("percentage") ? pct(v) : usd(v)) : String(v)}</dd>
                          </div>
                        ))}
                    </dl>
                  </div>
                )),
              )}
            </div>
          </>
        ) : live.error ? (
          <ErrorBanner error={live.error} />
        ) : (
          <Loading />
        )}
      </Card>

      <Drawer open={!!openDebt} onClose={() => setOpenDebt(null)} title={openDebt ? `${openDebt.institution ?? "?"} ${openDebt.name ?? ""}` : undefined} subtitle={openDebt?.liability_type}>
        {openDebt && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <KpiCard label="Balance" value={usd(openDebt.balance)} />
              <KpiCard label="APR" value={pct(openDebt.apr_percentage)} />
            </div>
            {openDebt.next_payment_due_date && (
              <div className="flex items-center gap-2 rounded-[var(--radius)] border border-line bg-elevated px-4 py-3 text-sm">
                <IconAlert size={16} className="text-amber" />
                <span className="text-mut">Next payment due</span>
                <span className="font-medium text-txt">{fmtDate(openDebt.next_payment_due_date)}</span>
              </div>
            )}
            <div>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-mut">Payoff scenarios</div>
              {openDebt.payoff_scenarios?.length ? (
                <div className="overflow-hidden rounded-[var(--radius)] border border-line">
                  <table className="w-full text-sm">
                    <thead className="bg-elevated text-left text-[11px] uppercase tracking-wide text-mut">
                      <tr>
                        <th className="px-3 py-2 font-semibold">Payment</th>
                        <th className="px-3 py-2 font-semibold">Months</th>
                        <th className="px-3 py-2 text-right font-semibold">Interest</th>
                      </tr>
                    </thead>
                    <tbody>
                      {openDebt.payoff_scenarios.map((s, i) => (
                        <tr key={i} className="border-t border-line">
                          <td className="nums px-3 py-2">{usd(s.monthly_payment)}/mo</td>
                          <td className="nums px-3 py-2">{s.months ?? "—"}</td>
                          <td className="nums px-3 py-2 text-right">{usd(s.total_interest)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-sm text-mut">No APR on file — scenarios unavailable.</div>
              )}
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
