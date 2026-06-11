"use client";

import { useState } from "react";
import Link from "next/link";
import { useTool } from "@/lib/hooks";
import { fmtDate, usd } from "@/lib/format";
import { Balance, Card, ErrorBanner, Loading, Money, WarningsBanner, Warning } from "@/components/ui";
import { SparkLine } from "@/components/charts";

type Account = {
  handle?: string; account_id: string; institution: string | null; name: string | null;
  mask?: string | null; type?: string | null; subtype?: string | null;
  balance?: { current: number | null; available: number | null; limit: number | null; currency: string | null };
  source?: string;
};
type Accounts = { accounts: Account[]; warnings?: Warning[] };
type Query = { columns: string[]; rows: Array<Array<string | number | null>> };
type TxResp = {
  transactions: Array<{ transaction_id: string; date: string | null; amount: number;
    merchant: string | null; name: string | null; category_primary: string | null }>;
};

function AccountDetail({ accountId }: { accountId: string }) {
  // account_id comes from our own DB rows, but escape quotes anyway.
  const safe = accountId.replace(/'/g, "''");
  const history = useTool<Query>("query_finances", {
    sql: `SELECT snapshot_date, current FROM balance_snapshots WHERE account_id = '${safe}' ORDER BY snapshot_date`,
  });
  const txs = useTool<TxResp>("list_transactions", { account_id: accountId, limit: 10 });

  const points = (history.data?.rows ?? []).map(([d, c]) => ({ date: String(d), current: Number(c) }));

  return (
    <div className="border-t border-line bg-bg/40 px-4 py-3">
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wide text-mut">Balance history</span>
            <Link className="text-xs text-accent" href={`/transactions?account_id=${accountId}`}>
              View all transactions →
            </Link>
          </div>
          {history.data ? (
            points.length > 1
              ? <SparkLine data={points} dataKey="current" />
              : <div className="text-sm text-mut">Not enough snapshots yet ({points.length}).</div>
          ) : history.error ? <div className="text-sm text-mut">history unavailable</div> : <Loading />}
        </div>
        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-mut">Latest transactions</div>
          {txs.data ? (
            txs.data.transactions.length ? (
              <table className="w-full text-sm">
                <tbody>
                  {txs.data.transactions.map((t) => (
                    <tr key={t.transaction_id} className="border-t border-line first:border-0">
                      <td className="py-1.5 text-mut">{fmtDate(t.date)}</td>
                      <td className="py-1.5">{t.merchant ?? t.name ?? "—"}</td>
                      <td className="py-1.5 text-right"><Money amount={t.amount} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="text-sm text-mut">No stored transactions.</div>
          ) : txs.error ? null : <Loading />}
        </div>
      </div>
    </div>
  );
}

export default function AccountsPage() {
  const accounts = useTool<Accounts>("list_accounts");
  const [open, setOpen] = useState<string | null>(null);

  const byInstitution = new Map<string, Account[]>();
  for (const a of accounts.data?.accounts ?? []) {
    const k = a.institution ?? "Unknown";
    byInstitution.set(k, [...(byInstitution.get(k) ?? []), a]);
  }

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-1 text-xl font-bold">Accounts</h1>
      <p className="mb-6 text-sm text-mut">Every linked account — click one to drill into its history.</p>

      <ErrorBanner error={accounts.error} />
      <WarningsBanner warnings={accounts.data?.warnings} />

      {accounts.data ? (
        [...byInstitution.entries()].map(([institution, accts]) => (
          <Card key={institution} title={institution} className="mb-4">
            <div className="divide-y divide-line">
              {accts.map((a) => (
                <div key={a.account_id}>
                  <div className="flex cursor-pointer items-center justify-between gap-4 py-2.5 hover:bg-bg/50"
                    onClick={() => setOpen(open === a.account_id ? null : a.account_id)}>
                    <div>
                      <span className="font-medium">{a.name ?? a.subtype ?? "account"}</span>
                      {a.mask && <span className="ml-1.5 text-mut">••{a.mask}</span>}
                      <span className="ml-2 text-xs text-mut">{a.subtype ?? a.type}</span>
                      {a.source === "csv_import" && (
                        <span className="ml-2 rounded-full bg-mut/15 px-2 py-0.5 text-[10px] font-semibold text-mut">CSV</span>
                      )}
                    </div>
                    <div className="text-right">
                      <Balance amount={a.balance?.current} />
                      {(a.balance?.available != null || a.balance?.limit != null) && (
                        <div className="text-xs text-mut">
                          {a.balance?.available != null && <>avail {usd(a.balance.available)}</>}
                          {a.balance?.available != null && a.balance?.limit != null && " · "}
                          {a.balance?.limit != null && <>limit {usd(a.balance.limit)}</>}
                        </div>
                      )}
                    </div>
                  </div>
                  {open === a.account_id && <AccountDetail accountId={a.account_id} />}
                </div>
              ))}
            </div>
          </Card>
        ))
      ) : accounts.error ? null : <Loading />}
    </div>
  );
}
