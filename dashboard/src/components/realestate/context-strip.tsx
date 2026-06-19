"use client";

// The "one visibility" layer: the deal's own equity check, measured against
// your real balance sheet. Net worth comes from the latest dated balance
// snapshot (get_net_worth_history — a Postgres read in <1s), NOT the live
// get_net_worth, which recomposes balances across every Plaid item and takes
// ~30s+. A context strip only needs a rough proportion, and snapshots are
// written every sync (~6×/day), so a ≤4h-old figure is the right trade-off.
// Read-only; both tools already in the dashboard allowlist; no new tools.

import { useSession } from "next-auth/react";
import { useTool } from "@/lib/hooks";
import { permissionsForRoles, can } from "@/lib/rbac";
import { latestNetWorth, type NetWorthHistory } from "@/lib/networth";
import { usd } from "@/lib/format";
import { Badge, Skeleton, cx } from "@/components/ui";

type Position = { symbol: string; market_value: number };
type Portfolio = { total_value: number; cash_like_value: number; positions: Position[] };

const WALMART = new Set(["WALMART.RSU", "WMT"]);

function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "warn" | "ok";
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">{label}</div>
      <div
        className={cx(
          "nums mt-1 text-lg font-semibold tracking-tight",
          tone === "warn" ? "text-amber" : tone === "ok" ? "text-green" : "text-txt",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-mut">{sub}</div>}
    </div>
  );
}

/**
 * equityInr / usdRate come from the currently-selected deal. Both optional so
 * the strip also works deal-less (as a plain balance-sheet summary): when
 * equityInr is undefined the deal-specific tiles/comparisons are hidden and
 * only the general balance-sheet stats (net worth, Walmart concentration,
 * brokerage cash) are shown.
 */
export function ContextStrip({ equityInr, usdRate = 86 }: { equityInr?: number; usdRate?: number }) {
  // Live balance-sheet context needs portfolio + net-worth scopes. A
  // real-estate-only viewer (e.g. an invited family member) never sees it —
  // hidden here (client) AND denied by the API (server). Skip-token keeps the
  // hooks unconditional so Rules of Hooks hold before the early return.
  const { data: session } = useSession();
  const perms = permissionsForRoles(session?.user?.roles ?? []);
  const canSeeContext = can(perms, "networth:read") && can(perms, "investments:read");
  const nw = useTool<NetWorthHistory>(canSeeContext ? "get_net_worth_history" : "");
  const pf = useTool<Portfolio>(canSeeContext ? "get_portfolio_analysis" : "");
  if (!canSeeContext) return null;

  const hasDeal = equityInr !== undefined;
  const equityUsd = hasDeal ? equityInr! / usdRate : 0;
  const netWorth = latestNetWorth(nw.data);

  // MCP offline, or loaded but no snapshots written yet → graceful context line.
  if (nw.error || pf.error || (nw.data && netWorth === null)) {
    return (
      <div className="rounded-[var(--radius-lg)] border border-dashed border-line bg-card px-5 py-3 text-[13px] text-mut">
        {hasDeal ? (
          <>
            Deal equity <span className="nums font-semibold text-txt">{usd(equityUsd)}</span> · live portfolio
            context unavailable (start the MCP and run a sync to compare deal vs. net worth).
          </>
        ) : (
          <>Balance-sheet context unavailable (start the MCP and run a sync to populate net worth).</>
        )}
      </div>
    );
  }

  if (!nw.data || !pf.data) {
    return (
      <div className="grid grid-cols-2 gap-4 rounded-[var(--radius-lg)] border border-line bg-card px-5 py-4 sm:grid-cols-4">
        {Array.from({ length: hasDeal ? 4 : 3 }).map((_, i) => (
          <div key={i}>
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-5 w-24" />
          </div>
        ))}
      </div>
    );
  }

  // Data present + at least one snapshot, so netWorth is non-null here.
  const netWorthValue = netWorth as number;
  const brokerageCash = pf.data.cash_like_value;
  const walmart = pf.data.positions
    .filter((p) => WALMART.has(p.symbol))
    .reduce((s, p) => s + p.market_value, 0);

  const walmartPct = netWorthValue ? (walmart / netWorthValue) * 100 : 0;

  // Deal-specific derivations — only meaningful when a deal is selected.
  const equityPctNW = netWorthValue ? equityUsd / netWorthValue : 0;
  const liquidLeft = brokerageCash - equityUsd;
  const concentration = netWorthValue ? (equityUsd + walmart) / netWorthValue : 0;
  const concWarn = hasDeal && concentration >= 0.5;
  const liquidWarn = hasDeal && liquidLeft < equityUsd * 0.25; // thin buffer after funding

  return (
    <div className="rounded-[var(--radius-lg)] border border-line bg-card px-5 py-4 shadow-[var(--shadow-sm)]">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-mut">
          {hasDeal ? "One-visibility · deal vs. your balance sheet" : "Your balance sheet"}
        </span>
        {(concWarn || liquidWarn) && (
          <Badge tone="amber" dot>
            concentration risk
          </Badge>
        )}
      </div>
      <div className={cx("grid grid-cols-2 gap-x-6 gap-y-4", hasDeal ? "sm:grid-cols-4" : "sm:grid-cols-3")}>
        {hasDeal && (
          <Metric
            label="Deal equity"
            value={usd(equityUsd)}
            sub={`${(equityPctNW * 100).toFixed(0)}% of net worth`}
          />
        )}
        <Metric
          label="Net worth"
          value={usd(netWorthValue)}
          sub={`Walmart already ${walmartPct.toFixed(0)}%`}
        />
        <Metric
          label={hasDeal ? "Liquid left if funded from cash" : "Brokerage cash"}
          value={usd(hasDeal ? liquidLeft : brokerageCash)}
          sub={hasDeal ? `from ${usd(brokerageCash)} brokerage cash` : "liquid in brokerage"}
          tone={hasDeal ? (liquidWarn ? "warn" : "ok") : undefined}
        />
        {hasDeal ? (
          <Metric
            label="Real-estate + Walmart"
            value={`${(concentration * 100).toFixed(0)}%`}
            sub="of net worth, two concentrated bets"
            tone={concWarn ? "warn" : undefined}
          />
        ) : (
          <Metric
            label="Walmart concentration"
            value={`${walmartPct.toFixed(0)}%`}
            sub="of net worth, single concentrated bet"
            tone={walmartPct >= 30 ? "warn" : undefined}
          />
        )}
      </div>
    </div>
  );
}
