"use client";

import { ApiError } from "@/lib/api";
import { signedUsd, usd } from "@/lib/format";

export function Card({ title, right, children, className = "" }: {
  title?: React.ReactNode; right?: React.ReactNode;
  children: React.ReactNode; className?: string;
}) {
  return (
    <div className={`rounded-xl border border-line bg-card p-5 ${className}`}>
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between gap-4">
          <div className="font-semibold">{title}</div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function Stat({ label, value, sub }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-mut">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
      {sub && <div className="text-sm text-mut">{sub}</div>}
    </div>
  );
}

const STATUS_STYLES: Record<string, [string, string]> = {
  healthy: ["Connected", "bg-green/15 text-green"],
  re_auth_required: ["Re-auth needed", "bg-red/15 text-red"],
  pending_expiration: ["Expiring soon", "bg-amber/15 text-amber"],
  item_locked: ["Locked", "bg-amber/15 text-amber"],
  no_accounts: ["No accounts", "bg-mut/15 text-mut"],
  unknown_error: ["Error", "bg-red/15 text-red"],
  csv_import: ["CSV import", "bg-mut/15 text-mut"],
};

export function StatusBadge({ status }: { status: string }) {
  const [label, cls] = STATUS_STYLES[status] ?? [status || "unknown", "bg-mut/15 text-mut"];
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
      {label}
    </span>
  );
}

export type Warning = { institution?: string; status?: string; reason?: string | null };

export function WarningsBanner({ warnings }: { warnings?: Warning[] }) {
  if (!warnings?.length) return null;
  return (
    <div className="mb-4 rounded-lg border border-amber/40 bg-amber/10 px-4 py-3 text-sm">
      {warnings.map((w, i) => (
        <div key={i}>
          ⚠ <b>{w.institution ?? "unknown"}</b>
          {w.status ? ` — ${w.status}` : ""}
          {w.reason ? `: ${w.reason}` : ""}
        </div>
      ))}
    </div>
  );
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  const hint =
    e.service === "mcp"
      ? "Start it with: .venv/bin/python server.py"
      : e.service === "link_helper"
        ? "Start it with: .venv/bin/uvicorn link_helper:app --port 8765"
        : null;
  return (
    <div className="mb-4 rounded-lg border border-red/40 bg-red/10 px-4 py-3 text-sm">
      <b>{e.service ? `${e.service} unavailable` : "Request failed"}</b>
      <div className="text-mut">{e.message}</div>
      {hint && <div className="mt-1 text-mut">{hint}</div>}
    </div>
  );
}

/** Renders a Plaid-sign amount: spending plain, inflows green with +. */
export function Money({ amount }: { amount: number | null | undefined }) {
  if (amount == null) return <span className="text-mut">—</span>;
  const { text, inflow } = signedUsd(amount);
  return <span className={inflow ? "text-green" : ""}>{text}</span>;
}

/** Renders a balance (no sign flip): negative red. */
export function Balance({ amount }: { amount: number | null | undefined }) {
  if (amount == null) return <span className="text-mut">—</span>;
  return <span className={amount < 0 ? "text-red" : ""}>{usd(amount)}</span>;
}

export function Loading() {
  return <div className="py-8 text-center text-mut">Loading…</div>;
}
