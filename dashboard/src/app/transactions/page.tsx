"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTool } from "@/lib/hooks";
import { callTool } from "@/lib/api";
import { fmtDate, usd } from "@/lib/format";
import {
  Badge,
  Button,
  Drawer,
  ErrorBanner,
  inputCls,
  KpiCard,
  Loading,
  Money,
  SkeletonStats,
} from "@/components/ui";
import {
  ChipCell,
  DataCard,
  DateCell,
  MoneyCell,
  numCol,
  TagsCell,
  type ColDef,
} from "@/components/data-grid";
import {
  AmountFilter,
  type AmountValue,
  DateRangeFilter,
  dateLabel,
  type DateValue,
  FilterChip,
  MultiSelectFilter,
  presetRange,
} from "@/components/filters";
import { MerchantDrawer } from "@/components/merchant-drawer";
import { IconArrowDownRight, IconArrowUpRight, IconSearch, IconTransactions } from "@/components/icons";

const LIMIT = 1500;

type Tx = {
  transaction_id: string;
  account_id: string;
  date: string | null;
  amount: number;
  currency: string | null;
  merchant: string | null;
  name: string | null;
  category_primary: string | null;
  category_detailed: string | null;
  pending: boolean;
  tags: string[];
};
type Row = Tx & { account: string; payee: string };
type TxResp = { transactions: Tx[]; total_matching: number };
type Accounts = {
  accounts: Array<{ account_id: string; institution: string; name: string; mask?: string }>;
};

function Explorer() {
  const sp = useSearchParams();
  const [date, setDate] = useState<DateValue>(() =>
    sp.get("start_date")
      ? { preset: "custom", start: sp.get("start_date")!, end: new Date().toISOString().slice(0, 10) }
      : { preset: "all", start: "", end: "" },
  );
  const [categories, setCategories] = useState<Set<string>>(() => new Set(sp.get("category") ? [sp.get("category")!] : []));
  const [accountSel, setAccountSel] = useState<Set<string>>(() => new Set(sp.get("account_id") ? [sp.get("account_id")!] : []));
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [amount, setAmount] = useState<AmountValue>({ min: "", max: "", direction: "all", pendingOnly: false });
  const [search, setSearch] = useState(() => sp.get("merchant") ?? "");
  const [detail, setDetail] = useState<Row | null>(null);
  const [merchant, setMerchant] = useState<string | null>(null);

  const accounts = useTool<Accounts>("list_accounts");
  const acctName = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts.data?.accounts ?? []) {
      const label = a.name === a.institution ? a.institution : `${a.institution} ${a.name}`;
      m.set(a.account_id, `${label}${a.mask ? ` ··${a.mask}` : ""}`);
    }
    return (id: string) => m.get(id) ?? `${id.slice(0, 10)}…`;
  }, [accounts.data]);

  // Only the date range scopes the server query — everything else filters client-side.
  const args: Record<string, unknown> = { limit: LIMIT, offset: 0, ...presetRange(date) };
  const txs = useTool<TxResp>("list_transactions", args);

  const rows = useMemo<Row[]>(
    () => (txs.data?.transactions ?? []).map((t) => ({ ...t, account: acctName(t.account_id), payee: t.merchant ?? t.name ?? "—" })),
    [txs.data, acctName],
  );

  // Faceted options with counts, derived from the loaded window.
  const categoryOpts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) if (r.category_primary) m.set(r.category_primary, (m.get(r.category_primary) ?? 0) + 1);
    return [...m.entries()].map(([value, count]) => ({ value, label: value.replace(/_/g, " ").toLowerCase(), count })).sort((a, b) => b.count - a.count);
  }, [rows]);
  const accountOpts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.account_id, (m.get(r.account_id) ?? 0) + 1);
    return [...m.entries()].map(([value, count]) => ({ value, label: acctName(value), count })).sort((a, b) => b.count - a.count);
  }, [rows, acctName]);
  const tagOpts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) for (const t of r.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].map(([value, count]) => ({ value, label: value, count })).sort((a, b) => b.count - a.count);
  }, [rows]);

  const filteredRows = useMemo(() => {
    const min = amount.min === "" ? null : Number(amount.min);
    const max = amount.max === "" ? null : Number(amount.max);
    const s = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (categories.size && !categories.has(r.category_primary ?? "")) return false;
      if (accountSel.size && !accountSel.has(r.account_id)) return false;
      if (tags.size && !r.tags.some((t) => tags.has(t))) return false;
      const abs = Math.abs(r.amount);
      if (min != null && abs < min) return false;
      if (max != null && abs > max) return false;
      if (amount.direction === "out" && r.amount < 0) return false;
      if (amount.direction === "in" && r.amount >= 0) return false;
      if (amount.pendingOnly && !r.pending) return false;
      if (s && !`${r.payee} ${r.name ?? ""} ${r.category_primary ?? ""} ${r.account}`.toLowerCase().includes(s)) return false;
      return true;
    });
  }, [rows, categories, accountSel, tags, amount, search]);

  const stats = useMemo(() => {
    let out = 0, inn = 0;
    for (const r of filteredRows) {
      if (r.amount >= 0) out += r.amount;
      else inn -= r.amount;
    }
    return { out, inn, count: filteredRows.length };
  }, [filteredRows]);

  const total = txs.data?.total_matching ?? 0;
  const truncated = total > rows.length;
  const anyFilter = date.preset !== "all" || categories.size || accountSel.size || tags.size || search.trim() || amount.min || amount.max || amount.direction !== "all" || amount.pendingOnly;

  function clearAll() {
    setDate({ preset: "all", start: "", end: "" });
    setCategories(new Set());
    setAccountSel(new Set());
    setTags(new Set());
    setAmount({ min: "", max: "", direction: "all", pendingOnly: false });
    setSearch("");
  }

  const chips: React.ReactNode[] = [];
  if (date.preset !== "all") chips.push(<FilterChip key="date" onRemove={() => setDate({ preset: "all", start: "", end: "" })}>{dateLabel(date)}</FilterChip>);
  [...categories].forEach((c) =>
    chips.push(
      <FilterChip key={`c${c}`} onRemove={() => setCategories((p) => { const n = new Set(p); n.delete(c); return n; })}>
        {c.replace(/_/g, " ").toLowerCase()}
      </FilterChip>,
    ),
  );
  [...accountSel].forEach((a) =>
    chips.push(
      <FilterChip key={`a${a}`} onRemove={() => setAccountSel((p) => { const n = new Set(p); n.delete(a); return n; })}>
        {acctName(a)}
      </FilterChip>,
    ),
  );
  [...tags].forEach((t) =>
    chips.push(
      <FilterChip key={`t${t}`} onRemove={() => setTags((p) => { const n = new Set(p); n.delete(t); return n; })}>
        {t}
      </FilterChip>,
    ),
  );
  if (amount.min || amount.max)
    chips.push(
      <FilterChip key="amt" onRemove={() => setAmount({ ...amount, min: "", max: "" })}>
        {amount.min ? `$${amount.min}` : "$0"}–{amount.max ? `$${amount.max}` : "∞"}
      </FilterChip>,
    );
  if (amount.direction !== "all") chips.push(<FilterChip key="dir" onRemove={() => setAmount({ ...amount, direction: "all" })}>{amount.direction === "in" ? "Money in" : "Money out"}</FilterChip>);
  if (amount.pendingOnly) chips.push(<FilterChip key="pend" onRemove={() => setAmount({ ...amount, pendingOnly: false })}>Pending only</FilterChip>);
  if (search.trim()) chips.push(<FilterChip key="search" onRemove={() => setSearch("")}>{`“${search}”`}</FilterChip>);

  const columns = useMemo<ColDef[]>(
    () => [
      { field: "date", headerName: "Date", cellRenderer: DateCell, width: 130, sort: "desc", filter: "agDateColumnFilter" },
      {
        field: "payee",
        headerName: "Merchant",
        flex: 2,
        minWidth: 180,
        cellRenderer: (p: { data: Row }) => (
          <span className="flex items-center gap-2">
            <span className="font-medium text-txt">{p.data.payee}</span>
            {p.data.pending && <Badge tone="amber">pending</Badge>}
          </span>
        ),
      },
      { field: "category_primary", headerName: "Category", flex: 1, minWidth: 150, cellRenderer: ChipCell },
      { field: "account", headerName: "Account", flex: 1.4, minWidth: 160 },
      { field: "tags", headerName: "Tags", width: 130, cellRenderer: TagsCell, cellDataType: false, filter: false, sortable: false },
      { field: "amount", headerName: "Amount", ...numCol(), width: 140, cellRenderer: MoneyCell, filter: "agNumberColumnFilter" },
    ],
    [],
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[var(--radius-lg)] border border-line bg-card p-3 shadow-[var(--shadow-sm)]">
        <DateRangeFilter value={date} onChange={setDate} />
        <MultiSelectFilter label="Category" options={categoryOpts} selected={categories} onChange={setCategories} />
        <MultiSelectFilter label="Account" options={accountOpts} selected={accountSel} onChange={setAccountSel} />
        {tagOpts.length > 0 && <MultiSelectFilter label="Tags" options={tagOpts} selected={tags} onChange={setTags} />}
        <AmountFilter value={amount} onChange={setAmount} />
        <div className="ml-auto flex items-center gap-2 rounded-[var(--radius-sm)] border border-line bg-surface px-2.5 py-2 focus-within:border-line-strong">
          <IconSearch size={15} className="text-mut" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search merchant, category…"
            className="w-40 bg-transparent text-[13px] text-txt outline-none placeholder:text-faint sm:w-52"
          />
        </div>
      </div>

      {chips.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-faint">Filters</span>
          {chips}
          <button onClick={clearAll} className="ml-1 text-xs font-semibold text-accent hover:underline">
            Clear all
          </button>
        </div>
      )}

      <ErrorBanner error={txs.error} />

      {txs.data ? (
        <div className="mb-4 grid gap-4 sm:grid-cols-3">
          <KpiCard label={anyFilter ? "Matching filters" : "Transactions"} value={stats.count.toLocaleString()} icon={<IconTransactions size={15} />} footnote={truncated ? `from latest ${rows.length.toLocaleString()} of ${total.toLocaleString()} — narrow the date range` : `of ${rows.length.toLocaleString()} loaded`} />
          <KpiCard label="Outflow" value={usd(stats.out)} icon={<IconArrowUpRight size={15} />} footnote={truncated ? `latest ${rows.length.toLocaleString()} of ${total.toLocaleString()} — narrow the range` : undefined} />
          <KpiCard label="Inflow" value={<span className="text-green">+{usd(stats.inn)}</span>} icon={<IconArrowDownRight size={15} />} footnote={truncated ? `latest ${rows.length.toLocaleString()} of ${total.toLocaleString()} — narrow the range` : undefined} />
        </div>
      ) : txs.error ? null : (
        <div className="mb-4">
          <SkeletonStats n={3} />
        </div>
      )}

      {txs.data ? (
        <DataCard<Row>
          title="Transactions"
          subtitle={`${stats.count.toLocaleString()} shown${anyFilter ? ` · filtered from ${rows.length.toLocaleString()}` : ""}`}
          icon={<IconTransactions size={16} />}
          rowData={filteredRows}
          columnDefs={columns}
          defaultColDef={{ floatingFilter: true }}
          getRowId={(p) => p.data.transaction_id}
          onRowClicked={(e) => setDetail(e.data)}
          searchable={false}
          exportName="transactions"
          countLabel="transactions"
          height="calc(100vh - 384px)"
        />
      ) : txs.error ? null : (
        <Loading label="Loading transactions…" />
      )}

      <TransactionDrawer row={detail} onClose={() => setDetail(null)} onMerchant={(m) => { setDetail(null); setMerchant(m); }} onSaved={() => txs.mutate()} />
      <MerchantDrawer merchant={merchant} onClose={() => setMerchant(null)} />
    </div>
  );
}

function TransactionDrawer({
  row,
  onClose,
  onMerchant,
  onSaved,
}: {
  row: Row | null;
  onClose: () => void;
  onMerchant: (m: string) => void;
  onSaved: () => void;
}) {
  const [cat, setCat] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function fix(scope: "merchant" | "transaction") {
    if (!row || !cat) return;
    setBusy(true);
    setMsg("");
    const match_value = scope === "merchant" ? (row.merchant ?? row.name ?? "") : row.transaction_id;
    try {
      const res = await callTool<{ ok?: boolean; applied_to_transactions?: number; error?: { message: string } }>(
        "set_category_override",
        { match_type: scope, match_value, set_primary: cat.toUpperCase().replace(/ /g, "_") },
      );
      setMsg(res.ok ? `✓ Saved — rewrote ${res.applied_to_transactions} transaction(s)` : `✗ ${res.error?.message ?? "failed"}`);
      if (res.ok) onSaved();
    } catch (e) {
      setMsg(`✗ ${e instanceof Error ? e.message : "failed"}`);
    } finally {
      setBusy(false);
    }
  }

  const meta: Array<[string, React.ReactNode]> = row
    ? [
        ["Date", fmtDate(row.date)],
        ["Account", row.account],
        ["Category", row.category_primary ?? "—"],
        ["Detailed", row.category_detailed ?? "—"],
        ["Raw name", row.name ?? "—"],
        ["Currency", row.currency ?? "—"],
        ["Status", row.pending ? "Pending" : "Posted"],
      ]
    : [];

  return (
    <Drawer
      open={!!row}
      onClose={() => { setCat(""); setMsg(""); onClose(); }}
      title={row?.payee}
      subtitle={row ? fmtDate(row.date) : undefined}
    >
      {row && (
        <div className="space-y-5">
          <div className="rounded-[var(--radius)] border border-line bg-elevated p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-mut">Amount</div>
            <div className="mt-1 text-3xl font-semibold tracking-tight">
              <Money amount={row.amount} />
            </div>
            {row.tags.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {row.tags.map((t) => (
                  <Badge key={t} tone="accent">{t}</Badge>
                ))}
              </div>
            )}
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            {meta.map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-mut">{k}</dt>
                <dd className="mt-0.5 font-medium text-txt">{v}</dd>
              </div>
            ))}
          </dl>

          {row.merchant && (
            <Button variant="secondary" className="w-full" onClick={() => onMerchant(row.merchant!)}>
              View {row.merchant} profile →
            </Button>
          )}

          <div className="rounded-[var(--radius)] border border-line p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-mut">Recategorize</div>
            <input className={`${inputCls} mt-2 w-full`} placeholder="e.g. FOOD_AND_DRINK" value={cat} onChange={(e) => setCat(e.target.value)} />
            <div className="mt-2 flex gap-2">
              <Button variant="secondary" size="sm" disabled={busy || !cat} onClick={() => fix("transaction")}>This transaction</Button>
              <Button variant="secondary" size="sm" disabled={busy || !cat} onClick={() => fix("merchant")}>Always for this merchant</Button>
            </div>
            {msg && <div className="mt-2 text-xs text-mut">{msg}</div>}
            <p className="mt-2 text-xs text-faint">
              Writes a rule to <code>category_overrides</code> — re-applied on every future sync.
            </p>
          </div>

          <div className="text-xs text-faint">
            <span className="text-mut">ID</span> <code className="break-all">{row.transaction_id}</code>
          </div>
        </div>
      )}
    </Drawer>
  );
}

export default function TransactionsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Explorer />
    </Suspense>
  );
}
