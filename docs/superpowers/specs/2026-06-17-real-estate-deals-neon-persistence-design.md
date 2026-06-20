# Real-estate deals — Neon persistence

**Date:** 2026-06-17
**Scope:** Move the real-estate page's deal storage from browser `localStorage` to the Neon Postgres database, so all deals and their data points are served by the backend. Touches `dashboard/` only (new server-side DB module, new local API routes, a persistence hook, and the I/O boundary in `deals.ts` + `page.tsx`). **No engine/model/UI-layout changes** — `engine.test.ts` / `financing.test.ts` / `timeline.test.ts` / `model` math stay byte-for-byte identical.

## Problem

Every real-estate deal lives only in the browser, in `localStorage` under `vault:realestate:deals:v1` (`dashboard/src/lib/realestate/deals.ts`). Deals don't survive a cache wipe, don't cross devices/browsers, and aren't backed up. The page already reads *live finance* context from the backend (`ContextStrip` → `get_net_worth_history`, `get_portfolio_analysis`), but the deals themselves never leave the browser. The goal: make Neon the source of truth for deals while keeping the live-edit feel and the honest-returns engine exactly as they are.

## Decisions (locked with user)

1. **Write path: local-only.** Deals read and write straight to Neon through Next.js route handlers (`/api/realestate/…`). **Nothing is added to the MCP server** — no new tools, the allowlist is untouched, and deal mutation never reaches the public bearer-gated surface. This introduces the dashboard's *first* server-side Postgres credential (`DATABASE_URL`), used only inside route handlers and never shipped to the browser.
2. **Migrate existing deals once.** On first load, if Neon has no deals but `localStorage` still has them, push the local deals into Neon one time (idempotent by id, original `createdAt` preserved), then read from Neon onward.
3. **Approach A — thin DB mirror.** Keep the `Store` / `Deal` / `Inputs` types and every pure op in `deals.ts`. Replace only the I/O boundary (`loadStore`/`saveStore` → HTTP). One row per deal; `inputs` stored as a `JSONB` document. (Rejected: B normalized tables — overkill, churns on every `Inputs` change; C SWR-per-resource rewrite — larger change for no near-term gain.)

## Architecture

```
browser (React, pure engine)
  ⇅  fetch  /api/realestate/deals[…]      ← Next.js route handlers (server-side)
        ⇅  pg.Pool (DATABASE_URL)
            ⇅  Neon: real_estate_deals
```

Only the **inputs** persist. Every headline figure (honest IRR, downside ladder, sensitivity grid, financing, timeline) is recomputed by pure functions at render time and is never stored — the engine stays the single source of truth for math.

### Database schema (dashboard-owned DDL)

Created idempotently by the dashboard's DB module on first use (mirrors `storage.py`'s `_schema_ensured` cache), so deals are self-contained and don't depend on the Python backend having run:

```sql
CREATE TABLE IF NOT EXISTS real_estate_deals (
  id          TEXT PRIMARY KEY,            -- client-generated 8-char id; preserved on migration
  name        TEXT NOT NULL,
  strategy    TEXT NOT NULL DEFAULT 'sellAll',
  usd_rate    DOUBLE PRECISION NOT NULL DEFAULT 86,
  inputs      JSONB NOT NULL,              -- whole Inputs doc (investors/tranches nested)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_real_estate_deals_updated ON real_estate_deals (updated_at DESC);
```

- `updated_at` is **server-authoritative** (`now()` on every upsert) — safe across multiple open tabs.
- `created_at` is preserved on conflict, and accepted from the payload during migration so migrated deals keep their real date.
- Row↔`Deal` mapper converts `TIMESTAMPTZ ↔ epoch-ms number`, so the client `Deal` type (`createdAt`/`updatedAt: number`) is unchanged.
- On read, `inputs` is re-run through `normalizeInputs` (and `migrateInputs`) for forward-compatibility as the model evolves.

### Server side (new, `import "server-only"`)

- **`dashboard/src/lib/realestate/db.ts`** — a `globalThis`-cached `pg.Pool` singleton (standard guard against `next dev` hot-reload leaking pools), `ensureSchema()` (once per process), and:
  - `listDeals(): Promise<Deal[]>` — ordered by `updated_at desc`.
  - `upsertDeal(deal: Deal): Promise<Deal>` — `INSERT … ON CONFLICT (id) DO UPDATE`, returns the saved row mapped to `Deal`.
  - `deleteDeal(id: string): Promise<void>`.
  - Row↔`Deal` mapping (`rowToDeal` / serialization).
- **`dashboard/src/app/api/realestate/deals/route.ts`** — `GET` → `{ deals: Deal[] }`.
- **`dashboard/src/app/api/realestate/deals/[id]/route.ts`** — `PUT` (upsert one; body is a `Deal`) → `{ deal }`; `DELETE` → `{ ok: true }`. Inputs validated via `normalizeInputs` + `validateInputs`; failures return `{ error }` with a non-2xx status (matches `api.ts` `unwrap`).

### Client side

- **`deals.ts`**: remove `KEY`, `loadStore`, `saveStore`, `seed` (the localStorage layer). Keep `Deal`/`Store` types, `INITIAL_STORE` (SSR placeholder), `newId`, `blankDeal`, all pure ops (`getCurrent`, `updateCurrent`, `createDeal`, `duplicateCurrent`, `deleteCurrent`, `selectDeal`, `resetCurrent`), and `migrateInputs`.
- **`dashboard/src/lib/realestate/deals-api.ts`** (new, client) — `fetchDeals()`, `putDeal(deal)`, `deleteDealReq(id)` using the same `fetch` + `unwrap` style as `api.ts`.
- **`dashboard/src/lib/realestate/use-deals-store.ts`** (new, client hook) — owns the full I/O lifecycle: load + one-time migration on mount; exposes `{ store, current, hydrated, status, actions }`; persists as a side effect of each action. All network logic lives here so `page.tsx` only calls `actions.*`.
- **`page.tsx`**: replace the two `useEffect`s and inline `setStore` calls with the hook; add a small **save-status indicator** (`Saved · Saving… · Save failed — Retry`); change the footer note from "stored per-browser (localStorage)" to "saved to your database."

### Save semantics (preserves the live feel)

Local React state still drives instant engine recompute on every keystroke. Persistence is decoupled:

- **Debounced upsert (~700 ms after edits settle)** for field / name / strategy / USD-rate edits (`updateCurrent`).
- **Immediate** upsert/delete for structural actions: `create`, `duplicate`, `delete`, `reset`.
- Deleting the last deal reseeds a fresh default (current behavior preserved) and persists it.
- Failed saves surface in the status indicator with a retry; last-write-wins (single user — no optimistic-concurrency control).

### One-time migration

On mount: `GET` deals. If the server is **empty** *and* a `vault:realestate:deals:v1` store still exists in `localStorage`, `PUT` each local deal once (idempotent by id; original `createdAt` sent and preserved), set a `vault:realestate:migrated:v1` marker so it never re-fires, then read from the server. After migration, localStorage is never read again.

## Dependencies & env

- Add `pg` + `@types/pg`. Chosen over the Neon HTTP driver specifically so the same code runs against both Neon **and** the local test Postgres at `:5433`.
- Add `DATABASE_URL` to `dashboard/.env.local.example` (server-only).

## Testing

- **Pure (no DB):** row↔`Deal` serialization (incl. epoch-ms ↔ timestamptz), and the migration-trigger logic (empty-server + local-store → migrate; marker prevents re-fire).
- **Route:** mirror `dashboard/src/app/api/link/route.test.ts` for the new `/api/realestate/deals` handlers (mock the `db` module).
- **Integration (optional, skips when `:5433` unreachable):** `ensureSchema` + `upsertDeal`/`listDeals`/`deleteDeal` round-trip against the test Postgres — same skip posture as the Python `db` fixture.
- Existing `engine.test.ts` / `financing.test.ts` / `timeline.test.ts` stay green (untouched).

## File-change map

| File | Change |
|---|---|
| `dashboard/src/lib/realestate/deals.ts` | Remove localStorage layer (`KEY`/`loadStore`/`saveStore`/`seed`); keep types + pure ops + `migrateInputs` |
| `dashboard/src/lib/realestate/db.ts` | **New.** `server-only` pg pool, `ensureSchema`, `listDeals`/`upsertDeal`/`deleteDeal`, row↔`Deal` mapping |
| `dashboard/src/lib/realestate/deals-api.ts` | **New.** Client fetch helpers (`fetchDeals`/`putDeal`/`deleteDealReq`) |
| `dashboard/src/lib/realestate/use-deals-store.ts` | **New.** Load+migrate+persist hook; debounced/immediate save policy; status |
| `dashboard/src/app/api/realestate/deals/route.ts` | **New.** `GET` list |
| `dashboard/src/app/api/realestate/deals/[id]/route.ts` | **New.** `PUT` upsert, `DELETE` |
| `dashboard/src/app/real-estate/page.tsx` | Use the hook; save-status indicator; footer-note copy |
| `dashboard/.env.local.example` | Add `DATABASE_URL` |
| `dashboard/package.json` | Add `pg` + `@types/pg` |
| `dashboard/src/lib/realestate/*.test.ts`, `.../api/realestate/route.test.ts` | **New** tests (serialization, migration trigger, route, optional integration) |

## Security / exposure note

Deals live in the same `DATABASE_URL` as the finance history, so the generic `query_finances` / `describe_tables` MCP tools *could read* `real_estate_deals` (they cannot write it — no CRUD tools added). The data isn't sensitive (no tokens), so it stays in the same DB. If deals must be invisible to MCP entirely, point the dashboard at a separate connection string — deferred unless requested.

## Non-goals

- No engine/model/format changes; no UI redesign.
- No new MCP tools; allowlist and `test_dashboard_contract.py` untouched.
- No multi-user/auth; no optimistic-concurrency control.

## Verification

- `cd dashboard && npm run build` (typecheck) passes; `npm test` (vitest) green.
- Manual: first load auto-migrates the SMV deal; edits persist across refresh; create/duplicate/delete/switch persist; save-status reflects state; invalid-input blocking still works; dark + light + mobile unaffected.
