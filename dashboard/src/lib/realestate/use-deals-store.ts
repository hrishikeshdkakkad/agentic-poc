"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  INITIAL_STORE,
  type Store,
  type Deal,
  getCurrent,
  updateCurrent,
  createDeal,
  duplicateCurrent,
  deleteCurrent,
  selectDeal,
  resetCurrent,
  copyConstructionBudget,
  pinBaseline,
  clearBaseline,
} from "./deals";
import type { Inputs } from "./defaults";
import type { Strategy } from "./model";
import { fetchDeals, putDeal, deleteDealReq } from "./deals-api";
import { runMigration } from "./migration";

export type SaveStatus = "idle" | "saving" | "saved" | "error";
export type PersistAction =
  | "edit"
  | "create"
  | "duplicate"
  | "delete"
  | "reset"
  | "select"
  | "baseline";
export type PersistMode = "debounce" | "immediate" | "none";

const DEBOUNCE_MS = 700;

// Save policy: which actions persist immediately, which debounce, which skip the
// DB entirely. Live keystroke edits debounce so we don't write per character;
// discrete structural actions persist at once; selection is client-only.
export function persistMode(action: PersistAction): PersistMode {
  if (action === "select") return "none";
  if (action === "edit") return "debounce";
  return "immediate";
}

export function useDealsStore() {
  const [store, setStore] = useState<Store>(INITIAL_STORE);
  const [hydrated, setHydrated] = useState(false);
  const [status, setStatus] = useState<SaveStatus>("idle");

  const storeRef = useRef(store);
  useEffect(() => {
    storeRef.current = store;
  }, [store]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Deal | null>(null); // the deal a debounced save is holding
  const failed = useRef<Map<string, Deal>>(new Map()); // per-deal, so one failure can't hide another

  // Load (+ one-time migration) on mount.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const deals = await runMigration(fetchDeals, putDeal);
        if (!alive) return;
        if (deals.length) {
          setStore({ deals, currentId: deals[0].id });
        } else {
          // Empty DB and nothing to migrate → seed a default deal and persist it.
          const seeded = createDeal({ deals: [], currentId: "" }, "SMV Layout");
          await putDeal(getCurrent(seeded));
          if (!alive) return;
          setStore(seeded);
        }
      } catch {
        if (alive) setStatus("error"); // backend unreachable → keep in-memory placeholder
      } finally {
        if (alive) setHydrated(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const persist = useCallback(async (deal: Deal) => {
    setStatus("saving");
    try {
      await putDeal(deal);
      failed.current.delete(deal.id);
      setStatus(failed.current.size ? "error" : "saved");
    } catch {
      failed.current.set(deal.id, deal); // keep every failed deal recoverable, not just the last
      setStatus("error");
    }
  }, []);

  // Fire any pending debounced save immediately. Used before a superseding action
  // for a different deal, and on unmount, so in-flight keystrokes are never dropped.
  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const p = pending.current;
    pending.current = null;
    if (p) void persist(p);
  }, [persist]);

  const schedule = useCallback(
    (action: PersistAction, deal: Deal) => {
      const mode = persistMode(action);
      if (mode === "none") return;
      // A pending edit for a DIFFERENT deal must be saved before this action drops
      // the timer — otherwise the prior deal's last keystrokes are lost. A pending
      // edit for the SAME deal is safely superseded by the newer snapshot below.
      if (pending.current && pending.current.id !== deal.id) flush();
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (mode === "immediate") {
        pending.current = null;
        void persist(deal);
        return;
      }
      setStatus("saving");
      pending.current = deal;
      timer.current = setTimeout(() => {
        timer.current = null;
        const d = pending.current;
        pending.current = null;
        if (d) void persist(d);
      }, DEBOUNCE_MS);
    },
    [persist, flush],
  );

  // Flush a still-pending debounced save when the component unmounts (e.g. the
  // user navigates away mid-edit) so those keystrokes reach the DB.
  useEffect(() => () => flush(), [flush]);

  // Apply a pure store op, commit to React + ref, then run the save policy.
  const apply = useCallback(
    (action: PersistAction, fn: (s: Store) => Store) => {
      const next = fn(storeRef.current);
      storeRef.current = next;
      setStore(next);
      if (action !== "delete") schedule(action, getCurrent(next));
      return next;
    },
    [schedule],
  );

  const actions = {
    updateInputs: (patch: Partial<Inputs>) =>
      apply("edit", (s) => updateCurrent(s, { inputs: { ...getCurrent(s).inputs, ...patch } })),
    setStrategy: (next: Strategy) => apply("edit", (s) => updateCurrent(s, { strategy: next })),
    setUsdRate: (r: number) => apply("edit", (s) => updateCurrent(s, { usdRate: r })),
    rename: (name: string) => apply("edit", (s) => updateCurrent(s, { name })),
    create: (name = "New deal") => apply("create", (s) => createDeal(s, name)),
    duplicate: () => apply("duplicate", (s) => duplicateCurrent(s)),
    reset: () => apply("reset", (s) => resetCurrent(s)),
    select: (id: string) => apply("select", (s) => selectDeal(s, id)),
    pinBaseline: (name?: string) => apply("baseline", (s) => pinBaseline(s, name)),
    clearBaseline: () => apply("baseline", (s) => clearBaseline(s)),
    remove: () => {
      const removedId = storeRef.current.currentId;
      const wasLast = storeRef.current.deals.length <= 1;
      // Drop any pending/failed save for the deal we're deleting — otherwise a
      // debounced edit fired after the delete would resurrect it via upsert.
      if (pending.current?.id === removedId) {
        if (timer.current) {
          clearTimeout(timer.current);
          timer.current = null;
        }
        pending.current = null;
      }
      failed.current.delete(removedId);
      const next = apply("delete", (s) => deleteCurrent(s));
      const reseeded = getCurrent(next); // deleteCurrent reseeds a fresh default when last
      void (async () => {
        setStatus("saving");
        try {
          // Persist the reseed BEFORE deleting the old row, so a failed reseed can
          // never leave an empty DB behind a phantom deal the UI still shows.
          if (wasLast) await putDeal(reseeded);
          await deleteDealReq(removedId);
          setStatus(failed.current.size ? "error" : "saved");
        } catch {
          if (wasLast) failed.current.set(reseeded.id, reseeded); // recover via retry
          setStatus("error");
        }
      })();
    },
    retry: () => {
      for (const d of failed.current.values()) void persist(d);
    },
    copyBudgetTo: (targetIds: string[]) => {
      const sourceId = storeRef.current.currentId;
      const next = copyConstructionBudget(storeRef.current, sourceId, targetIds);
      storeRef.current = next;
      setStore(next);
      const targets = targetIds
        .filter((id) => id !== sourceId)
        .map((id) => next.deals.find((x) => x.id === id))
        .filter((d): d is Deal => !!d);
      void (async () => {
        setStatus("saving");
        const results = await Promise.allSettled(targets.map((d) => putDeal(d)));
        results.forEach((r, idx) => {
          if (r.status === "rejected") failed.current.set(targets[idx].id, targets[idx]);
        });
        setStatus(failed.current.size ? "error" : "saved");
      })();
    },
  };

  return { store, current: getCurrent(store), hydrated, status, actions };
}
