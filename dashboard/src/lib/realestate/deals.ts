// Per-deal model + pure store operations for the real-estate view. A "deal" is
// one named saved scenario — its inputs, strategy, and USD rate. Persistence
// lives in Neon (see ./db, ./deals-api, ./use-deals-store); this module is pure
// data + transforms with no I/O, so it stays trivially testable.

import {
  cloneInputs,
  DEFAULTS,
  DEFAULT_USD_RATE,
  Inputs,
  normalizeInputs,
  normalizeUsdRate,
} from "./defaults";
import { Strategy } from "./model";

// What a deal's inputs may look like on disk: a current `Inputs`, OR a pre-
// generalization deal that stored the co-investor as flat `manoj1`/`manoj2`
// fields with no `investors` array.
type StoredInputs = Partial<Inputs> & { manoj1?: number; manoj2?: number };

/**
 * Bring a stored deal's inputs up to the current shape: backfill any newly-added
 * scalar field from DEFAULTS, and — for legacy deals — rebuild the Manoj unit-
 * buyer from the old `manoj1`/`manoj2` so saved numbers survive the upgrade.
 */
export function migrateInputs(raw: StoredInputs): Inputs {
  const merged: Inputs & { manoj1?: number; manoj2?: number } = { ...DEFAULTS, ...raw };
  if (!Array.isArray(raw.investors) && (raw.manoj1 != null || raw.manoj2 != null)) {
    merged.investors = [
      {
        id: "manoj",
        name: "Manoj",
        kind: "unit",
        units: 1,
        tranches: [
          { amount: raw.manoj1 ?? 0, month: 0 },
          { amount: raw.manoj2 ?? 0, month: 12 },
        ],
      },
    ];
  }
  delete merged.manoj1;
  delete merged.manoj2;
  return normalizeInputs(merged);
}

export type Baseline = {
  name: string;
  inputs: Inputs; // a depth-1 snapshot of the deal's inputs at pin time
  pinnedAt: number;
};

export type Deal = {
  id: string;
  name: string;
  inputs: Inputs;
  strategy: Strategy;
  usdRate: number;
  createdAt: number;
  updatedAt: number;
  // Pinned "approved" snapshot the live deal is compared against. Persisted as a
  // sibling JSONB column (NOT nested in inputs — normalizeInputs would strip it).
  baseline?: Baseline;
};

export type Store = {
  deals: Deal[];
  currentId: string;
};

// Stable, deterministic initial state for SSR + first client render so React
// hydration sees identical output. Real data swaps in via the deals hook.
export const INITIAL_STORE: Store = {
  deals: [
    {
      id: "init",
      name: "SMV Layout",
      inputs: cloneInputs(DEFAULTS),
      strategy: "sellAll",
      usdRate: DEFAULT_USD_RATE,
      createdAt: 0,
      updatedAt: 0,
    },
  ],
  currentId: "init",
};

export function newId(): string {
  // Full UUID: the old 8-hex-char slice (32 bits) could collide, and the DB
  // write is an upsert — a collision would silently overwrite another deal.
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function blankDeal(name: string): Deal {
  const now = Date.now();
  return {
    id: newId(),
    name,
    inputs: cloneInputs(DEFAULTS),
    strategy: "sellAll",
    usdRate: DEFAULT_USD_RATE,
    createdAt: now,
    updatedAt: now,
  };
}

// ---- pure operations (return new Store) ----

export function getCurrent(store: Store): Deal {
  return store.deals.find((d) => d.id === store.currentId) ?? store.deals[0];
}

export function updateCurrent(
  store: Store,
  patch: Partial<Pick<Deal, "inputs" | "strategy" | "usdRate" | "name">>,
): Store {
  const now = Date.now();
  return {
    ...store,
    deals: store.deals.map((d) =>
      d.id === store.currentId
        ? {
            ...d,
            ...patch,
            inputs: patch.inputs ? normalizeInputs(patch.inputs) : d.inputs,
            usdRate: patch.usdRate == null ? d.usdRate : normalizeUsdRate(patch.usdRate),
            updatedAt: now,
          }
        : d,
    ),
  };
}

export function createDeal(store: Store, name = "New deal"): Store {
  const deal = blankDeal(name);
  return { deals: [...store.deals, deal], currentId: deal.id };
}

export function duplicateCurrent(store: Store): Store {
  const cur = getCurrent(store);
  const now = Date.now();
  const dup: Deal = {
    ...cur,
    id: newId(),
    name: `${cur.name} (copy)`,
    inputs: cloneInputs(cur.inputs),
    baseline: cur.baseline
      ? { ...cur.baseline, inputs: cloneInputs(cur.baseline.inputs) }
      : undefined,
    createdAt: now,
    updatedAt: now,
  };
  return { deals: [...store.deals, dup], currentId: dup.id };
}

/** Pin the current inputs as the named baseline the deal is compared against. */
export function pinBaseline(store: Store, name = "Baseline"): Store {
  const cur = getCurrent(store);
  const baseline: Baseline = {
    name: name.trim() || "Baseline",
    inputs: cloneInputs(cur.inputs),
    pinnedAt: Date.now(),
  };
  const now = Date.now();
  return {
    ...store,
    deals: store.deals.map((d) =>
      d.id === store.currentId ? { ...d, baseline, updatedAt: now } : d,
    ),
  };
}

/** Drop the pinned baseline. */
export function clearBaseline(store: Store): Store {
  const now = Date.now();
  return {
    ...store,
    deals: store.deals.map((d) =>
      d.id === store.currentId ? { ...d, baseline: undefined, updatedAt: now } : d,
    ),
  };
}

export function deleteCurrent(store: Store): Store {
  if (store.deals.length <= 1) {
    const fresh = blankDeal("SMV Layout");
    return { deals: [fresh], currentId: fresh.id };
  }
  const remaining = store.deals.filter((d) => d.id !== store.currentId);
  return { deals: remaining, currentId: remaining[0].id };
}

export function selectDeal(store: Store, id: string): Store {
  if (!store.deals.find((d) => d.id === id)) return store;
  return { ...store, currentId: id };
}

export function resetCurrent(store: Store): Store {
  return updateCurrent(store, {
    inputs: cloneInputs(DEFAULTS),
    strategy: "sellAll",
    usdRate: DEFAULT_USD_RATE,
  });
}

// Copy the source deal's construction budget into the target deals (deep clone).
export function copyConstructionBudget(store: Store, sourceId: string, targetIds: string[]): Store {
  const src = store.deals.find((d) => d.id === sourceId);
  if (!src) return store;
  const now = Date.now();
  return {
    ...store,
    deals: store.deals.map((d) =>
      targetIds.includes(d.id) && d.id !== sourceId
        ? {
            ...d,
            inputs: {
              ...d.inputs,
              constructionExpenses: src.inputs.constructionExpenses.map((e) => ({ ...e })),
            },
            updatedAt: now,
          }
        : d,
    ),
  };
}
