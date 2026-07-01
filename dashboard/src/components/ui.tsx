"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { ApiError } from "@/lib/api";
import { signedUsd, usd } from "@/lib/format";
import {
  IconAlert,
  IconArrowDownRight,
  IconArrowUpRight,
  IconClose,
} from "@/components/icons";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Consistent form-control styling across the app's filter bars and forms. */
export const inputCls =
  "rounded-[var(--radius-sm)] border border-line bg-surface px-3 py-2 text-[13px] text-txt outline-none transition-colors focus:border-line-strong placeholder:text-faint disabled:opacity-50";

export function Field({
  label,
  children,
  className = "",
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("flex flex-col gap-1.5", className)}>
      <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">{label}</span>
      {children}
    </label>
  );
}

/** Strip float-representation noise (e.g. 8.000000000000002) for display. */
function displayNumber(x: number): string {
  if (!Number.isFinite(x)) return "";
  return String(Math.round(x * 1e6) / 1e6);
}

/**
 * Controlled numeric input that holds an editing buffer while focused. The buffer
 * lets in-progress strings ("", "-", "1.", "0.0") survive without round-tripping
 * through the model, and — critically — clearing the field never silently commits
 * a `0` into the persisted value: an empty or non-finite draft simply leaves the
 * model untouched until a real number is typed. On blur the buffer is dropped so
 * the display re-syncs to the canonical value.
 *
 * Uses `type="text"` + `inputMode="decimal"` on purpose: `type="number"` reports
 * intermediate decimals as an empty string, which is what made decimal entry and
 * clear-to-retype lose data in the first place.
 *
 * `scale` maps display↔model for unit fields: a percent stored as a fraction but
 * shown as percent passes `scale={0.01}` (shown = value/scale, committed =
 * entered×scale). Defaults to 1 (shown === model).
 */
export function NumberInput({
  value,
  onChange,
  scale = 1,
  onBlur,
  ...rest
}: {
  value: number;
  onChange: (n: number) => void;
  scale?: number;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "inputMode">) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? displayNumber(value / scale);
  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      value={shown}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        if (raw.trim() === "") return; // empty → keep the model value, don't write 0
        const n = Number(raw);
        if (Number.isFinite(n)) onChange(n * scale);
      }}
      onBlur={(e) => {
        setDraft(null); // re-sync display to the canonical value
        onBlur?.(e);
      }}
    />
  );
}

/* ────────────────────────────  surfaces  ─────────────────────────────────── */

export function Card({
  title,
  right,
  children,
  className = "",
  bodyClassName = "",
  icon,
  subtitle,
  noPad = false,
}: {
  title?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  icon?: React.ReactNode;
  subtitle?: React.ReactNode;
  noPad?: boolean;
}) {
  return (
    <section
      className={cx(
        "relative overflow-hidden rounded-[var(--radius-lg)] border border-line bg-card shadow-[var(--shadow-sm)]",
        "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/5 before:to-transparent",
        className,
      )}
    >
      {(title || right) && (
        <header className="flex flex-col gap-3 border-b border-line px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="flex min-w-0 items-center gap-2.5">
            {icon && <span className="text-mut">{icon}</span>}
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold tracking-tight text-txt">{title}</div>
              {subtitle && <div className="truncate text-xs text-mut">{subtitle}</div>}
            </div>
          </div>
          {/* On mobile the header stacks (flex-col), so the actions get their own
              full-width row below the title instead of crushing it; sm+ is unchanged. */}
          {right && <div className="sm:shrink-0">{right}</div>}
        </header>
      )}
      <div className={cx(noPad ? "" : "p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Chapter divider: a small tracked label + a hairline rule that fills the row.
 * Turns a flat stack of cards into deliberate, scannable sections. */
export function SectionLabel({
  children,
  note,
  className = "",
}: {
  children: React.ReactNode;
  note?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex items-center gap-3 pt-1", className)}>
      <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-mut">{children}</span>
      <span className="h-px flex-1 bg-line" />
      {note && <span className="text-[11px] text-faint">{note}</span>}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-txt">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-mut">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ────────────────────────────  stats / KPIs  ─────────────────────────────── */

export function Stat({
  label,
  value,
  sub,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-mut">{label}</div>
      <div className="nums mt-1 text-2xl font-semibold tracking-tight text-txt">{value}</div>
      {sub && <div className="mt-0.5 text-[13px] text-mut">{sub}</div>}
    </div>
  );
}

/** Hero metric tile: label, big tabular value, optional delta chip + footnote. */
export function KpiCard({
  label,
  value,
  delta,
  footnote,
  icon,
  accent,
  className = "",
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  delta?: React.ReactNode;
  footnote?: React.ReactNode;
  icon?: React.ReactNode;
  accent?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "group relative overflow-hidden rounded-[var(--radius-lg)] border border-line bg-card p-5 shadow-[var(--shadow-sm)] transition-colors hover:border-line-strong",
        className,
      )}
    >
      {accent && (
        <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-[var(--accent-soft)] blur-2xl" />
      )}
      <div className="relative flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-mut">{label}</span>
        {icon && (
          <span className="grid h-7 w-7 place-items-center rounded-md border border-line bg-elevated text-mut">
            {icon}
          </span>
        )}
      </div>
      <div className="nums relative mt-2 text-[28px] font-semibold leading-none tracking-tight text-txt">
        {value}
      </div>
      <div className="relative mt-2 flex items-center gap-2 text-[13px] text-mut">
        {delta}
        {footnote && <span className="truncate">{footnote}</span>}
      </div>
    </div>
  );
}

/** Up/down chip. Positive is green by default; pass invert for "lower is better". */
export function Delta({
  value,
  format = "currency",
  invert = false,
  className = "",
}: {
  value: number | null | undefined;
  format?: "currency" | "percent" | "plain";
  invert?: boolean;
  className?: string;
}) {
  if (value == null || !isFinite(value)) return null;
  const positive = invert ? value <= 0 : value >= 0;
  const Arrow = value >= 0 ? IconArrowUpRight : IconArrowDownRight;
  const body =
    format === "currency"
      ? usd(Math.abs(value))
      : format === "percent"
        ? `${Math.abs(value).toFixed(1)}%`
        : Math.abs(value).toLocaleString();
  return (
    <span
      className={cx(
        "nums inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold",
        positive ? "bg-[var(--green-soft)] text-green" : "bg-[var(--red-soft)] text-red",
        className,
      )}
    >
      <Arrow size={13} />
      {body}
    </span>
  );
}

/* ────────────────────────────  controls  ─────────────────────────────────── */

type BtnVariant = "primary" | "secondary" | "ghost" | "danger";
const BTN: Record<BtnVariant, string> = {
  primary:
    "bg-accent text-[var(--accent-contrast)] shadow-[var(--shadow-sm)] hover:brightness-110 active:brightness-95",
  secondary: "border border-line bg-elevated text-txt hover:bg-hover hover:border-line-strong",
  ghost: "text-mut hover:bg-hover hover:text-txt",
  danger: "bg-[var(--red-soft)] text-red hover:brightness-110",
};

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  className = "",
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: BtnVariant;
  size?: "sm" | "md";
  icon?: React.ReactNode;
}) {
  return (
    <button
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)] font-semibold transition-all disabled:pointer-events-none disabled:opacity-50",
        size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-[13px]",
        BTN[variant],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className = "",
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx(
        "grid h-9 w-9 place-items-center rounded-[var(--radius-sm)] border border-line bg-elevated text-mut transition-colors hover:bg-hover hover:text-txt",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  layoutId = "seg",
}: {
  options: Array<{ value: T; label: React.ReactNode }>;
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
  // Unique per rendered Segmented. The animated pill is a framer-motion shared
  // layout element, so two Segmenteds with the same id would animate the
  // highlight *between* them. Pass a distinct id when rendering a list of them.
  layoutId?: string;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-[var(--radius-sm)] border border-line bg-surface p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={cx(
              "relative rounded-[5px] font-semibold transition-colors",
              size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-[13px]",
              active ? "text-txt" : "text-mut hover:text-txt",
            )}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-0 rounded-[5px] border border-line-strong bg-elevated shadow-[var(--shadow-sm)]"
                transition={{ type: "spring", stiffness: 500, damping: 38 }}
              />
            )}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ────────────────────────────  badges  ───────────────────────────────────── */

type BadgeTone = "neutral" | "green" | "red" | "amber" | "accent";
const TONE: Record<BadgeTone, string> = {
  neutral: "bg-[color-mix(in_oklab,var(--mut)_14%,transparent)] text-mut",
  green: "bg-[var(--green-soft)] text-green",
  red: "bg-[var(--red-soft)] text-red",
  amber: "bg-[var(--amber-soft)] text-amber",
  accent: "bg-[var(--accent-soft)] text-accent",
};

export function Badge({
  tone = "neutral",
  dot = false,
  className = "",
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap",
        TONE[tone],
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

const STATUS: Record<string, [string, BadgeTone]> = {
  healthy: ["Connected", "green"],
  re_auth_required: ["Re-auth needed", "red"],
  pending_expiration: ["Expiring soon", "amber"],
  item_locked: ["Locked", "amber"],
  no_accounts: ["No accounts", "neutral"],
  unknown_error: ["Error", "red"],
  csv_import: ["CSV import", "neutral"],
};

export function StatusBadge({ status }: { status: string }) {
  const [label, tone] = STATUS[status] ?? [status || "unknown", "neutral" as BadgeTone];
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
}

/* ────────────────────────────  banners  ──────────────────────────────────── */

export type Warning = { institution?: string; status?: string; reason?: string | null };

export function WarningsBanner({ warnings }: { warnings?: Warning[] }) {
  if (!warnings?.length) return null;
  return (
    <div className="mb-4 flex gap-3 rounded-[var(--radius)] border border-[color-mix(in_oklab,var(--amber)_40%,transparent)] bg-[var(--amber-soft)] px-4 py-3 text-sm">
      <IconAlert size={18} className="mt-0.5 shrink-0 text-amber" />
      <div className="space-y-0.5">
        {warnings.map((w, i) => (
          <div key={i}>
            <b className="text-txt">{w.institution ?? "unknown"}</b>
            {w.status ? <span className="text-mut"> — {w.status}</span> : ""}
            {w.reason ? <span className="text-mut">: {w.reason}</span> : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  const hint =
    e.service === "mcp"
      ? "Start it with: .venv/bin/uvicorn asgi:app --port 8000 --reload"
      : e.service === "link_helper"
        ? "Start it with: .venv/bin/uvicorn link_helper:app --port 8765"
        : null;
  return (
    <div className="mb-4 flex gap-3 rounded-[var(--radius)] border border-[color-mix(in_oklab,var(--red)_40%,transparent)] bg-[var(--red-soft)] px-4 py-3 text-sm">
      <IconAlert size={18} className="mt-0.5 shrink-0 text-red" />
      <div>
        <b className="text-txt">{e.service ? `${e.service} unavailable` : "Request failed"}</b>
        <div className="text-mut">{e.message}</div>
        {hint && <div className="mt-1 text-xs text-faint">{hint}</div>}
      </div>
    </div>
  );
}

/* ────────────────────────────  money  ────────────────────────────────────── */

/** Plaid-sign amount: spending plain, inflows green with +. */
export function Money({ amount, className = "" }: { amount: number | null | undefined; className?: string }) {
  if (amount == null) return <span className="nums text-faint">—</span>;
  const { text, inflow } = signedUsd(amount);
  return <span className={cx("nums", inflow && "text-green", className)}>{text}</span>;
}

/** Balance (no sign flip): negative red. */
export function Balance({ amount, className = "" }: { amount: number | null | undefined; className?: string }) {
  if (amount == null) return <span className="nums text-faint">—</span>;
  return <span className={cx("nums", amount < 0 && "text-red", className)}>{usd(amount)}</span>;
}

/* ────────────────────────────  loading  ──────────────────────────────────── */

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin text-mut" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.18" fill="none" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-mut">
      <Spinner /> {label}
    </div>
  );
}

export function Skeleton({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cx("shimmer rounded-[var(--radius-sm)]", className)} style={style} />;
}

export function SkeletonStats({ n = 3 }: { n?: number }) {
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${n}, minmax(0,1fr))` }}>
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="rounded-[var(--radius-lg)] border border-line bg-card p-5">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-3 h-7 w-28" />
          <Skeleton className="mt-3 h-3 w-32" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonRows({ rows = 8 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full" style={{ opacity: 1 - i * 0.07 } as React.CSSProperties} />
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && (
        <div className="grid h-12 w-12 place-items-center rounded-full border border-line bg-elevated text-mut">
          {icon}
        </div>
      )}
      <div className="text-sm font-semibold text-txt">{title}</div>
      {description && <div className="max-w-sm text-sm text-mut">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/* ────────────────────────────  drawer  ───────────────────────────────────── */

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  width = "30rem",
  variant = "side",
  origin = null,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  width?: string;
  /** "side" = edge slide-over (default); "sheet" = centered panel that expands from `origin`. */
  variant?: "side" | "sheet";
  /** Viewport point the sheet grows out of (e.g. the click position) — container-transform feel. */
  origin?: { x: number; y: number } | null;
}) {
  // Portal to <body> so the overlay escapes the page's `animate-fade` wrapper,
  // whose `animation-fill-mode: both` leaves a persistent stacking context that
  // would otherwise trap it beneath the app header. Theme vars live on
  // documentElement, so they still apply through the portal.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const head = (
    <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div className="min-w-0">
        {title && <h2 className="truncate text-base font-semibold tracking-tight text-txt">{title}</h2>}
        {subtitle && <div className="truncate text-xs text-mut">{subtitle}</div>}
      </div>
      <IconButton label="Close" onClick={onClose} className="h-8 w-8">
        <IconClose size={16} />
      </IconButton>
    </header>
  );

  const scrim = (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-40 bg-black/20"
      onClick={onClose}
    />
  );

  // Offset the sheet's start toward the click origin so it appears to grow out of
  // what you tapped (container transform), then springs to centered full size.
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const ox = origin ? (origin.x - vw / 2) * 0.32 : 0;
  const oy = origin ? (origin.y - vh / 2) * 0.32 : 0;

  const node =
    variant === "sheet" ? (
      <AnimatePresence>
        {open && (
          <>
            {scrim}
            <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-2 sm:p-4">
              <motion.div
                initial={{ opacity: 0, scale: 0.86, x: ox, y: oy }}
                animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, x: ox * 0.8, y: oy * 0.8 }}
                transition={{
                  default: { type: "spring", stiffness: 380, damping: 34, mass: 0.9 },
                  opacity: { duration: 0.18, ease: "easeOut" },
                }}
                style={{ width, maxWidth: "95vw", transformOrigin: "center" }}
                className="pointer-events-auto flex max-h-[92vh] min-h-[80vh] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface shadow-[var(--shadow-lg)]"
              >
                {head}
                <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:p-7">{children}</div>
              </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>
    ) : (
      <AnimatePresence>
        {open && (
          <>
            {scrim}
            <motion.aside
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", stiffness: 380, damping: 40 }}
              style={{ width }}
              className="fixed inset-y-0 right-0 z-50 flex max-w-full flex-col border-l border-line bg-surface shadow-[var(--shadow-lg)]"
            >
              {head}
              <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    );

  return mounted ? createPortal(node, document.body) : null;
}
