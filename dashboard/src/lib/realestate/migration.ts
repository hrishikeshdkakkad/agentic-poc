// One-time port of deals from the legacy browser localStorage store into Neon.
// The pure helpers (parse + decision) are unit-tested; runMigration wires them
// to window.localStorage and is exercised via the hook + manual verification.
import { migrateInputs, type Deal } from "./deals";
import { normalizeUsdRate } from "./defaults";
import type { Strategy } from "./model";

export const LEGACY_STORAGE_KEY = "vault:realestate:deals:v1";
export const MIGRATED_MARKER_KEY = "vault:realestate:migrated:v1";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

export function parseLegacyStore(raw: string | null): Deal[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.deals)) return [];
  return parsed.deals.filter(isRecord).map((d, i) => ({
    id: typeof d.id === "string" && d.id ? d.id : `legacy-${i}`,
    name: typeof d.name === "string" && d.name ? d.name : "Imported deal",
    strategy: (d.strategy === "hold1" ? "hold1" : "sellAll") as Strategy,
    usdRate: normalizeUsdRate(d.usdRate),
    inputs: migrateInputs(isRecord(d.inputs) ? d.inputs : {}),
    createdAt: typeof d.createdAt === "number" ? d.createdAt : Date.now(),
    updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : Date.now(),
  }));
}

export function needsMigration(serverDeals: Deal[], legacy: Deal[], alreadyMigrated: boolean): boolean {
  return serverDeals.length === 0 && legacy.length > 0 && !alreadyMigrated;
}

export async function runMigration(
  fetchFn: () => Promise<Deal[]>,
  putFn: (d: Deal) => Promise<Deal>,
): Promise<Deal[]> {
  const serverDeals = await fetchFn();
  if (typeof window === "undefined") return serverDeals;
  const alreadyMigrated = !!window.localStorage.getItem(MIGRATED_MARKER_KEY);
  const legacy = parseLegacyStore(window.localStorage.getItem(LEGACY_STORAGE_KEY));
  if (!needsMigration(serverDeals, legacy, alreadyMigrated)) return serverDeals;
  // Attempt every deal independently — a single failure must not abort the rest
  // (the old for-await stranded every deal after the first error). putFn is an
  // idempotent upsert keyed by id, so this is safe to re-run.
  const results = await Promise.allSettled(legacy.map((deal) => putFn(deal)));
  if (results.every((r) => r.status === "fulfilled")) {
    // Mark complete only when the whole set landed, so a partial failure re-runs.
    window.localStorage.setItem(MIGRATED_MARKER_KEY, "1");
    return legacy;
  }
  // Partial failure: leave the marker unset and return the deals that actually
  // persisted, so the UI matches the DB instead of showing unsaved phantoms.
  return fetchFn();
}
