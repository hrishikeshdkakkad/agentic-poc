"use client";

import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useTheme } from "@/components/theme";
import { NAV } from "@/components/nav";
import { permissionsForRoles, allowedPages } from "@/lib/rbac";
import {
  IconCornerDownLeft,
  IconMoon,
  IconSearch,
  IconSun,
  IconSync,
} from "@/components/icons";
import { cx, Spinner } from "@/components/ui";

type Cmd = {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: React.ReactNode;
  keywords?: string;
  run: () => void;
  busy?: boolean;
};

export function CommandPalette({
  open,
  onClose,
  onSync,
  syncing,
}: {
  open: boolean;
  onClose: () => void;
  onSync: () => void;
  syncing: boolean;
}) {
  const router = useRouter();
  const { theme, toggle } = useTheme();
  const { data: session } = useSession();
  const perms = permissionsForRoles(session?.user?.roles ?? []);
  const allowed = new Set(allowedPages(perms));
  const canSync = perms.has("*") || perms.has("sync:run");
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setQ("");
    setActive(0);
    onClose();
  }, [onClose]);

  const commands = useMemo<Cmd[]>(() => {
    const nav: Cmd[] = NAV.filter((n) => allowed.has(n.href)).map((n) => ({
      id: `nav:${n.href}`,
      label: n.label,
      hint: n.href,
      group: "Navigate",
      icon: <n.icon size={16} />,
      keywords: n.label,
      run: () => {
        router.push(n.href);
        close();
      },
    }));
    const actions: Cmd[] = [
      {
        id: "sync",
        label: "Sync now",
        hint: "Pull latest from Plaid",
        group: "Actions",
        keywords: "refresh update plaid pull",
        icon: syncing ? <Spinner size={16} /> : <IconSync size={16} />,
        busy: syncing,
        run: () => {
          onSync();
          close();
        },
      },
      {
        id: "theme",
        label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
        hint: "Appearance",
        group: "Actions",
        keywords: "theme dark light appearance mode",
        icon: theme === "dark" ? <IconSun size={16} /> : <IconMoon size={16} />,
        run: () => {
          toggle();
          close();
        },
      },
    ];
    return [...nav, ...actions.filter((c) => c.id !== "sync" || canSync)];
  }, [router, close, onSync, syncing, theme, toggle, session, allowed, canSync]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((c) =>
      `${c.label} ${c.keywords ?? ""} ${c.hint ?? ""}`.toLowerCase().includes(needle),
    );
  }, [q, commands]);

  useEffect(() => {
    if (open) {
      // focus after the enter animation begins
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  const selected = Math.min(active, Math.max(results.length - 1, 0));

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        results[selected]?.run();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, results, selected, close]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // group while preserving order
  const grouped = useMemo(() => {
    const map = new Map<string, Array<{ cmd: Cmd; idx: number }>>();
    results.forEach((cmd, idx) => {
      const arr = map.get(cmd.group) ?? [];
      arr.push({ cmd, idx });
      map.set(cmd.group, arr);
    });
    return [...map.entries()];
  }, [results]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 bg-black/55 backdrop-blur-[3px]"
            onClick={close}
          />
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 460, damping: 34 }}
            className="relative w-full max-w-xl overflow-hidden rounded-[var(--radius-lg)] border border-line-strong bg-elevated shadow-[var(--shadow-lg)]"
          >
            <div className="flex items-center gap-3 border-b border-line px-4">
              <IconSearch size={18} className="text-mut" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setActive(0);
                }}
                placeholder="Jump to a page or run a command…"
                className="w-full bg-transparent py-4 text-[15px] text-txt outline-none placeholder:text-faint"
              />
              <kbd className="rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] font-medium text-mut">
                ESC
              </kbd>
            </div>

            <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-2">
              {results.length === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-mut">No matches for “{q}”</div>
              ) : (
                grouped.map(([group, items]) => (
                  <div key={group} className="mb-1">
                    <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-faint">
                      {group}
                    </div>
                    {items.map(({ cmd, idx }) => (
                      <button
                        key={cmd.id}
                        data-idx={idx}
                        onMouseMove={() => setActive(idx)}
                        onClick={() => cmd.run()}
                        className={cx(
                          "flex w-full items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2.5 text-left text-sm transition-colors",
                          idx === selected ? "bg-[var(--accent-soft)] text-txt" : "text-mut hover:text-txt",
                        )}
                      >
                        <span className={cx(idx === selected ? "text-accent" : "text-mut")}>{cmd.icon}</span>
                        <span className="flex-1 font-medium text-txt">{cmd.label}</span>
                        {cmd.hint && <span className="text-xs text-faint">{cmd.hint}</span>}
                        {idx === selected && <IconCornerDownLeft size={14} className="text-faint" />}
                      </button>
                    ))}
                  </div>
                ))
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
