# Dashboard Drill-Down Pages (Plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the seven drill-down pages (net worth, transactions, spending, accounts, investments, debt, cash flow) on the Plan-A foundation, completing "super intense visibility" into the finance data.

**Architecture:** Each page is a client component using `useTool` (SWR → `/api/mcp/[tool]`). Charts via Recharts wrappers in `src/components/charts.tsx`. The transactions explorer is the hub: every other page deep-links into it via URL query params (`/transactions?category=…`, `?account_id=…`, `?merchant=…`).

**Tech Stack:** Existing Plan-A stack; Recharts 3.

**Granularity note:** The foundation (hooks, UI kit, BFF) is built and verified; response shapes below were read from the Python source (`analytics.py`, `wealth.py`, `insights.py`, `server.py`) and smoke-checked live. Tasks specify exact tools, args, fields, and interactions; full code is inlined only where behavior is non-obvious (charts, explorer state, override editor). Verification for every task: `npm run build` + live render check; `npm test` stays green.

**Key response shapes (single source of truth for all tasks):**

- `get_net_worth_history` → `{history: [{date, assets, liabilities, net_worth}]}`
- `get_net_worth_trajectory(milestone?, months?)` → `{estimated_monthly_change, estimate_source, milestone: {…}, …}` (render defensively)
- `list_transactions(start_date?, end_date?, account_id?, category?, merchant_contains?, min_amount?, max_amount?, include_pending?, limit?, offset?)` → `{transactions: [{transaction_id, account_id, date, amount, currency, merchant, name, category_primary, category_detailed, pending, tags[]}], total_matching, limit, offset}`
- `aggregate_spending(start_date, end_date, group_by: "category"|"merchant", monthly: bool)` → `{rows: [{month?, category|merchant, total, transaction_count}], grand_total}`
- `compare_periods(period_a: "YYYY-MM", period_b)` → `{total_a, total_b, delta, delta_pct, by_category: [{category, a, b, delta}…], by_merchant: […]}`
- `set_category_override(match_type: "merchant"|"transaction", match_value, set_primary?, set_detailed?, note?)` → `{ok, applied_to_transactions}` or `{error}`
- `get_merchant_profile(merchant)` → `{query, matched_merchants[], transaction_count, total_spent, total_refunded, avg_ticket, max_ticket, first_seen, last_seen, categories[], tags[], monthly: [{month, total, …}], trend, recent[]}`
- `list_accounts` → `{accounts: [{handle, account_id, institution, name, mask, type, subtype, balance:{current, available, limit, currency}, source?}], warnings}`
- `query_finances(sql)` → `{columns[], rows[][], row_count}` (read-only SELECT, ≤500 rows)
- `get_portfolio_analysis` → `{as_of, total_value, cash_like_value, invested_value, positions: [{symbol, name, security_type, quantity, market_value, weight_pct, cost_basis, basis_known, unrealized_gain, unrealized_pct, cash_like, accounts}], allocation_by_type: {type: value}, concentration: {top_position, top5_weight_pct}, basis_coverage_pct, total_unrealized_gain}`
- `get_investment_transactions(start_date?, end_date?)` → `{investment_transactions: […], warnings}` (live Plaid)
- `get_debt_analysis(monthly_payment?)` → `{debts: [{institution, name?, liability_type, balance, apr_percentage, minimum_payment, utilization_pct, monthly_interest_if_carried, payoff_scenarios?}], total_debt, weighted_apr_percentage, total_monthly_interest_if_carried, total_minimum_payments, zero_balance_debts}`
- `get_liabilities` → `{credit: […], student: […], mortgage: […], warnings}` (live Plaid; per-type fields in server.py:312)
- `get_income_analysis(months?)` → `{months: [{month, partial, income, expenses, net, inflows_total, by_bucket}], estimated_monthly_income, avg_monthly_expenses, savings_rate, by_bucket, top_sources: [{source, bucket, total, count}], caveats[]}`
- `get_recurring_analysis(months?)` → `{streams: [{merchant, category, cadence, occurrences, first_date, last_date, next_expected_date, latest_amount, median_amount, is_fixed_amount, price_change: {pct, from, to}|null, annualized_cost, monthly_equivalent}], monthly_recurring_total, annual_recurring_total, price_increases[]}`

---

### Task 1: Chart wrappers

**Files:** Create `dashboard/src/components/charts.tsx`

- [ ] **Step 1: Implement** three wrappers with the dashboard palette (axes/grid `#262b33`, text `#9aa3b2`, tooltip bg `#181b21`):

```tsx
"use client";

import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { usd } from "@/lib/format";

const AXIS = { stroke: "#262b33", tick: { fill: "#9aa3b2", fontSize: 12 } };
const TOOLTIP = {
  contentStyle: { background: "#181b21", border: "1px solid #262b33", borderRadius: 8 },
  labelStyle: { color: "#9aa3b2" },
};
const PALETTE = ["#4c8bf5", "#2ecc71", "#f5a623", "#ff5b5b", "#a78bfa", "#34d399",
                 "#f472b6", "#60a5fa", "#fbbf24", "#9aa3b2"];

export function NetWorthChart({ data }: {
  data: Array<{ date: string; assets: number; liabilities: number; net_worth: number }>;
}) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={data}>
        <CartesianGrid stroke="#262b33" strokeDasharray="3 3" />
        <XAxis dataKey="date" {...AXIS} />
        <YAxis {...AXIS} tickFormatter={(v: number) => usd(v)} width={90} />
        <Tooltip {...TOOLTIP} formatter={(v) => usd(Number(v))} />
        <Legend />
        <Area type="monotone" dataKey="assets" stroke="#2ecc71" fill="#2ecc71" fillOpacity={0.08} />
        <Area type="monotone" dataKey="liabilities" stroke="#ff5b5b" fill="#ff5b5b" fillOpacity={0.08} />
        <Area type="monotone" dataKey="net_worth" stroke="#4c8bf5" fill="#4c8bf5" fillOpacity={0.15} strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Stacked monthly bars; series = distinct group names. onBarClick gets the group name. */
export function StackedMonthlyBars({ data, series, onBarClick }: {
  data: Array<Record<string, number | string>>; series: string[];
  onBarClick?: (group: string) => void;
}) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      <BarChart data={data}>
        <CartesianGrid stroke="#262b33" strokeDasharray="3 3" />
        <XAxis dataKey="month" {...AXIS} />
        <YAxis {...AXIS} tickFormatter={(v: number) => usd(v)} width={90} />
        <Tooltip {...TOOLTIP} formatter={(v) => usd(Number(v))} />
        <Legend />
        {series.map((s, i) => (
          <Bar key={s} dataKey={s} stackId="m" fill={PALETTE[i % PALETTE.length]}
            cursor={onBarClick ? "pointer" : undefined}
            onClick={() => onBarClick?.(s)} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function AllocationDonut({ data }: { data: Array<{ name: string; value: number }> }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" innerRadius={60} outerRadius={95} stroke="none">
          {data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
        </Pie>
        <Tooltip {...TOOLTIP} formatter={(v) => usd(Number(v))} />
        <Legend />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function IncomeExpenseBars({ data }: {
  data: Array<{ month: string; income: number; expenses: number; net: number }>;
}) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data}>
        <CartesianGrid stroke="#262b33" strokeDasharray="3 3" />
        <XAxis dataKey="month" {...AXIS} />
        <YAxis {...AXIS} tickFormatter={(v: number) => usd(v)} width={90} />
        <Tooltip {...TOOLTIP} formatter={(v) => usd(Number(v))} />
        <Legend />
        <Bar dataKey="income" fill="#2ecc71" />
        <Bar dataKey="expenses" fill="#ff5b5b" />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function SparkLine({ data, dataKey }: {
  data: Array<Record<string, number | string>>; dataKey: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={60}>
      <LineChart data={data}>
        <Line type="monotone" dataKey={dataKey} stroke="#4c8bf5" dot={false} strokeWidth={2} />
        <Tooltip {...TOOLTIP} formatter={(v) => usd(Number(v))} />
      </LineChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 2:** `npm run build` passes. Commit: `feat(dashboard): recharts chart wrappers`.

### Task 2: Net worth page

**Files:** Create `dashboard/src/app/net-worth/page.tsx`

- [ ] **Step 1:** Client page. Data: `useTool("get_net_worth_history")`, `useTool("get_net_worth_trajectory", {milestone})` where `milestone` is component state (number input, default 100000, applied on submit to avoid refetch-per-keystroke). Layout: `NetWorthChart` over full history; stat row (latest net worth, 30-day change computed from history, estimated monthly change + source from trajectory); trajectory card rendering `milestone` object as label/value rows (render defensively with `Object.entries`); `ErrorBanner` + `WarningsBanner`.
- [ ] **Step 2:** Build passes; live check returns chart with ≥1 snapshot date. Commit: `feat(dashboard): net worth history & trajectory page`.

### Task 3: Transactions explorer (hub page)

**Files:** Create `dashboard/src/app/transactions/page.tsx`, `dashboard/src/components/merchant-drawer.tsx`

- [ ] **Step 1: Merchant drawer.** Fixed right-side panel (`fixed inset-y-0 right-0 w-[28rem] overflow-y-auto border-l border-line bg-card p-5 z-50`), opened with a merchant string, fetches `get_merchant_profile`. Shows: total_spent / avg_ticket / max_ticket stats, first/last seen, categories + tags chips, `SparkLine` of `monthly` (dataKey "total"), recent table, trend line. Close button. Export type `MerchantDrawerProps = { merchant: string | null; onClose(): void }`.

- [ ] **Step 2: Explorer page.** Full code:

```tsx
"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTool } from "@/lib/hooks";
import { callTool } from "@/lib/api";
import { fmtDate, usd } from "@/lib/format";
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
  const [filters, setFilters] = useState({
    start_date: sp.get("start_date") ?? "",
    end_date: sp.get("end_date") ?? "",
    account_id: sp.get("account_id") ?? "",
    category: sp.get("category") ?? "",
    merchant_contains: sp.get("merchant") ?? "",
    min_amount: "", max_amount: "",
  });
  const [applied, setApplied] = useState(filters);
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
                  <FragmentRow key={t.transaction_id} t={t} expanded={expanded === t.transaction_id}
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
              <span className="text-mut">{offset + 1}–{Math.min(offset + PAGE, total)} of {total.toLocaleString()}</span>
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

function FragmentRow({ t, expanded, onToggle, onMerchant, acctName, fixCategory, msg }: {
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
```

(`useSearchParams` requires the `Suspense` wrapper for static builds.)

- [ ] **Step 3:** Build passes; live: filters return data, override on a test transaction works and re-applies. Commit: `feat(dashboard): transactions explorer with drill-down and category fixes`.

### Task 4: Spending page

**Files:** Create `dashboard/src/app/spending/page.tsx`

- [ ] **Step 1:** State: `monthsBack` (6 default; 3/6/12 buttons), derived `start_date` (first of month monthsBack ago) / `end_date` (today) computed with `new Date()` client-side; `groupBy` toggle category/merchant; `comparePair` (two `YYYY-MM` inputs).
  - Chart: `aggregate_spending {start_date, end_date, group_by: "category", monthly: true}` → pivot rows to `[{month, [category]: total}]`, series = top 8 categories by total (+"OTHER" bucket); `StackedMonthlyBars` with `onBarClick={(cat) => router.push("/transactions?category=" + cat)}`.
  - Table: `aggregate_spending {…, group_by, monthly: false}` rows sorted desc with share-of-total bar; row click → `/transactions?category=` or `?merchant=`.
  - Compare card: on submit call `compare_periods {period_a, period_b}`; show totals, delta (±, colored), `by_category` and `by_merchant` tables (a, b, delta columns).
- [ ] **Step 2:** Build + live check. Commit: `feat(dashboard): spending drill-down and period compare`.

### Task 5: Accounts page

**Files:** Create `dashboard/src/app/accounts/page.tsx`

- [ ] **Step 1:** `list_accounts` grouped by institution: name, mask, subtype, `Balance` of `balance.current` (+available/limit in sub-line), `source: csv_import` badge. Per-account expand (state `account_id|null`):
  - Balance history via `query_finances` with `sql = "SELECT snapshot_date, current FROM balance_snapshots WHERE account_id = '" + id.replace(/'/g, "''") + "' ORDER BY snapshot_date"` → `SparkLine` (map `{date, current}` rows; dataKey "current").
  - "View transactions →" link to `/transactions?account_id=…`.
  - Latest 10 transactions inline via `list_transactions {account_id, limit: 10}`.
- [ ] **Step 2:** Build + live check. Commit: `feat(dashboard): accounts page with balance history drill-down`.

### Task 6: Investments page

**Files:** Create `dashboard/src/app/investments/page.tsx`

- [ ] **Step 1:** `get_portfolio_analysis`: stat row (total_value, invested_value, cash_like_value, total_unrealized_gain, basis_coverage_pct note when < 100); `AllocationDonut` from `allocation_by_type`; concentration line (top position + top-5 weight); positions table (symbol, name, type, quantity, market_value, weight %, cost basis, gain $ and % — green/red, "?" when `!basis_known`, cash-like badge). Toggle-able section "Recent investment activity (live Plaid)" — lazy `useTool("get_investment_transactions", {start_date, end_date})` (last 90 days, only after toggle to avoid the slow live call on load) with table of date/name/type/amount and `WarningsBanner`.
- [ ] **Step 2:** Build + live check. Commit: `feat(dashboard): investments page (portfolio, allocation, activity)`.

### Task 7: Debt page

**Files:** Create `dashboard/src/app/debt/page.tsx`

- [ ] **Step 1:** `get_debt_analysis {monthly_payment?}` — `monthly_payment` from an input (applied on submit). Stat row (total_debt, weighted_apr_percentage, total_monthly_interest_if_carried, total_minimum_payments). Debts table: institution, liability_type, balance, APR, min payment, utilization (red > 30%), monthly interest. Per-debt `payoff_scenarios` (when present) rendered as rows: payment → months → total interest → verdict. `zero_balance_debts` collapsed list. Supplement card "Live liability detail" lazy-toggling `get_liabilities` (credit: last statement, due date, overdue flag; student/mortgage: rate, next payment).
- [ ] **Step 2:** Build + live check. Commit: `feat(dashboard): debt page with payoff simulator`.

### Task 8: Cash-flow page

**Files:** Create `dashboard/src/app/cash-flow/page.tsx`

- [ ] **Step 1:** `get_income_analysis {months: 6}`: `IncomeExpenseBars` of `months`; stat row (estimated_monthly_income, avg_monthly_expenses, savings_rate %); top_sources table (source, bucket, total, count); caveats as muted footnotes; partial month marked. `get_recurring_analysis {months: 6}`: stat row (monthly_recurring_total, annual_recurring_total); streams table (merchant — click opens `/transactions?merchant=…`, cadence, latest_amount, next_expected_date, annualized_cost, price_change badge red when `pct > 0`).
- [ ] **Step 2:** Build + live check. Commit: `feat(dashboard): cash-flow page (income, recurring)`.

### Task 9: Final verification

- [ ] **Step 1:** `npm test` green; `npm run build` green.
- [ ] **Step 2:** Live sweep: with all three processes up, `curl` one tool per page through the BFF; load each page in a browser if available.
- [ ] **Step 3:** Update `dashboard/README.md` page list. Commit: `docs(dashboard): page inventory`.
