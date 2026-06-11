"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTool } from "@/lib/hooks";
import { callTool } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import { Card, ErrorBanner, Loading, Money } from "@/components/ui";
import { MerchantDrawer } from "@/components/merchant-drawer";

const PAGE = 50;

type Tx = {
  transaction_id: string; account_id: string; date: string | null; amount: number;
  currency: string | null; merchant: string | null; name: string | null;
  category_primary: string | null; category_detailed: string | null;
  pending: boolean; tags: string[];
};
type TxResp = { transactions: Tx[]; total_matching: number };
type Accounts = { accounts: Array<{ account_id: string; institution: string; name: string; mask?: string }> };

function Explorer() {
  const sp = useSearchParams();
  const initial = {
    start_date: sp.get("start_date") ?? "",
    end_date: sp.get("end_date") ?? "",
    account_id: sp.get("account_id") ?? "",
    category: sp.get("category") ?? "",
    merchant_contains: sp.get("merchant") ?? "",
    min_amount: "", max_amount: "",
  };
  const [filters, setFilters] = useState(initial);
  const [applied, setApplied] = useState(initial);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<string | null>(null);
  const [overrideMsg, setOverrideMsg] = useState<Record<string, string>>({});

  const args: Record<string, unknown> = { limit: PAGE, offset };
  for (const [k, v] of Object.entries(applied)) {
    if (v === "") continue;
    args[k] = k === "min_amount" || k === "max_amount" ? Number(v) : v;
  }
  const txs = useTool<TxResp>("list_transactions", args);
  const accounts = useTool<Accounts>("list_accounts");
  const acctName = (id: string) => {
    const a = accounts.data?.accounts.find((x) => x.account_id === id);
    return a ? `${a.institution} ${a.name}${a.mask ? ` ••${a.mask}` : ""}` : id.slice(0, 12);
  };

  function apply() { setApplied(filters); setOffset(0); }

  async function fixCategory(tx: Tx, scope: "merchant" | "transaction", newPrimary: string) {
    if (!newPrimary) return;
    const match_value = scope === "merchant" ? (tx.merchant ?? tx.name ?? "") : tx.transaction_id;
    const res = await callTool<{ ok?: boolean; applied_to_transactions?: number; error?: { message: string } }>(
      "set_category_override",
      { match_type: scope, match_value, set_primary: newPrimary.toUpperCase().replace(/ /g, "_") },
    );
    setOverrideMsg((m) => ({
      ...m,
      [tx.transaction_id]: res.ok
        ? `✓ override saved — rewrote ${res.applied_to_transactions} transaction(s)`
        : `✗ ${res.error?.message ?? "failed"}`,
    }));
    txs.mutate();
  }

  const total = txs.data?.total_matching ?? 0;
  const inp = "rounded-md border border-line bg-bg px-2 py-1.5 text-sm w-full";

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-1 text-xl font-bold">Transactions</h1>
      <p className="mb-6 text-sm text-mut">Every stored transaction — filter, drill, correct.</p>
      <ErrorBanner error={txs.error} />

      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
          <input className={inp} type="date" value={filters.start_date}
            onChange={(e) => setFilters({ ...filters, start_date: e.target.value })} />
          <input className={inp} type="date" value={filters.end_date}
            onChange={(e) => setFilters({ ...filters, end_date: e.target.value })} />
          <select className={inp} value={filters.account_id}
            onChange={(e) => setFilters({ ...filters, account_id: e.target.value })}>
            <option value="">All accounts</option>
            {accounts.data?.accounts.map((a) => (
              <option key={a.account_id} value={a.account_id}>
                {a.institution} {a.name}{a.mask ? ` ••${a.mask}` : ""}
              </option>
            ))}
          </select>
          <input className={inp} placeholder="Category (e.g. FOOD_AND_DRINK)" value={filters.category}
            onChange={(e) => setFilters({ ...filters, category: e.target.value })} />
          <input className={inp} placeholder="Merchant contains…" value={filters.merchant_contains}
            onChange={(e) => setFilters({ ...filters, merchant_contains: e.target.value })} />
          <input className={inp} type="number" placeholder="Min $" value={filters.min_amount}
            onChange={(e) => setFilters({ ...filters, min_amount: e.target.value })} />
          <input className={inp} type="number" placeholder="Max $" value={filters.max_amount}
            onChange={(e) => setFilters({ ...filters, max_amount: e.target.value })} />
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-sm text-mut">{txs.data ? `${total.toLocaleString()} matching` : "…"}</span>
          <button onClick={apply}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-white">Apply filters</button>
        </div>
      </Card>

      <Card>
        {txs.data ? (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-mut">
                  <th className="py-2">Date</th><th>Merchant</th><th>Category</th>
                  <th>Account</th><th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {txs.data.transactions.map((t) => (
                  <TxRow key={t.transaction_id} t={t} expanded={expanded === t.transaction_id}
                    onToggle={() => setExpanded(expanded === t.transaction_id ? null : t.transaction_id)}
                    onMerchant={() => t.merchant && setDrawer(t.merchant)}
                    acctName={acctName} fixCategory={fixCategory}
                    msg={overrideMsg[t.transaction_id]} />
                ))}
              </tbody>
            </table>
            <div className="mt-4 flex items-center justify-between text-sm">
              <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}
                className="rounded-lg border border-line px-3 py-1.5 font-semibold disabled:opacity-40">← Prev</button>
              <span className="text-mut">{total ? `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total.toLocaleString()}` : "0 results"}</span>
              <button disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}
                className="rounded-lg border border-line px-3 py-1.5 font-semibold disabled:opacity-40">Next →</button>
            </div>
          </>
        ) : txs.error ? null : <Loading />}
      </Card>

      <MerchantDrawer merchant={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}

function TxRow({ t, expanded, onToggle, onMerchant, acctName, fixCategory, msg }: {
  t: Tx; expanded: boolean; onToggle(): void; onMerchant(): void;
  acctName(id: string): string;
  fixCategory(tx: Tx, scope: "merchant" | "transaction", v: string): Promise<void>;
  msg?: string;
}) {
  const [newCat, setNewCat] = useState("");
  return (
    <>
      <tr className="cursor-pointer border-t border-line hover:bg-bg/50" onClick={onToggle}>
        <td className="py-2 whitespace-nowrap">{fmtDate(t.date)}{t.pending && <span className="ml-1 text-xs text-amber">pending</span>}</td>
        <td className="py-2">
          <button className="text-left hover:text-accent"
            onClick={(e) => { e.stopPropagation(); onMerchant(); }}>
            {t.merchant ?? t.name ?? "—"}
          </button>
          {t.tags.map((tag) => (
            <span key={tag} className="ml-1.5 rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">{tag}</span>
          ))}
        </td>
        <td className="py-2 text-mut">{t.category_primary ?? "—"}</td>
        <td className="py-2 text-mut">{acctName(t.account_id)}</td>
        <td className="py-2 text-right"><Money amount={t.amount} /></td>
      </tr>
      {expanded && (
        <tr className="border-t border-line bg-bg/40">
          <td colSpan={5} className="px-3 py-3 text-sm">
            <div className="grid gap-1 text-mut md:grid-cols-2">
              <span>id: <code className="text-xs">{t.transaction_id}</code></span>
              <span>raw name: {t.name ?? "—"}</span>
              <span>detailed: {t.category_detailed ?? "—"}</span>
              <span>currency: {t.currency ?? "—"}</span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-mut">Fix category:</span>
              <input className="rounded-md border border-line bg-bg px-2 py-1 text-sm"
                placeholder="e.g. FOOD_AND_DRINK" value={newCat}
                onChange={(e) => setNewCat(e.target.value)}
                onClick={(e) => e.stopPropagation()} />
              <button className="rounded-lg border border-line px-2.5 py-1 text-xs font-semibold"
                onClick={(e) => { e.stopPropagation(); fixCategory(t, "transaction", newCat); }}>
                this transaction
              </button>
              <button className="rounded-lg border border-line px-2.5 py-1 text-xs font-semibold"
                onClick={(e) => { e.stopPropagation(); fixCategory(t, "merchant", newCat); }}>
                always for “{t.merchant ?? t.name}”
              </button>
              {msg && <span className="text-xs text-mut">{msg}</span>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function TransactionsPage() {
  return <Suspense fallback={<Loading />}><Explorer /></Suspense>;
}
