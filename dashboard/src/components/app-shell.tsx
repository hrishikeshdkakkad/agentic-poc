"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { useSWRConfig } from "swr";
import { useSession, signOut } from "next-auth/react";
import { callTool } from "@/lib/api";
import { useTool } from "@/lib/hooks";
import { NAV, NAV_GROUPS, pageTitle } from "@/components/nav";
import { permissionsForRoles, allowedPages } from "@/lib/rbac";
import { CommandPalette } from "@/components/command-palette";
import { useTheme } from "@/components/theme";
import { Button, cx, IconButton, Spinner } from "@/components/ui";
import {
  BrandMark,
  IconCheck,
  IconClose,
  IconAlert,
  IconMenu,
  IconMoon,
  IconSearch,
  IconSun,
  IconSync,
} from "@/components/icons";

function ago(iso?: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "—";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

type SyncStatus = { items?: Array<{ last_synced_at: string | null }> };

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { mutate } = useSWRConfig();
  const { theme, toggle } = useTheme();
  const { data: session } = useSession();

  const roles = session?.user?.roles ?? [];
  const perms = permissionsForRoles(roles);
  const allowed = new Set(allowedPages(perms));
  const isAdminUser = perms.has("*");
  const canSync = isAdminUser || perms.has("sync:run");
  const canSeeSync = isAdminUser || perms.has("connections:manage");
  const visibleNav = NAV.filter((n) => allowed.has(n.href));

  // Last-sync read from the deployed MCP server (works in the cloud), gated by perms.
  const status = useTool<SyncStatus>(canSeeSync ? "get_sync_status" : "");

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);

  const { label, blurb } = pageTitle(pathname);
  const lastSync = status.data?.items
    ?.map((i) => i.last_synced_at)
    .filter(Boolean)
    .sort()
    .pop();

  const runSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setToast(null);
    try {
      const d = await callTool<{ total_transactions_stored?: number; warnings?: unknown[] }>("sync_now");
      const ok = !(d.warnings && d.warnings.length);
      setToast({
        ok,
        text: ok
          ? `Synced · ${d.total_transactions_stored ?? 0} transactions stored`
          : "Sync finished with issues",
      });
      await mutate(() => true, undefined, { revalidate: true });
    } catch (e) {
      setToast({ ok: false, text: e instanceof Error ? e.message : "Sync failed" });
    } finally {
      setSyncing(false);
    }
  }, [syncing, mutate]);

  // ⌘K / Ctrl+K opens the palette anywhere
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  // Auth pages render bare — no sidebar/header chrome.
  if (pathname === "/login" || pathname === "/403") {
    return <>{children}</>;
  }
  // Dev-only newsroom harness renders bare: it is unauthenticated, so the
  // shell would show an empty nav rail (the page itself 404s in production).
  if (pathname === "/news-preview") {
    return <main className="min-h-screen px-5 py-6 md:px-10 lg:px-14">{children}</main>;
  }

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  const navBody = (
    <nav className="flex flex-col gap-5">
      {NAV_GROUPS.map((group) => {
        const items = visibleNav.filter((n) => n.group === group);
        if (!items.length) return null;
        return (
          <div key={group || "_top"} className="flex flex-col gap-0.5">
            {group && (
              <div className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
                {group}
              </div>
            )}
            {items.map((n) => {
              const active = isActive(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  onClick={() => setMobileNav(false)}
                  className={cx(
                    "group relative flex items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2 text-[13.5px] font-medium transition-colors",
                    active ? "text-txt" : "text-mut hover:text-txt",
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="nav-active"
                      className="absolute inset-0 rounded-[var(--radius-sm)] border border-line bg-elevated shadow-[var(--shadow-sm)]"
                      transition={{ type: "spring", stiffness: 520, damping: 40 }}
                    />
                  )}
                  <span className={cx("relative transition-colors", active ? "text-accent" : "text-mut group-hover:text-txt")}>
                    <n.icon size={17} />
                  </span>
                  <span className="relative">{n.label}</span>
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );

  const brand = (
    <Link href="/" className="flex items-center gap-2.5 px-2">
      <BrandMark size={28} />
      <div className="leading-tight">
        <div className="text-sm font-semibold tracking-tight text-txt">Vault</div>
        <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">Personal Finance</div>
      </div>
    </Link>
  );

  return (
    <div className="relative z-10 flex min-h-screen">
      {/* ───────── desktop sidebar ───────── */}
      <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col border-r border-line bg-surface/60 px-3 py-4 backdrop-blur-xl lg:flex">
        <div className="mb-6">{brand}</div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">{navBody}</div>
        <SidebarFooter
          theme={theme}
          toggle={toggle}
          openPalette={() => setPaletteOpen(true)}
          lastSync={lastSync}
        />
      </aside>

      {/* ───────── mobile nav drawer ───────── */}
      <AnimatePresence>
        {mobileNav && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[2px] lg:hidden"
              onClick={() => setMobileNav(false)}
            />
            <motion.aside
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", stiffness: 380, damping: 40 }}
              className="fixed inset-y-0 left-0 z-50 flex w-[270px] flex-col border-r border-line bg-surface px-3 py-4 lg:hidden"
            >
              <div className="mb-6 flex items-center justify-between">
                {brand}
                <IconButton label="Close menu" onClick={() => setMobileNav(false)} className="h-8 w-8">
                  <IconClose size={16} />
                </IconButton>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">{navBody}</div>
              <SidebarFooter
                theme={theme}
                toggle={toggle}
                openPalette={() => setPaletteOpen(true)}
                lastSync={lastSync}
              />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* ───────── main column ───────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-bg/80 px-4 py-3 backdrop-blur-xl md:px-6">
          <IconButton label="Open menu" onClick={() => setMobileNav(true)} className="lg:hidden">
            <IconMenu size={18} />
          </IconButton>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[15px] font-semibold tracking-tight text-txt">{label}</h1>
            {blurb && <p className="truncate text-xs text-mut">{blurb}</p>}
          </div>

          <button
            onClick={() => setPaletteOpen(true)}
            className="hidden items-center gap-2 rounded-[var(--radius-sm)] border border-line bg-surface px-3 py-2 text-[13px] text-mut transition-colors hover:border-line-strong hover:text-txt sm:flex"
          >
            <IconSearch size={15} />
            <span>Search…</span>
            <kbd className="ml-3 rounded border border-line bg-bg px-1.5 py-0.5 text-[10px] font-medium">⌘K</kbd>
          </button>

          <IconButton label="Toggle theme" onClick={toggle}>
            {theme === "dark" ? <IconSun size={17} /> : <IconMoon size={17} />}
          </IconButton>

          {canSync && (
            <Button variant="primary" onClick={runSync} disabled={syncing} icon={syncing ? <Spinner size={15} /> : <IconSync size={15} />}>
              <span className="hidden sm:inline">{syncing ? "Syncing…" : "Sync"}</span>
            </Button>
          )}

          {session?.user && (
            <div className="flex items-center gap-2">
              <span
                className="hidden max-w-[150px] truncate text-[12px] text-mut md:inline"
                title={session.user.email ?? undefined}
              >
                {session.user.email}
              </span>
              <Button variant="ghost" onClick={() => signOut({ callbackUrl: "/login" })}>
                <span className="hidden sm:inline">Sign out</span>
                <span className="sm:hidden">Out</span>
              </Button>
            </div>
          )}
        </header>

        <main className="flex-1 px-4 py-6 md:px-6 lg:px-8">
          <div key={pathname} className="animate-fade mx-auto max-w-[1360px]">
            {children}
          </div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onSync={runSync} syncing={syncing} />

      {/* ───────── sync toast ───────── */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 400, damping: 32 }}
            className="fixed bottom-5 right-5 z-[70] flex max-w-sm items-center gap-3 rounded-[var(--radius)] border border-line-strong bg-elevated px-4 py-3 text-sm shadow-[var(--shadow-lg)]"
          >
            <span
              className={cx(
                "grid h-7 w-7 shrink-0 place-items-center rounded-full",
                toast.ok ? "bg-[var(--green-soft)] text-green" : "bg-[var(--red-soft)] text-red",
              )}
            >
              {toast.ok ? <IconCheck size={16} /> : <IconAlert size={16} />}
            </span>
            <span className="text-txt">{toast.text}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SidebarFooter({
  theme,
  toggle,
  openPalette,
  lastSync,
}: {
  theme: string;
  toggle: () => void;
  openPalette: () => void;
  lastSync?: string | null;
}) {
  return (
    <div className="mt-4 flex flex-col gap-2 border-t border-line pt-3">
      <button
        onClick={openPalette}
        className="flex items-center justify-between rounded-[var(--radius-sm)] px-3 py-2 text-[13px] text-mut transition-colors hover:bg-hover hover:text-txt"
      >
        <span className="flex items-center gap-2.5">
          <IconSearch size={16} /> Command menu
        </span>
        <kbd className="rounded border border-line bg-bg px-1.5 py-0.5 text-[10px] font-medium">⌘K</kbd>
      </button>
      <div className="flex items-center justify-between px-3 py-1">
        <span className="flex items-center gap-2 text-[11px] text-faint">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green" />
          </span>
          Synced {ago(lastSync)}
        </span>
        <button
          onClick={toggle}
          aria-label="Toggle theme"
          className="grid h-7 w-7 place-items-center rounded-md text-mut transition-colors hover:bg-hover hover:text-txt"
        >
          {theme === "dark" ? <IconSun size={15} /> : <IconMoon size={15} />}
        </button>
      </div>
    </div>
  );
}
