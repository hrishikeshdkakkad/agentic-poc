"use client";

import { useState } from "react";
import Link from "next/link";
import { useTool } from "@/lib/hooks";
import { fmtDate, usd } from "@/lib/format";
import { Badge, Balance, Card, Drawer, ErrorBanner, KpiCard, Loading, Money, SkeletonStats, WarningsBanner, Warning } from "@/components/ui";
import { SparkLine } from "@/components/charts";
import { IconAccounts, IconChevronRight, IconWallet } from "@/components/icons";

type Account = {
  account_id: string;
  institution: string | null;
  name: string | null;
  mask?: string | null;
  type?: string | null;
  subtype?: string | null;
  balance?: { current: number | null; available: number | null; limit: number | null; currency: string | null };
  source?: string;
};
type Accounts = { accounts: Account[]; warnings?: Warning[] };
type Query = { columns: string[]; rows: Array<Array<string | number | null>> };
type TxResp = { transactions: Array<{ transaction_id: string; date: string | null; amount: number; merchant: string | null; name: string | null }> };

function AccountDrawer({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const safe = (account?.account_id ?? "").replace(/'/g, "''");
  const history = useTool<Query>(account ? "query_finances" : "", account ? { sql: `SELECT snapshot_date, current FROM balance_snapshots WHERE account_id = '${safe}' ORDER BY snapshot_date` } : {});
  const txs = useTool<TxResp>(account ? "list_transactions" : "", account ? { account_id: account.account_id, limit: 12 } : {});
  const points = (history.data?.rows ?? []).map(([d, c]) => ({ date: String(d), current: Number(c) }));

  return (
    <Drawer open={!!account} onClose={onClose} title={account?.name ?? account?.subtype ?? "Account"} subtitle={account ? `${account.institution ?? ""}${account.mask ? ` ··${account.mask}` : ""}` : undefined}>
      {account && (
        <div className="space-y-5">
          <div className="rounded-[var(--radius)] border border-line bg-elevated p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-mut">Current balance</div>
            <div className="mt-1 text-3xl font-semibold tracking-tight">
              <Balance amount={account.balance?.current} />
            </div>
            <div className="mt-2 flex gap-4 text-[13px] text-mut">
              {account.balance?.available != null && <span>avail {usd(account.balance.available)}</span>}
              {account.balance?.limit != null && <span>limit {usd(account.balance.limit)}</span>}
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-mut">Balance history</span>
              <Link className="flex items-center gap-1 text-[13px] text-accent hover:underline" href={`/transactions?account_id=${account.account_id}`}>
                Transactions <IconChevronRight size={13} />
              </Link>
            </div>
            {history.data ? points.length > 1 ? <SparkLine data={points} dataKey="current" height={80} /> : <div className="text-sm text-mut">Not enough snapshots yet ({points.length}).</div> : <Loading />}
          </div>

          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-mut">Latest transactions</div>
            {txs.data ? (
              txs.data.transactions.length ? (
                <div className="overflow-hidden rounded-[var(--radius)] border border-line">
                  <table className="w-full text-sm">
                    <tbody>
                      {txs.data.transactions.map((t) => (
                        <tr key={t.transaction_id} className="border-t border-line first:border-0">
                          <td className="px-3 py-2 text-mut">{fmtDate(t.date)}</td>
                          <td className="px-3 py-2">{t.merchant ?? t.name ?? "—"}</td>
                          <td className="px-3 py-2 text-right">
                            <Money amount={t.amount} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-sm text-mut">No stored transactions.</div>
              )
            ) : (
              <Loading />
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

export default function AccountsPage() {
  const accounts = useTool<Accounts>("list_accounts");
  const [open, setOpen] = useState<Account | null>(null);

  const list = accounts.data?.accounts ?? [];
  const byInstitution = new Map<string, Account[]>();
  for (const a of list) {
    const k = a.institution ?? "Unknown";
    byInstitution.set(k, [...(byInstitution.get(k) ?? []), a]);
  }
  const totalBalance = list.reduce((s, a) => s + (a.balance?.current ?? 0), 0);

  return (
    <div className="space-y-4">
      <ErrorBanner error={accounts.error} />
      <WarningsBanner warnings={accounts.data?.warnings} />

      {accounts.data ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <KpiCard label="Total balance" value={<Balance amount={totalBalance} />} icon={<IconWallet size={15} />} accent />
          <KpiCard label="Accounts" value={list.length.toLocaleString()} icon={<IconAccounts size={15} />} />
          <KpiCard label="Institutions" value={byInstitution.size.toLocaleString()} />
        </div>
      ) : (
        <SkeletonStats n={3} />
      )}

      {accounts.data ? (
        [...byInstitution.entries()].map(([institution, accts]) => (
          <Card key={institution} title={institution} subtitle={`${accts.length} account${accts.length === 1 ? "" : "s"}`} noPad>
            <div className="divide-y divide-line">
              {accts.map((a) => (
                <button key={a.account_id} onClick={() => setOpen(a)} className="flex w-full items-center justify-between gap-4 px-5 py-3.5 text-left transition-colors hover:bg-hover">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-txt">{a.name ?? a.subtype ?? "account"}</span>
                      {a.mask && <span className="text-mut">··{a.mask}</span>}
                      {a.source === "csv_import" && <Badge tone="neutral">CSV</Badge>}
                    </div>
                    <div className="text-xs capitalize text-mut">{a.subtype ?? a.type}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <Balance amount={a.balance?.current} className="font-medium" />
                      {(a.balance?.available != null || a.balance?.limit != null) && (
                        <div className="text-xs text-mut">
                          {a.balance?.available != null && <>avail {usd(a.balance.available)}</>}
                          {a.balance?.available != null && a.balance?.limit != null && " · "}
                          {a.balance?.limit != null && <>limit {usd(a.balance.limit)}</>}
                        </div>
                      )}
                    </div>
                    <IconChevronRight size={16} className="text-faint" />
                  </div>
                </button>
              ))}
            </div>
          </Card>
        ))
      ) : accounts.error ? null : (
        <Loading />
      )}

      <AccountDrawer account={open} onClose={() => setOpen(null)} />
    </div>
  );
}
