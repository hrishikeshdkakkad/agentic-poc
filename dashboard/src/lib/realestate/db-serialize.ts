// Pure mapping between Postgres rows / HTTP payloads and the client `Deal` shape.
// No `pg`, no `server-only` — safe to import in unit tests and on either side.
import { normalizeInputs, normalizeUsdRate, type Inputs } from "./defaults";
import type { Deal } from "./deals";
import type { Strategy } from "./model";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const coerceStrategy = (v: unknown): Strategy => (v === "hold1" ? "hold1" : "sellAll");

// A pinned baseline is a depth-1 snapshot: its nested `inputs` is normalized the
// same way the live inputs are, but it never carries its own baseline. Kept as a
// sibling of `inputs` (never nested inside it) so normalizeInputs — which whitelists
// keys and would silently drop an unknown nested field — leaves it intact.
function normalizeBaseline(raw: unknown): Deal["baseline"] {
  if (!isRecord(raw)) return undefined;
  return {
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : "Baseline",
    inputs: normalizeInputs(raw.inputs as Partial<Inputs>),
    pinnedAt: typeof raw.pinnedAt === "number" ? raw.pinnedAt : Date.now(),
  };
}

export type DealRow = {
  id: string;
  name: string;
  strategy: string;
  usd_rate: number | string;
  inputs: unknown;
  baseline?: unknown;
  created_at: Date;
  updated_at: Date;
};

export function rowToDeal(row: DealRow): Deal {
  return {
    id: row.id,
    name: row.name,
    strategy: coerceStrategy(row.strategy),
    usdRate: normalizeUsdRate(typeof row.usd_rate === "string" ? Number(row.usd_rate) : row.usd_rate),
    inputs: normalizeInputs(row.inputs as Partial<Inputs>),
    baseline: normalizeBaseline(row.baseline),
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
}

export function dealFromPayload(id: string, body: unknown): Deal {
  const b = isRecord(body) ? body : {};
  const now = Date.now();
  return {
    id,
    name: typeof b.name === "string" && b.name.trim() ? b.name : "Untitled deal",
    strategy: coerceStrategy(b.strategy),
    usdRate: normalizeUsdRate(b.usdRate),
    inputs: normalizeInputs(b.inputs as Partial<Inputs>),
    baseline: normalizeBaseline(b.baseline),
    createdAt: typeof b.createdAt === "number" ? b.createdAt : now,
    updatedAt: now,
  };
}

// baseline is the LAST param (positional indices of the earlier params are stable).
export function dealToInsertParams(
  deal: Deal,
): [string, string, string, number, string, Date, string | null] {
  return [
    deal.id,
    deal.name,
    deal.strategy,
    deal.usdRate,
    JSON.stringify(deal.inputs),
    new Date(deal.createdAt || Date.now()),
    deal.baseline ? JSON.stringify(deal.baseline) : null,
  ];
}
