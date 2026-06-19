"use client";

import Script from "next/script";
import { useRef, useState } from "react";
import { useLinkStatus, useTool } from "@/lib/hooks";
import { callTool, linkFetch } from "@/lib/api";
import { fmtDateTime, usd } from "@/lib/format";
import { Button, Card, ErrorBanner, inputCls, Loading, Spinner, StatusBadge } from "@/components/ui";
import { IconPlus, IconSync, IconUpload, IconWallet } from "@/components/icons";

declare global {
  interface Window {
    Plaid: {
      create(opts: { token: string; onSuccess(public_token: string): void; onExit(err: unknown): void }): { open(): void };
    };
  }
}

// link_helper /status shape (local-only service; holds Plaid tokens).
type LinkStatus = {
  institutions: Array<{
    env_key: string;
    institution: string;
    status: string;
    reason: string | null;
    last_synced_at: string | null;
    accounts: Array<{ name?: string; mask?: string; subtype?: string }>;
  }>;
  db_ok: boolean;
  last_sync?: { at: string; ok: boolean; warnings?: unknown[]; error?: string } | null;
};

// MCP-backed shapes (work in the cloud and locally).
type InstStatus = { items: Array<{ env_key: string; institution: string; status: string; reason: string | null }> };
type SyncStatus = { items: Array<{ item_key: string; last_synced_at: string | null }> };

function Output({ text }: { text: string }) {
  if (!text) return null;
  return <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-[var(--radius-sm)] border border-line bg-surface p-3 text-xs text-mut">{text}</pre>;
}

/** Shown for token-touching actions (link / reset / CSV) when link_helper isn't
 * reachable — i.e. on the deployed app. Those run locally by design so Plaid
 * access tokens never leave your machine. */
function LocalOnlyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-sm)] border border-dashed border-line bg-surface px-4 py-3 text-[13px] text-mut">
      {children}
      <div className="mt-2 text-xs text-faint">
        Run the local dashboard: <code>cd dashboard &amp;&amp; npm run dev</code> with{" "}
        <code>.venv/bin/uvicorn link_helper:app --port 8765</code> (tokens stay on your machine).
      </div>
    </div>
  );
}

export default function Connections() {
  // link_helper is local-only; in the cloud this errors → we fall back to MCP.
  const local = useLinkStatus<LinkStatus>();
  const linkUp = !!local.data && !local.error;

  // MCP-backed status (deployed + local): live institution health + last-synced.
  const insts = useTool<InstStatus>("get_institutions_status");
  const sync = useTool<SyncStatus>("get_sync_status");
  const lastSync = sync.data?.items?.map((i) => i.last_synced_at).filter(Boolean).sort().pop() ?? null;

  const [syncOut, setSyncOut] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [linkOut, setLinkOut] = useState("");
  const [resetting, setResetting] = useState<string | null>(null);
  const [csvOut, setCsvOut] = useState("");
  const [csvName, setCsvName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  function refreshAll() {
    insts.mutate();
    sync.mutate();
    local.mutate();
  }

  // Sync via the MCP server (same run_sync code path) so it works in the cloud too.
  async function syncNow() {
    setSyncing(true);
    setSyncOut("Running sync…");
    try {
      const d = await callTool<{ total_transactions_stored?: number; warnings?: unknown[] }>("sync_now");
      const ok = !(d.warnings && d.warnings.length);
      setSyncOut((ok ? `✓ Sync OK — ${d.total_transactions_stored ?? 0} transactions stored` : "⚠ Sync completed with issues") + "\n" + JSON.stringify(d, null, 2));
    } catch (e) {
      setSyncOut(`Sync failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSyncing(false);
      refreshAll();
    }
  }

  // ── link_helper actions (local only) ───────────────────────────────────────
  async function resetItem(envKey: string, name: string) {
    if (!window.confirm(
      `Reset ${name}? This removes the Plaid Item (stops billing) and wipes its ` +
      `local history (a JSON backup is written first). You'll re-link it next to ` +
      `pull 24 months.`)) return;
    setResetting(envKey);
    try {
      const d = await linkFetch<{ ok: boolean; error?: string }>(`reset-item`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ env_key: envKey }),
      });
      refreshAll();
      if (!d.ok) {
        setLinkOut(`Reset failed for ${name}: ${d.error ?? "unknown error"}`);
        return;
      }
      await linkBank();
    } finally {
      setResetting(null);
    }
  }

  async function linkBank() {
    setLinkOut("");
    try {
      const d = await linkFetch<{ link_token?: string }>("create-link-token", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!d.link_token) {
        setLinkOut("Error: " + JSON.stringify(d));
        return;
      }
      window.Plaid.create({
        token: d.link_token,
        onSuccess: async (public_token) => {
          const ex = await linkFetch<unknown>("exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ public_token }) });
          setLinkOut("Linked! " + JSON.stringify(ex));
          refreshAll();
        },
        onExit: (err) => {
          if (err) setLinkOut("Exit: " + JSON.stringify(err));
        },
      }).open();
    } catch (e) {
      setLinkOut(`Link failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function uploadCsv() {
    const f = fileRef.current?.files?.[0];
    if (!f) return;
    setCsvOut("Importing…");
    try {
      const d = await linkFetch<{
        ok: boolean;
        error?: string;
        imported?: number;
        skipped_existing_date?: number;
        skipped_duplicate_id?: number;
        file_date_range?: [string, string] | null;
        total_for_item?: number;
      }>("import-apple-card", { method: "POST", body: f });
      setCsvOut(
        d.ok
          ? `✓ Imported ${d.imported} new transaction(s).\n  skipped (date already stored): ${d.skipped_existing_date}\n  skipped (duplicate id): ${d.skipped_duplicate_id}\n  file covered ${d.file_date_range ? d.file_date_range[0] + " → " + d.file_date_range[1] : "—"}\n  Apple Card total now: ${d.total_for_item}`
          : "✗ " + (d.error ?? "import failed"),
      );
    } catch (e) {
      setCsvOut(`Upload failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      refreshAll();
    }
  }

  return (
    <div className="space-y-4">
      <Script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js" strategy="afterInteractive" />
      {/* Only surface MCP errors here — a link_helper error in the cloud is expected. */}
      <ErrorBanner error={insts.error} />

      <Card
        title="Linked banks"
        icon={<IconSync size={16} />}
        right={
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={refreshAll}>
              Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={syncNow} disabled={syncing} icon={syncing ? <Spinner size={14} /> : <IconSync size={14} />}>
              {syncing ? "Syncing…" : "Sync now"}
            </Button>
          </div>
        }
        noPad
      >
        <div className="border-b border-line px-5 py-2 text-xs text-mut">
          Last synced <span className="text-txt">{lastSync ? fmtDateTime(lastSync) : "—"}</span> · auto-syncs ~6×/day
        </div>

        {linkUp ? (
          /* LOCAL: full link_helper table with per-bank accounts + reset/re-link. */
          local.data!.institutions.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-mut">
                    <th className="px-5 py-2.5 font-semibold">Bank</th>
                    <th className="px-5 py-2.5 font-semibold">Status</th>
                    <th className="px-5 py-2.5 font-semibold">Accounts</th>
                    <th className="px-5 py-2.5 font-semibold">Last synced</th>
                    <th className="px-5 py-2.5 font-semibold"></th>
                  </tr>
                </thead>
                <tbody>
                  {local.data!.institutions.map((i) => (
                    <tr key={i.env_key} className="border-b border-line align-top last:border-0">
                      <td className="px-5 py-3 font-semibold text-txt">{i.institution}</td>
                      <td className="px-5 py-3">
                        <StatusBadge status={i.status} />
                        {i.reason && <div className="mt-1 text-xs text-mut">{i.reason}</div>}
                      </td>
                      <td className="px-5 py-3 text-mut">
                        {i.accounts.length ? i.accounts.map((a, k) => <div key={k}>{a.name ?? a.subtype ?? "account"}{a.mask ? ` ··${a.mask}` : ""}</div>) : <span className="text-faint">— run sync —</span>}
                      </td>
                      <td className="px-5 py-3 text-mut">{fmtDateTime(i.last_synced_at)}</td>
                      <td className="px-5 py-3">
                        {i.status !== "csv_import" && (
                          <Button variant="secondary" size="sm" onClick={() => resetItem(i.env_key, i.institution)} disabled={resetting === i.env_key}>
                            {resetting === i.env_key ? "Resetting…" : "Reset & re-link"}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-5 py-6 text-mut">No banks linked yet — click “Link a bank”.</div>
          )
        ) : insts.data ? (
          /* CLOUD: read-only institution health from the MCP server. */
          insts.data.items.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-mut">
                    <th className="px-5 py-2.5 font-semibold">Bank</th>
                    <th className="px-5 py-2.5 font-semibold">Status</th>
                    <th className="px-5 py-2.5 font-semibold">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {insts.data.items.map((i) => (
                    <tr key={i.env_key} className="border-b border-line align-top last:border-0">
                      <td className="px-5 py-3 font-semibold text-txt">{i.institution}</td>
                      <td className="px-5 py-3"><StatusBadge status={i.status} /></td>
                      <td className="px-5 py-3 text-mut">{i.reason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-5 py-6 text-mut">No banks linked yet — link one from your local dashboard.</div>
          )
        ) : (
          <Loading />
        )}
        {syncOut && (
          <div className="px-5 pb-4">
            <Output text={syncOut} />
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Link a new bank" icon={<IconPlus size={16} />}>
          {linkUp ? (
            <>
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-mut">Connect another institution through Plaid.</p>
                <Button variant="primary" onClick={linkBank} icon={<IconPlus size={15} />}>
                  Link a bank
                </Button>
              </div>
              <p className="mt-3 text-xs text-faint">
                Re-auth for a broken link: use the curl flow in <code>link_helper.py</code> — tokens never reach the browser.
              </p>
              <Output text={linkOut} />
            </>
          ) : (
            <LocalOnlyNote>Linking a bank goes through Plaid and stores an access token, so it runs from your local dashboard — not the cloud.</LocalOnlyNote>
          )}
        </Card>

        <Card title="Import Apple Card" icon={<IconUpload size={16} />}>
          {linkUp ? (
            <>
              <p className="text-sm text-mut">Upload an Apple Card CSV export. Overlapping statements only add dates you don&apos;t already have.</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input type="file" ref={fileRef} accept=".csv,text/csv" className="hidden" onChange={() => setCsvName(fileRef.current?.files?.[0]?.name ?? "")} />
                <Button variant="secondary" onClick={() => fileRef.current?.click()}>
                  Choose CSV…
                </Button>
                <Button variant="primary" onClick={uploadCsv} disabled={!csvName} icon={<IconUpload size={15} />}>
                  Upload
                </Button>
                <span className="text-xs text-faint">{csvName || "No file chosen"}</span>
              </div>
              <Output text={csvOut} />
            </>
          ) : (
            <LocalOnlyNote>CSV import writes to your history store through the local helper, so it runs from your local dashboard.</LocalOnlyNote>
          )}
        </Card>
      </div>

      <ManualBalanceCard />
    </div>
  );
}

/** CSV exports carry no balance — record the real one so debt & net-worth views include the account. */
function ManualBalanceCard() {
  const accounts = useTool<{
    accounts: Array<{ account_id: string; institution: string | null; name: string | null; type?: string | null; source?: string; balance?: { current: number | null } }>;
  }>("list_accounts");
  const manual = accounts.data?.accounts.filter((a) => a.source === "csv_import") ?? [];
  const [acct, setAcct] = useState("");
  const [bal, setBal] = useState("");
  const [apr, setApr] = useState("");
  const [minPay, setMinPay] = useState("");
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState(false);

  if (!accounts.data || manual.length === 0) return null;
  const selected = manual.find((a) => a.account_id === acct) ?? manual[0];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!bal) return;
    setBusy(true);
    setOut("");
    try {
      const args: Record<string, unknown> = { account_id: selected.account_id, current_balance: Number(bal) };
      if (apr) args.apr_percentage = Number(apr);
      if (minPay) args.minimum_payment = Number(minPay);
      const res = await callTool<{ ok?: boolean; snapshot_date?: string; liability_recorded?: boolean; error?: { message: string } }>("set_manual_balance", args);
      setOut(res.ok ? `✓ Recorded ${usd(Number(bal))} for ${selected.institution} (${res.snapshot_date})` + (res.liability_recorded ? " — debt & net-worth views updated" : "") : `✗ ${res.error?.message ?? "failed"}`);
      accounts.mutate();
    } catch (err) {
      setOut(`✗ ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Record balance (manual accounts)" icon={<IconWallet size={16} />}>
      <p className="mb-3 text-sm text-mut">
        CSV exports carry no balance. Enter the current balance from the issuer&apos;s app (e.g. Wallet for Apple Card) so Debt and Net worth include this account. Re-entering the same day overwrites; new days build history.
        {selected.balance?.current != null && <> Last recorded: <b className="text-txt">{usd(selected.balance.current)}</b>.</>}
      </p>
      <form className="flex flex-wrap items-center gap-2" onSubmit={save}>
        <select className={inputCls} value={selected.account_id} onChange={(e) => setAcct(e.target.value)}>
          {manual.map((a) => (
            <option key={a.account_id} value={a.account_id}>
              {a.institution}
              {a.name && a.name !== a.institution ? ` ${a.name}` : ""}
            </option>
          ))}
        </select>
        <input className={inputCls} type="number" step="0.01" placeholder="Current balance $" required value={bal} onChange={(e) => setBal(e.target.value)} />
        <input className={inputCls} type="number" step="0.01" placeholder="APR % (optional)" value={apr} onChange={(e) => setApr(e.target.value)} />
        <input className={inputCls} type="number" step="0.01" placeholder="Min payment $ (optional)" value={minPay} onChange={(e) => setMinPay(e.target.value)} />
        <Button type="submit" variant="primary" disabled={busy || !bal}>
          {busy ? "Saving…" : "Record"}
        </Button>
      </form>
      {out && <div className="mt-2 text-sm text-mut">{out}</div>}
    </Card>
  );
}
