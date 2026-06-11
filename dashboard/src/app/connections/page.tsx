"use client";

import Script from "next/script";
import { useRef, useState } from "react";
import { useLinkStatus } from "@/lib/hooks";
import { linkFetch } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { Card, ErrorBanner, Loading, StatusBadge } from "@/components/ui";

declare global {
  interface Window {
    Plaid: {
      create(opts: {
        token: string;
        onSuccess(public_token: string): void;
        onExit(err: unknown): void;
      }): { open(): void };
    };
  }
}

type LinkStatus = {
  institutions: Array<{
    env_key: string; institution: string; status: string; reason: string | null;
    last_synced_at: string | null;
    accounts: Array<{ name?: string; mask?: string; subtype?: string }>;
  }>;
  db_ok: boolean;
  last_sync?: { at: string; ok: boolean; warnings?: unknown[]; error?: string } | null;
};

export default function Connections() {
  const status = useLinkStatus<LinkStatus>();
  const [syncOut, setSyncOut] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [linkOut, setLinkOut] = useState("");
  const [csvOut, setCsvOut] = useState("");
  const [csvName, setCsvName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function syncNow() {
    setSyncing(true);
    setSyncOut("Running sync…");
    try {
      const d = await linkFetch<{ ok: boolean; total_transactions_stored?: number }>("sync", { method: "POST" });
      setSyncOut(
        (d.ok ? `✓ Sync OK — ${d.total_transactions_stored} transactions stored` : "⚠ Sync completed with issues") +
        "\n" + JSON.stringify(d, null, 2),
      );
    } catch (e) {
      setSyncOut(`Sync failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSyncing(false);
      status.mutate();
    }
  }

  async function linkBank() {
    setLinkOut("");
    try {
      const d = await linkFetch<{ link_token?: string }>("create-link-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!d.link_token) { setLinkOut("Error: " + JSON.stringify(d)); return; }
      window.Plaid.create({
        token: d.link_token,
        onSuccess: async (public_token) => {
          const ex = await linkFetch<unknown>("exchange", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ public_token }),
          });
          setLinkOut("Linked! " + JSON.stringify(ex));
          status.mutate();
        },
        onExit: (err) => { if (err) setLinkOut("Exit: " + JSON.stringify(err)); },
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
        ok: boolean; error?: string; imported?: number; skipped_existing_date?: number;
        skipped_duplicate_id?: number; file_date_range?: [string, string] | null; total_for_item?: number;
      }>("import-apple-card", { method: "POST", body: f });
      setCsvOut(
        d.ok
          ? `✓ Imported ${d.imported} new transaction(s).\n` +
            `  skipped (date already stored): ${d.skipped_existing_date}\n` +
            `  skipped (duplicate id): ${d.skipped_duplicate_id}\n` +
            `  file covered ${d.file_date_range ? d.file_date_range[0] + " → " + d.file_date_range[1] : "—"}\n` +
            `  Apple Card total now: ${d.total_for_item}`
          : "✗ " + (d.error ?? "import failed"),
      );
    } catch (e) {
      setCsvOut(`Upload failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      status.mutate();
    }
  }

  const ls = status.data?.last_sync;
  return (
    <div className="mx-auto max-w-4xl">
      <Script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js" strategy="afterInteractive" />
      <h1 className="mb-1 text-xl font-bold">Connections</h1>
      <p className="mb-6 text-sm text-mut">Linked accounts &amp; sync status</p>

      <ErrorBanner error={status.error} />

      <Card title="Linked banks"
        right={
          <span className="flex gap-2">
            <button onClick={() => status.mutate()}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-semibold">Refresh</button>
            <button onClick={syncNow} disabled={syncing}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
              {syncing ? "Syncing…" : "Sync now"}
            </button>
          </span>
        }>
        {status.data ? (
          status.data.institutions.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-mut">
                  <th className="py-2">Bank</th><th>Link status</th><th>Accounts</th><th>Last synced</th>
                </tr>
              </thead>
              <tbody>
                {status.data.institutions.map((i) => (
                  <tr key={i.env_key} className="border-t border-line align-top">
                    <td className="py-2.5 font-semibold">{i.institution}</td>
                    <td className="py-2.5">
                      <StatusBadge status={i.status} />
                      {i.reason && <div className="text-xs text-mut">{i.reason}</div>}
                    </td>
                    <td className="py-2.5 text-mut">
                      {i.accounts.length
                        ? i.accounts.map((a, k) => (
                            <div key={k}>{a.name ?? a.subtype ?? "account"}{a.mask ? ` ••${a.mask}` : ""}</div>
                          ))
                        : <span>— run sync —</span>}
                    </td>
                    <td className="py-2.5 text-mut">{fmtDateTime(i.last_synced_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-mut">No banks linked yet — click “Link a bank”.</div>
          )
        ) : status.error ? null : <Loading />}
        {(syncOut || ls?.error) && (
          <pre className="mt-3 whitespace-pre-wrap text-xs text-mut">
            {syncOut || `Last sync error: ${ls?.error}`}
          </pre>
        )}
      </Card>

      <Card className="mt-4">
        <div className="flex items-center justify-between">
          <span className="text-mut">Connect another bank account</span>
          <button onClick={linkBank}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white">Link a bank</button>
        </div>
        <p className="mt-2 text-xs text-mut">
          Re-auth for a broken link: use the curl flow in <code>link_helper.py</code> — tokens never reach the browser.
        </p>
        {linkOut && <pre className="mt-2 whitespace-pre-wrap text-xs text-mut">{linkOut}</pre>}
      </Card>

      <Card title="Import Apple Card" className="mt-4">
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm text-mut">
            Upload an Apple Card CSV export. Re-uploading overlapping statements only adds dates you don’t already have.
            <div className="mt-1 text-xs">{csvName || "No file chosen"}</div>
          </div>
          <span className="flex shrink-0 gap-2">
            <input type="file" ref={fileRef} accept=".csv,text/csv" className="hidden"
              onChange={() => setCsvName(fileRef.current?.files?.[0]?.name ?? "")} />
            <button onClick={() => fileRef.current?.click()}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-semibold">Choose CSV…</button>
            <button onClick={uploadCsv} disabled={!csvName}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
              Upload
            </button>
          </span>
        </div>
        {csvOut && <pre className="mt-2 whitespace-pre-wrap text-xs text-mut">{csvOut}</pre>}
      </Card>
    </div>
  );
}
