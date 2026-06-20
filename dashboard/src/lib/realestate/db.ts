import "server-only";
import { Pool } from "pg";
import type { Deal } from "./deals";
import { rowToDeal, dealToInsertParams, type DealRow } from "./db-serialize";

// One pool per process, cached on globalThis so `next dev` hot-reload doesn't
// leak a new pool on every module re-evaluation.
declare global {
  // eslint-disable-next-line no-var
  var __realEstatePool: Pool | undefined;
}

function pool(): Pool {
  if (!globalThis.__realEstatePool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    globalThis.__realEstatePool = new Pool({ connectionString, max: 3 });
  }
  return globalThis.__realEstatePool;
}

const DDL = `
CREATE TABLE IF NOT EXISTS real_estate_deals (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  strategy    TEXT NOT NULL DEFAULT 'sellAll',
  usd_rate    DOUBLE PRECISION NOT NULL DEFAULT 86,
  inputs      JSONB NOT NULL,
  baseline    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Additive, idempotent: brings pre-baseline tables up to shape without a migration.
ALTER TABLE real_estate_deals ADD COLUMN IF NOT EXISTS baseline JSONB;
CREATE INDEX IF NOT EXISTS idx_real_estate_deals_updated ON real_estate_deals (updated_at DESC);`;

let schemaReady: Promise<void> | undefined;
export function ensureSchema(): Promise<void> {
  // Don't memoize a rejected promise: a transient cold-start DB error must not be
  // cached for the process lifetime. On failure, clear the cache so the next call
  // retries the DDL once the DB recovers.
  if (!schemaReady) {
    schemaReady = pool()
      .query(DDL)
      .then(() => undefined)
      .catch((err) => {
        schemaReady = undefined;
        throw err;
      });
  }
  return schemaReady;
}

const COLS = "id, name, strategy, usd_rate, inputs, baseline, created_at, updated_at";

export async function listDeals(): Promise<Deal[]> {
  await ensureSchema();
  const { rows } = await pool().query<DealRow>(
    `SELECT ${COLS} FROM real_estate_deals ORDER BY updated_at DESC`,
  );
  return rows.map(rowToDeal);
}

export async function upsertDeal(deal: Deal): Promise<Deal> {
  await ensureSchema();
  const { rows } = await pool().query<DealRow>(
    `INSERT INTO real_estate_deals (id, name, strategy, usd_rate, inputs, created_at, baseline, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       strategy = EXCLUDED.strategy,
       usd_rate = EXCLUDED.usd_rate,
       inputs = EXCLUDED.inputs,
       baseline = EXCLUDED.baseline,
       updated_at = now()
     RETURNING ${COLS}`,
    dealToInsertParams(deal),
  );
  if (!rows[0]) throw new Error(`upsertDeal: no row returned for deal ${deal.id}`);
  return rowToDeal(rows[0]);
}

export async function deleteDeal(id: string): Promise<void> {
  await ensureSchema();
  await pool().query("DELETE FROM real_estate_deals WHERE id = $1", [id]);
}
