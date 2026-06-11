"use client";

import { useTool } from "@/lib/hooks";
import { fmtDate, usd } from "@/lib/format";
import { Loading, Money, Stat } from "@/components/ui";
import { SparkLine } from "@/components/charts";

type Profile = {
  query: string;
  matched_merchants: string[];
  transaction_count: number;
  refund_count: number;
  total_spent: number;
  total_refunded: number;
  avg_ticket: number | null;
  max_ticket: number | null;
  first_seen: string | null;
  last_seen: string | null;
  categories: string[];
  tags: string[];
  monthly: Array<{ month: string; total: number }>;
  trend?: unknown;
  recent: Array<{ date: string; amount: number; merchant: string | null; name: string | null }>;
};

export function MerchantDrawer({ merchant, onClose }: { merchant: string | null; onClose(): void }) {
  const profile = useTool<Profile>(merchant ? "get_merchant_profile" : "", merchant ? { merchant } : {});
  if (!merchant) return null;
  const p = profile.data;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 w-[28rem] max-w-full overflow-y-auto border-l border-line bg-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{merchant}</h2>
          <button onClick={onClose} className="rounded-lg border border-line px-2.5 py-1 text-sm">✕</button>
        </div>
        {p ? (
          <>
            <div className="grid grid-cols-2 gap-4">
              <Stat label="Total spent" value={usd(p.total_spent)}
                sub={`${p.transaction_count} transactions`} />
              <Stat label="Avg ticket" value={usd(p.avg_ticket)}
                sub={p.max_ticket != null ? `max ${usd(p.max_ticket)}` : undefined} />
            </div>
            {p.total_refunded > 0 && (
              <div className="mt-2 text-sm text-green">refunded {usd(p.total_refunded)} ({p.refund_count})</div>
            )}
            <div className="mt-3 text-sm text-mut">
              first seen {fmtDate(p.first_seen)} · last {fmtDate(p.last_seen)}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {p.categories.map((c) => (
                <span key={c} className="rounded-full bg-line px-2 py-0.5 text-xs">{c}</span>
              ))}
              {p.tags.map((t) => (
                <span key={t} className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-semibold text-accent">{t}</span>
              ))}
            </div>
            {p.monthly.length > 1 && (
              <div className="mt-4">
                <div className="mb-1 text-xs uppercase tracking-wide text-mut">Monthly spend</div>
                <SparkLine data={p.monthly} dataKey="total" />
              </div>
            )}
            {p.matched_merchants.length > 1 && (
              <div className="mt-3 text-xs text-mut">matches: {p.matched_merchants.join(", ")}</div>
            )}
            <div className="mt-4">
              <div className="mb-1 text-xs uppercase tracking-wide text-mut">Recent</div>
              <table className="w-full text-sm">
                <tbody>
                  {p.recent.map((r, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="py-1.5 text-mut">{fmtDate(r.date)}</td>
                      <td className="py-1.5">{r.merchant ?? r.name ?? "—"}</td>
                      <td className="py-1.5 text-right"><Money amount={r.amount} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : profile.error ? (
          <div className="text-sm text-red">profile failed: {String((profile.error as Error).message)}</div>
        ) : <Loading />}
      </div>
    </>
  );
}
