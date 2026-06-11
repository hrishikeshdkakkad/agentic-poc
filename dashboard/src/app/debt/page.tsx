"use client";

import { useState } from "react";
import { useTool } from "@/lib/hooks";
import { fmtDate, pct, usd } from "@/lib/format";
import { Card, ErrorBanner, Loading, Stat, WarningsBanner, Warning } from "@/components/ui";

type Scenario = { monthly_payment: number; months: number | null; total_interest: number | null; verdict: string };
type Debt = {
  account_id: string; institution: string | null; name: string | null;
  liability_type: string; balance: number; apr_percentage: number | null;
  minimum_payment: number | null; next_payment_due_date: string | null;
  is_overdue: boolean | null; credit_limit: number | null;
  utilization_pct: number | null; monthly_interest_if_carried: number | null;
  payoff_scenarios: Scenario[] | null;
};
type DebtAnalysis = {
  as_of: string | null; debts: Debt[]; zero_balance_debts: number;
  total_debt: number; weighted_apr_percentage: number | null;
  total_monthly_interest_if_carried: number; total_minimum_payments: number;
};
type Liabilities = {
  credit: Array<Record<string, unknown>>;
  student: Array<Record<string, unknown>>;
  mortgage: Array<Record<string, unknown>>;
  warnings?: Warning[];
};

export default function DebtPage() {
  const [paymentInput, setPaymentInput] = useState("");
  const [payment, setPayment] = useState<number | null>(null);
  const debt = useTool<DebtAnalysis>("get_debt_analysis", payment ? { monthly_payment: payment } : {});
  const [showLive, setShowLive] = useState(false);
  const live = useTool<Liabilities>(showLive ? "get_liabilities" : "");
  const [openDebt, setOpenDebt] = useState<string | null>(null);

  const d = debt.data;

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-1 text-xl font-bold">Debt</h1>
      <p className="mb-6 text-sm text-mut">
        Every carried debt with its true carrying cost{d?.as_of ? ` (snapshot ${d.as_of})` : ""}.
      </p>
      <ErrorBanner error={debt.error} />

      <div className="mb-4 grid gap-4 md:grid-cols-4">
        <Card><Stat label="Total debt" value={usd(d?.total_debt)}
          sub={d?.zero_balance_debts ? `${d.zero_balance_debts} paid-off account(s) hidden` : undefined} /></Card>
        <Card><Stat label="Weighted APR" value={pct(d?.weighted_apr_percentage)} /></Card>
        <Card><Stat label="Monthly interest if carried" value={usd(d?.total_monthly_interest_if_carried)} /></Card>
        <Card><Stat label="Minimum payments" value={usd(d?.total_minimum_payments)} /></Card>
      </div>

      <Card title="Carried debts"
        right={
          <form className="flex gap-2"
            onSubmit={(e) => { e.preventDefault(); setPayment(Number(paymentInput) || null); }}>
            <input className="w-36 rounded-md border border-line bg-bg px-2 py-1 text-sm"
              type="number" placeholder="Simulate $/mo" value={paymentInput}
              onChange={(e) => setPaymentInput(e.target.value)} />
            <button className="rounded-lg border border-line px-3 py-1 text-sm font-semibold">Simulate</button>
          </form>
        }>
        {d ? (
          d.debts.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-mut">
                  <th className="py-2">Debt</th><th>Type</th><th className="text-right">Balance</th>
                  <th className="text-right">APR</th><th className="text-right">Min pay</th>
                  <th className="text-right">Utilization</th><th className="text-right">Interest/mo</th>
                </tr>
              </thead>
              <tbody>
                {d.debts.map((row) => (
                  <DebtRow key={`${row.account_id}-${row.liability_type}`} row={row}
                    open={openDebt === row.account_id}
                    onToggle={() => setOpenDebt(openDebt === row.account_id ? null : row.account_id)} />
                ))}
              </tbody>
            </table>
          ) : <div className="text-mut">No carried debt. 🎉</div>
        ) : debt.error ? null : <Loading />}
        <p className="mt-3 text-xs text-mut">
          Click a debt to see payoff scenarios. Add a monthly payment above to simulate your own plan.
        </p>
      </Card>

      <Card className="mt-4" title="Live liability detail"
        right={
          <button onClick={() => setShowLive(!showLive)}
            className="rounded-lg border border-line px-3 py-1.5 text-sm font-semibold">
            {showLive ? "Hide" : "Load (live Plaid)"}
          </button>
        }>
        {!showLive ? (
          <div className="text-sm text-mut">Statement balances, due dates, and overdue flags straight from each institution.</div>
        ) : live.data ? (
          <>
            <WarningsBanner warnings={live.data.warnings} />
            {(["credit", "student", "mortgage"] as const).map((kind) =>
              live.data![kind].length ? (
                <div key={kind} className="mb-4">
                  <div className="mb-1 text-xs uppercase tracking-wide text-mut">{kind}</div>
                  {live.data![kind].map((item, i) => (
                    <div key={i} className="grid gap-x-6 gap-y-1 border-t border-line py-2 text-sm md:grid-cols-3">
                      {Object.entries(item)
                        .filter(([k, v]) => v != null && k !== "account_id")
                        .map(([k, v]) => (
                          <div key={k} className="flex justify-between gap-3">
                            <span className="text-mut">{k.replace(/_/g, " ")}</span>
                            <span>{typeof v === "number" ? (k.includes("percentage") ? pct(v) : usd(v)) : String(v)}</span>
                          </div>
                        ))}
                    </div>
                  ))}
                </div>
              ) : null,
            )}
          </>
        ) : live.error ? <ErrorBanner error={live.error} /> : <Loading />}
      </Card>
    </div>
  );
}

function DebtRow({ row, open, onToggle }: { row: Debt; open: boolean; onToggle(): void }) {
  return (
    <>
      <tr className="cursor-pointer border-t border-line hover:bg-bg/50" onClick={onToggle}>
        <td className="py-2 font-medium">
          {row.institution ?? "?"} {row.name ?? ""}
          {row.is_overdue && <span className="ml-2 rounded-full bg-red/15 px-2 py-0.5 text-[10px] font-semibold text-red">OVERDUE</span>}
        </td>
        <td className="py-2 text-mut">{row.liability_type}</td>
        <td className="py-2 text-right">{usd(row.balance)}</td>
        <td className="py-2 text-right text-mut">{pct(row.apr_percentage)}</td>
        <td className="py-2 text-right text-mut">{usd(row.minimum_payment)}</td>
        <td className={`py-2 text-right ${row.utilization_pct != null && row.utilization_pct > 30 ? "text-red" : "text-mut"}`}>
          {pct(row.utilization_pct)}
        </td>
        <td className="py-2 text-right text-mut">{usd(row.monthly_interest_if_carried)}</td>
      </tr>
      {open && (
        <tr className="border-t border-line bg-bg/40">
          <td colSpan={7} className="px-3 py-3">
            {row.next_payment_due_date && (
              <div className="mb-2 text-sm text-mut">next payment due {fmtDate(row.next_payment_due_date)}</div>
            )}
            {row.payoff_scenarios?.length ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-mut">
                    <th className="py-1">Payment/mo</th><th>Months to payoff</th>
                    <th className="text-right">Total interest</th><th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {row.payoff_scenarios.map((s, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="py-1.5">{usd(s.monthly_payment)}</td>
                      <td className="py-1.5">{s.months ?? "—"}</td>
                      <td className="py-1.5 text-right">{usd(s.total_interest)}</td>
                      <td className="py-1.5 text-mut">{s.verdict}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="text-sm text-mut">No APR on file — scenarios unavailable.</div>}
          </td>
        </tr>
      )}
    </>
  );
}
