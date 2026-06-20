# Real-estate Deals → Neon Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move real-estate deal storage from browser `localStorage` to Neon Postgres, served by local Next.js API routes, while keeping the engine, UI, and live-edit feel unchanged.

**Architecture:** Browser (pure engine) ⇄ Next.js route handlers (`/api/realestate/deals…`, server-side) ⇄ Neon via a `pg` pool. Only deal *inputs* persist (one row per deal, `inputs` as `JSONB`); all headline figures stay derived at render time. The MCP server, its tools, and its allowlist are untouched.

**Tech Stack:** Next.js 16.2.9 (App Router route handlers), React 19, TypeScript (strict), `pg` (node-postgres), `server-only`, vitest 4 (node environment).

## Global Constraints

- Next.js `16.2.9`, React `19.2.4`, vitest `4.1.8`, test `environment: "node"` (no jsdom → unit-test **pure functions only**; verify React wiring via `npm run build` + manual).
- Path alias: `@/*` → `dashboard/src/*`.
- DB: Neon via `DATABASE_URL` (server-only). Test DB: `postgresql://finance:finance@127.0.0.1:5433/finance` (override with `TEST_DATABASE_URL`); integration tests **skip** when unreachable.
- Do NOT add MCP tools; do NOT touch `dashboard/src/lib/tools.ts` or `tests/test_dashboard_contract.py`.
- Do NOT change engine/model/format logic — `engine.test.ts` / `financing.test.ts` / `timeline.test.ts` stay green.
- Reuse existing `normalizeInputs` / `normalizeUsdRate` / `validateInputs` / `migrateInputs` — never duplicate the model.
- `Deal` type is unchanged: `createdAt` / `updatedAt` remain epoch-ms `number`s.
- Route response shape matches existing routes: success → `Response.json(data)`; failure → `Response.json({ error, service? }, { status })`.
- All commands run from `dashboard/`.

---

### Task 1: Dependencies, env, and the pure deal serializer

**Files:**
- Modify: `dashboard/package.json` (add deps)
- Modify: `dashboard/.env.local.example`
- Create: `dashboard/src/lib/realestate/db-serialize.ts`
- Test: `dashboard/src/lib/realestate/db-serialize.test.ts`

**Interfaces:**
- Consumes: `Deal` (`./deals`), `Inputs`/`normalizeInputs`/`normalizeUsdRate` (`./defaults`), `Strategy` (`./model`).
- Produces:
  - `type DealRow = { id: string; name: string; strategy: string; usd_rate: number | string; inputs: unknown; created_at: Date; updated_at: Date }`
  - `rowToDeal(row: DealRow): Deal`
  - `dealFromPayload(id: string, body: unknown): Deal`
  - `dealToInsertParams(deal: Deal): [string, string, string, number, string, Date]`

- [ ] **Step 1: Install deps**

```bash
npm install pg server-only
npm install -D @types/pg
```

- [ ] **Step 2: Add DATABASE_URL to the env example**

Append to `dashboard/.env.local.example`:

```
# Real-estate deals are persisted here (server-only; never shipped to the browser).
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DB?sslmode=require
```

- [ ] **Step 3: Write the failing test**

Create `dashboard/src/lib/realestate/db-serialize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rowToDeal, dealFromPayload, dealToInsertParams, type DealRow } from "./db-serialize";
import { DEFAULTS } from "./defaults";

const row: DealRow = {
  id: "abc12345",
  name: "SMV Layout",
  strategy: "sellAll",
  usd_rate: 86,
  inputs: DEFAULTS,
  created_at: new Date(1_700_000_000_000),
  updated_at: new Date(1_700_000_500_000),
};

describe("rowToDeal", () => {
  it("maps a DB row to a Deal with epoch-ms timestamps", () => {
    const d = rowToDeal(row);
    expect(d.id).toBe("abc12345");
    expect(d.createdAt).toBe(1_700_000_000_000);
    expect(d.updatedAt).toBe(1_700_000_500_000);
    expect(d.usdRate).toBe(86);
    expect(d.inputs.units).toBe(DEFAULTS.units);
  });

  it("coerces unknown strategy to sellAll and numeric-string usd_rate", () => {
    const d = rowToDeal({ ...row, strategy: "garbage", usd_rate: "90" });
    expect(d.strategy).toBe("sellAll");
    expect(d.usdRate).toBe(90);
  });
});

describe("dealFromPayload", () => {
  it("takes id from the path and normalizes the body inputs", () => {
    const d = dealFromPayload("path-id", {
      name: "Edited", strategy: "hold1", usdRate: 84,
      inputs: { ...DEFAULTS, units: 6 }, createdAt: 123,
    });
    expect(d.id).toBe("path-id");
    expect(d.name).toBe("Edited");
    expect(d.strategy).toBe("hold1");
    expect(d.usdRate).toBe(84);
    expect(d.inputs.units).toBe(6);
    expect(d.createdAt).toBe(123);
    expect(typeof d.updatedAt).toBe("number");
  });

  it("falls back to safe defaults for a junk body", () => {
    const d = dealFromPayload("x", null);
    expect(d.name).toBe("Untitled deal");
    expect(d.strategy).toBe("sellAll");
    expect(d.inputs.units).toBe(DEFAULTS.units);
  });
});

describe("dealToInsertParams", () => {
  it("produces positional params with inputs JSON-stringified", () => {
    const params = dealToInsertParams(rowToDeal(row));
    expect(params[0]).toBe("abc12345");
    expect(params[3]).toBe(86);
    expect(typeof params[4]).toBe("string");
    expect(JSON.parse(params[4]).units).toBe(DEFAULTS.units);
    expect(params[5]).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 4: Run it (fails — module missing)**

Run: `npx vitest run src/lib/realestate/db-serialize.test.ts`
Expected: FAIL (cannot resolve `./db-serialize`).

- [ ] **Step 5: Implement the serializer**

Create `dashboard/src/lib/realestate/db-serialize.ts`:

```ts
// Pure mapping between Postgres rows / HTTP payloads and the client `Deal` shape.
// No `pg`, no `server-only` — safe to import in unit tests and on either side.
import { normalizeInputs, normalizeUsdRate, type Inputs } from "./defaults";
import type { Deal } from "./deals";
import type { Strategy } from "./model";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const coerceStrategy = (v: unknown): Strategy => (v === "hold1" ? "hold1" : "sellAll");

export type DealRow = {
  id: string;
  name: string;
  strategy: string;
  usd_rate: number | string;
  inputs: unknown;
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
    createdAt: typeof b.createdAt === "number" ? b.createdAt : now,
    updatedAt: now,
  };
}

export function dealToInsertParams(deal: Deal): [string, string, string, number, string, Date] {
  return [
    deal.id,
    deal.name,
    deal.strategy,
    deal.usdRate,
    JSON.stringify(deal.inputs),
    new Date(deal.createdAt || Date.now()),
  ];
}
```

- [ ] **Step 6: Run tests (pass)**

Run: `npx vitest run src/lib/realestate/db-serialize.test.ts`
Expected: PASS (all cases).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .env.local.example src/lib/realestate/db-serialize.ts src/lib/realestate/db-serialize.test.ts
git commit -m "feat(real-estate): add pg deps + pure deal serializer"
```

---

### Task 2: Server-only DB module (pool + schema + CRUD)

**Files:**
- Create: `dashboard/src/lib/realestate/db.ts`
- Create: `dashboard/src/test/server-only.ts` (empty shim for vitest)
- Modify: `dashboard/vitest.config.ts` (alias `server-only` → shim)
- Test: `dashboard/src/lib/realestate/db.test.ts` (integration; skips when DB unreachable)

**Interfaces:**
- Consumes: `rowToDeal`, `dealToInsertParams`, `DealRow` (`./db-serialize`), `Deal` (`./deals`), `blankDeal` (`./deals`, test only).
- Produces: `ensureSchema(): Promise<void>`, `listDeals(): Promise<Deal[]>`, `upsertDeal(deal: Deal): Promise<Deal>`, `deleteDeal(id: string): Promise<void>`.

- [ ] **Step 1: Add the vitest shim + alias**

Create empty file `dashboard/src/test/server-only.ts`:

```ts
// Empty shim: `server-only` throws when imported outside a Next server build.
// vitest aliases the package to this file so server modules can be imported in tests.
export {};
```

Edit `dashboard/vitest.config.ts` to add the alias:

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "src/test/server-only.ts"),
    },
  },
  test: { environment: "node" },
});
```

- [ ] **Step 2: Write the failing integration test**

Create `dashboard/src/lib/realestate/db.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { blankDeal } from "./deals";

const DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://finance:finance@127.0.0.1:5433/finance";
let available = false;

beforeAll(async () => {
  process.env.DATABASE_URL = DB_URL; // db.ts reads this lazily on first query
  const probe = new Pool({ connectionString: DB_URL, max: 1 });
  try {
    await probe.query("SELECT 1");
    available = true;
  } catch {
    available = false;
  } finally {
    await probe.end();
  }
});

afterAll(async () => {
  if (!available) return;
  const p = new Pool({ connectionString: DB_URL, max: 1 });
  await p.query("DELETE FROM real_estate_deals WHERE id = 'it_test_deal'");
  await p.end();
});

describe("db round-trip", () => {
  it("upserts, lists, and deletes a deal", async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    const { ensureSchema, upsertDeal, listDeals, deleteDeal } = await import("./db");
    await ensureSchema();

    const deal = { ...blankDeal("IT deal"), id: "it_test_deal" };
    const saved = await upsertDeal(deal);
    expect(saved.id).toBe("it_test_deal");
    expect(saved.name).toBe("IT deal");
    expect(typeof saved.updatedAt).toBe("number");

    const renamed = await upsertDeal({ ...saved, name: "IT deal v2" });
    expect(renamed.name).toBe("IT deal v2");

    const deals = await listDeals();
    expect(deals.find((d) => d.id === "it_test_deal")?.name).toBe("IT deal v2");

    await deleteDeal("it_test_deal");
    const after = await listDeals();
    expect(after.find((d) => d.id === "it_test_deal")).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it (fails — db.ts missing)**

Run: `npx vitest run src/lib/realestate/db.test.ts`
Expected: FAIL (cannot resolve `./db`). (If Postgres is down the test will instead skip once db.ts exists — that's acceptable.)

- [ ] **Step 4: Implement db.ts**

Create `dashboard/src/lib/realestate/db.ts`:

```ts
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
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_real_estate_deals_updated ON real_estate_deals (updated_at DESC);`;

let schemaReady: Promise<void> | undefined;
export function ensureSchema(): Promise<void> {
  if (!schemaReady) schemaReady = pool().query(DDL).then(() => undefined);
  return schemaReady;
}

const COLS = "id, name, strategy, usd_rate, inputs, created_at, updated_at";

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
    `INSERT INTO real_estate_deals (id, name, strategy, usd_rate, inputs, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, now())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       strategy = EXCLUDED.strategy,
       usd_rate = EXCLUDED.usd_rate,
       inputs = EXCLUDED.inputs,
       updated_at = now()
     RETURNING ${COLS}`,
    dealToInsertParams(deal),
  );
  return rowToDeal(rows[0]);
}

export async function deleteDeal(id: string): Promise<void> {
  await ensureSchema();
  await pool().query("DELETE FROM real_estate_deals WHERE id = $1", [id]);
}
```

- [ ] **Step 5: Run tests (pass or skip)**

Run: `npx vitest run src/lib/realestate/db.test.ts`
Expected: PASS if `:5433` reachable, otherwise the single test is reported **skipped**. Both are green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/realestate/db.ts src/test/server-only.ts vitest.config.ts src/lib/realestate/db.test.ts
git commit -m "feat(real-estate): server-only Neon pool + deals CRUD"
```

---

### Task 3: Local API routes (`/api/realestate/deals`)

**Files:**
- Create: `dashboard/src/app/api/realestate/deals/route.ts` (GET)
- Create: `dashboard/src/app/api/realestate/deals/[id]/route.ts` (PUT, DELETE)
- Test: `dashboard/src/app/api/realestate/route.test.ts`

**Interfaces:**
- Consumes: `listDeals`, `upsertDeal`, `deleteDeal` (`@/lib/realestate/db`), `dealFromPayload` (`@/lib/realestate/db-serialize`).
- Produces: `GET()`, `PUT(req, ctx)`, `DELETE(req, ctx)` route handlers. Success: `{ deals }` / `{ deal }` / `{ ok: true }`. Failure: `{ error, service: "realestate-db" }` with status `400`/`502`.

- [ ] **Step 1: Write the failing route test**

Create `dashboard/src/app/api/realestate/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/realestate/db", () => ({
  listDeals: vi.fn(),
  upsertDeal: vi.fn(),
  deleteDeal: vi.fn(),
}));

import { listDeals, upsertDeal, deleteDeal } from "@/lib/realestate/db";
import { GET } from "./deals/route";
import { PUT, DELETE } from "./deals/[id]/route";
import { DEFAULTS } from "@/lib/realestate/defaults";

const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
beforeEach(() => vi.clearAllMocks());

describe("GET /api/realestate/deals", () => {
  it("returns the deal list", async () => {
    vi.mocked(listDeals).mockResolvedValue([{ id: "a" } as never]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deals: [{ id: "a" }] });
  });

  it("502 with service tag when the DB is down", async () => {
    vi.mocked(listDeals).mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await GET();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ service: "realestate-db" });
  });
});

describe("PUT /api/realestate/deals/[id]", () => {
  it("upserts a deal built from the path id + body", async () => {
    vi.mocked(upsertDeal).mockImplementation(async (d) => d);
    const body = { name: "X", strategy: "hold1", usdRate: 84, inputs: DEFAULTS, createdAt: 5 };
    const res = await PUT(
      new Request("http://x/api/realestate/deals/pid", { method: "PUT", body: JSON.stringify(body) }),
      idCtx("pid"),
    );
    expect(res.status).toBe(200);
    const saved = (await res.json()).deal;
    expect(saved.id).toBe("pid");
    expect(saved.name).toBe("X");
    expect(vi.mocked(upsertDeal)).toHaveBeenCalledOnce();
  });

  it("400 on invalid JSON body", async () => {
    const res = await PUT(
      new Request("http://x/api/realestate/deals/pid", { method: "PUT", body: "not json" }),
      idCtx("pid"),
    );
    expect(res.status).toBe(400);
    expect(upsertDeal).not.toHaveBeenCalled();
  });

  it("502 when the write fails", async () => {
    vi.mocked(upsertDeal).mockRejectedValue(new Error("write failed"));
    const res = await PUT(
      new Request("http://x/api/realestate/deals/pid", { method: "PUT", body: JSON.stringify({ inputs: DEFAULTS }) }),
      idCtx("pid"),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ service: "realestate-db" });
  });
});

describe("DELETE /api/realestate/deals/[id]", () => {
  it("deletes and returns ok", async () => {
    vi.mocked(deleteDeal).mockResolvedValue();
    const res = await DELETE(new Request("http://x", { method: "DELETE" }), idCtx("gone"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deleteDeal).toHaveBeenCalledWith("gone");
  });
});
```

- [ ] **Step 2: Run it (fails — routes missing)**

Run: `npx vitest run src/app/api/realestate/route.test.ts`
Expected: FAIL (cannot resolve `./deals/route`).

- [ ] **Step 3: Implement the GET route**

Create `dashboard/src/app/api/realestate/deals/route.ts`:

```ts
import { listDeals } from "@/lib/realestate/db";

export async function GET() {
  try {
    return Response.json({ deals: await listDeals() });
  } catch (e) {
    return Response.json(
      { error: `deals DB unreachable: ${e instanceof Error ? e.message : e}`, service: "realestate-db" },
      { status: 502 },
    );
  }
}
```

- [ ] **Step 4: Implement the PUT/DELETE route**

Create `dashboard/src/app/api/realestate/deals/[id]/route.ts`:

```ts
import { upsertDeal, deleteDeal } from "@/lib/realestate/db";
import { dealFromPayload } from "@/lib/realestate/db-serialize";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  try {
    const deal = await upsertDeal(dealFromPayload(id, body));
    return Response.json({ deal });
  } catch (e) {
    return Response.json(
      { error: `deals DB write failed: ${e instanceof Error ? e.message : e}`, service: "realestate-db" },
      { status: 502 },
    );
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    await deleteDeal(id);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json(
      { error: `deals DB delete failed: ${e instanceof Error ? e.message : e}`, service: "realestate-db" },
      { status: 502 },
    );
  }
}
```

- [ ] **Step 5: Run tests (pass)**

Run: `npx vitest run src/app/api/realestate/route.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/realestate
git commit -m "feat(real-estate): local /api/realestate/deals GET/PUT/DELETE routes"
```

---

### Task 4: Client fetch helpers (`deals-api.ts`)

**Files:**
- Create: `dashboard/src/lib/realestate/deals-api.ts`
- Test: `dashboard/src/lib/realestate/deals-api.test.ts`

**Interfaces:**
- Consumes: `Deal` (`./deals`); global `fetch`.
- Produces: `fetchDeals(): Promise<Deal[]>`, `putDeal(deal: Deal): Promise<Deal>`, `deleteDealReq(id: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/lib/realestate/deals-api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDeals, putDeal, deleteDealReq } from "./deals-api";
import { blankDeal } from "./deals";

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("deals-api", () => {
  it("fetchDeals unwraps the deals array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ deals: [{ id: "a" }] })));
    expect(await fetchDeals()).toEqual([{ id: "a" }]);
  });

  it("putDeal PUTs to the id route and returns the saved deal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ deal: { id: "z" } }));
    vi.stubGlobal("fetch", fetchMock);
    const deal = { ...blankDeal("n"), id: "z" };
    const saved = await putDeal(deal);
    expect(saved).toEqual({ id: "z" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/realestate/deals/z");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PUT" });
  });

  it("throws the server error message on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "boom" }), { status: 502 })),
    );
    await expect(fetchDeals()).rejects.toThrow("boom");
  });

  it("deleteDealReq DELETEs the id route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await deleteDealReq("gone");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/realestate/deals/gone");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "DELETE" });
  });
});
```

- [ ] **Step 2: Run it (fails — module missing)**

Run: `npx vitest run src/lib/realestate/deals-api.test.ts`
Expected: FAIL (cannot resolve `./deals-api`).

- [ ] **Step 3: Implement deals-api.ts**

Create `dashboard/src/lib/realestate/deals-api.ts`:

```ts
// Client → local Next route handlers for deal persistence. Same fetch/unwrap
// shape as src/lib/api.ts (which keeps `unwrap` private, so it's repeated here).
import type { Deal } from "./deals";

async function unwrap<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export async function fetchDeals(): Promise<Deal[]> {
  const { deals } = await unwrap<{ deals: Deal[] }>(await fetch("/api/realestate/deals"));
  return deals;
}

export async function putDeal(deal: Deal): Promise<Deal> {
  const { deal: saved } = await unwrap<{ deal: Deal }>(
    await fetch(`/api/realestate/deals/${deal.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(deal),
    }),
  );
  return saved;
}

export async function deleteDealReq(id: string): Promise<void> {
  await unwrap(await fetch(`/api/realestate/deals/${id}`, { method: "DELETE" }));
}
```

- [ ] **Step 4: Run tests (pass)**

Run: `npx vitest run src/lib/realestate/deals-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/realestate/deals-api.ts src/lib/realestate/deals-api.test.ts
git commit -m "feat(real-estate): client deal-persistence fetch helpers"
```

---

### Task 5: One-time migration helpers (`migration.ts`)

**Files:**
- Create: `dashboard/src/lib/realestate/migration.ts`
- Test: `dashboard/src/lib/realestate/migration.test.ts`

**Interfaces:**
- Consumes: `Deal` (`./deals`), `migrateInputs` (`./deals`), `normalizeUsdRate` (`./defaults`), `Strategy` (`./model`).
- Produces:
  - `LEGACY_STORAGE_KEY = "vault:realestate:deals:v1"`, `MIGRATED_MARKER_KEY = "vault:realestate:migrated:v1"`
  - `parseLegacyStore(raw: string | null): Deal[]`
  - `needsMigration(serverDeals: Deal[], legacy: Deal[], alreadyMigrated: boolean): boolean`
  - `runMigration(fetchFn: () => Promise<Deal[]>, putFn: (d: Deal) => Promise<Deal>): Promise<Deal[]>`

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/lib/realestate/migration.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseLegacyStore, needsMigration } from "./migration";
import { DEFAULTS } from "./defaults";

describe("parseLegacyStore", () => {
  it("returns [] for null / empty / malformed input", () => {
    expect(parseLegacyStore(null)).toEqual([]);
    expect(parseLegacyStore("")).toEqual([]);
    expect(parseLegacyStore("{not json")).toEqual([]);
    expect(parseLegacyStore(JSON.stringify({ deals: [] }))).toEqual([]);
  });

  it("parses a v1 store and normalizes each deal's inputs", () => {
    const raw = JSON.stringify({
      currentId: "d1",
      deals: [
        { id: "d1", name: "A", strategy: "sellAll", usdRate: 86, inputs: DEFAULTS, createdAt: 1, updatedAt: 2 },
      ],
    });
    const deals = parseLegacyStore(raw);
    expect(deals).toHaveLength(1);
    expect(deals[0].id).toBe("d1");
    expect(deals[0].inputs.units).toBe(DEFAULTS.units);
    expect(deals[0].createdAt).toBe(1);
  });

  it("upgrades a legacy manoj1/manoj2 deal into an investors array", () => {
    const legacyInputs = { ...DEFAULTS, manoj1: 8_500_000, manoj2: 7_000_000 };
    delete (legacyInputs as { investors?: unknown }).investors;
    const raw = JSON.stringify({
      currentId: "d1",
      deals: [{ id: "d1", name: "Legacy", strategy: "sellAll", usdRate: 86, inputs: legacyInputs, createdAt: 1, updatedAt: 2 }],
    });
    const deals = parseLegacyStore(raw);
    expect(deals[0].inputs.investors[0].id).toBe("manoj");
    expect(deals[0].inputs.investors[0].tranches[0].amount).toBe(8_500_000);
  });
});

describe("needsMigration", () => {
  const d = { id: "x" } as never;
  it("true only when server empty + has legacy + not yet migrated", () => {
    expect(needsMigration([], [d], false)).toBe(true);
  });
  it("false when the server already has deals", () => {
    expect(needsMigration([d], [d], false)).toBe(false);
  });
  it("false when already migrated", () => {
    expect(needsMigration([], [d], true)).toBe(false);
  });
  it("false when there is nothing to migrate", () => {
    expect(needsMigration([], [], false)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it (fails — module missing)**

Run: `npx vitest run src/lib/realestate/migration.test.ts`
Expected: FAIL (cannot resolve `./migration`).

- [ ] **Step 3: Implement migration.ts**

Create `dashboard/src/lib/realestate/migration.ts`:

```ts
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
  for (const deal of legacy) await putFn(deal);
  window.localStorage.setItem(MIGRATED_MARKER_KEY, "1");
  return legacy;
}
```

- [ ] **Step 4: Run tests (pass)**

Run: `npx vitest run src/lib/realestate/migration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/realestate/migration.ts src/lib/realestate/migration.test.ts
git commit -m "feat(real-estate): one-time localStorage→Neon migration helpers"
```

---

### Task 6: Persistence hook (`use-deals-store.ts`) + save policy

> **USER-CONTRIBUTION POINT:** `persistMode` (and the failure surface) is the one genuinely judgment-driven piece. The plan ships a working default; during execution, pause and offer the user the chance to author it.

**Files:**
- Create: `dashboard/src/lib/realestate/use-deals-store.ts`
- Test: `dashboard/src/lib/realestate/use-deals-store.test.ts` (tests the pure `persistMode`)

**Interfaces:**
- Consumes: store ops + types (`./deals`), `Inputs` (`./defaults`), `Strategy` (`./model`), `fetchDeals`/`putDeal`/`deleteDealReq` (`./deals-api`), `runMigration` (`./migration`).
- Produces:
  - `type SaveStatus = "idle" | "saving" | "saved" | "error"`
  - `type PersistAction = "edit" | "create" | "duplicate" | "delete" | "reset" | "select"`
  - `type PersistMode = "debounce" | "immediate" | "none"`
  - `persistMode(action: PersistAction): PersistMode`
  - `useDealsStore(): { store, current, hydrated, status, actions }` where
    `actions = { updateInputs(patch: Partial<Inputs>), setStrategy(s: Strategy), setUsdRate(r: number), rename(name: string), create(name?: string), duplicate(), remove(), select(id: string), reset(), retry() }`

- [ ] **Step 1: Write the failing test for the save policy**

Create `dashboard/src/lib/realestate/use-deals-store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { persistMode } from "./use-deals-store";

describe("persistMode", () => {
  it("debounces live field edits", () => {
    expect(persistMode("edit")).toBe("debounce");
  });
  it("persists structural actions immediately", () => {
    expect(persistMode("create")).toBe("immediate");
    expect(persistMode("duplicate")).toBe("immediate");
    expect(persistMode("delete")).toBe("immediate");
    expect(persistMode("reset")).toBe("immediate");
  });
  it("does not hit the DB just to switch the selected deal", () => {
    expect(persistMode("select")).toBe("none");
  });
});
```

- [ ] **Step 2: Run it (fails — module missing)**

Run: `npx vitest run src/lib/realestate/use-deals-store.test.ts`
Expected: FAIL (cannot resolve `./use-deals-store`).

- [ ] **Step 3: Implement the hook (default `persistMode` shown — offer the user the edit here)**

Create `dashboard/src/lib/realestate/use-deals-store.ts`:

```ts
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
  blankDeal,
} from "./deals";
import type { Inputs } from "./defaults";
import type { Strategy } from "./model";
import { fetchDeals, putDeal, deleteDealReq } from "./deals-api";
import { runMigration } from "./migration";

export type SaveStatus = "idle" | "saving" | "saved" | "error";
export type PersistAction = "edit" | "create" | "duplicate" | "delete" | "reset" | "select";
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
  const failed = useRef<Deal | null>(null);

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
      failed.current = null;
      setStatus("saved");
    } catch {
      failed.current = deal;
      setStatus("error");
    }
  }, []);

  const schedule = useCallback(
    (action: PersistAction, deal: Deal) => {
      const mode = persistMode(action);
      if (mode === "none") return;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (mode === "immediate") {
        void persist(deal);
        return;
      }
      setStatus("saving");
      timer.current = setTimeout(() => void persist(deal), DEBOUNCE_MS);
    },
    [persist],
  );

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
    remove: () => {
      const removedId = storeRef.current.currentId;
      const wasLast = storeRef.current.deals.length <= 1;
      const next = apply("delete", (s) => deleteCurrent(s));
      void (async () => {
        setStatus("saving");
        try {
          await deleteDealReq(removedId);
          if (wasLast) await putDeal(getCurrent(next)); // deleteCurrent reseeds a fresh default
          setStatus("saved");
        } catch {
          setStatus("error");
        }
      })();
    },
    retry: () => {
      if (failed.current) void persist(failed.current);
    },
  };

  return { store, current: getCurrent(store), hydrated, status, actions };
}
```

- [ ] **Step 4: Run tests (pass)**

Run: `npx vitest run src/lib/realestate/use-deals-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/realestate/use-deals-store.ts src/lib/realestate/use-deals-store.test.ts
git commit -m "feat(real-estate): deals persistence hook with debounced save policy"
```

---

### Task 7: Wire `page.tsx` to the hook (+ save status, copy)

**Files:**
- Modify: `dashboard/src/app/real-estate/page.tsx`

**Interfaces:**
- Consumes: `useDealsStore` (`@/lib/realestate/use-deals-store`).
- Produces: no new exports (page component only).

- [ ] **Step 1: Replace imports + state + effects**

In `dashboard/src/app/real-estate/page.tsx`, replace the deals-store import block (the `import { createDeal, deleteCurrent, ... Store, updateCurrent } from "@/lib/realestate/deals"`) with the pure-type imports plus the hook:

```tsx
import { getCurrent } from "@/lib/realestate/deals";
import { useDealsStore } from "@/lib/realestate/use-deals-store";
```

Remove the now-unused `useState`/`useEffect` for the store and the local handlers. Replace the top of the component body (the `const [store, setStore] = useState…` through the `onUsdRate` handlers) with:

```tsx
  const { store, current, hydrated, status, actions } = useDealsStore();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const { inputs, strategy, usdRate } = current;
  const inputIssues = validateInputs(inputs);
  const result = inputIssues.length ? null : compute(inputs, strategy);
  const fixedRevenue = prebuyRevenue(inputs);
  const hasPrebuy = marketUnits(inputs) < inputs.units;

  const onInputChange = (patch: Partial<Inputs>) => actions.updateInputs(patch);
  const onStrategy = (next: Strategy) => actions.setStrategy(next);
  const onUsdRate = (r: number) => actions.setUsdRate(r);
```

(Keep `import { useState } from "react";` for `drawerOpen`. Remove `useEffect` from the React import if no longer used.)

- [ ] **Step 2: Point the switcher + reset at `actions`**

Replace the `DealSwitcher` props and the two reset buttons:

```tsx
          <DealSwitcher
            deals={store.deals}
            currentId={store.currentId}
            onSelect={(id) => actions.select(id)}
            onCreate={() => actions.create("New deal")}
            onRename={(name) => actions.rename(name)}
            onDuplicate={() => actions.duplicate()}
            onDelete={() => actions.remove()}
          />
```

Both `onClick={() => setStore((s) => resetCurrent(s))}` become `onClick={() => actions.reset()}`.

- [ ] **Step 3: Add a save-status indicator in the top bar**

Insert before the `₹/$` label in the right-hand control cluster:

```tsx
          <SaveStatus status={status} hydrated={hydrated} onRetry={() => actions.retry()} />
```

And add this small component below the page component (same file):

```tsx
function SaveStatus({
  status,
  hydrated,
  onRetry,
}: {
  status: "idle" | "saving" | "saved" | "error";
  hydrated: boolean;
  onRetry: () => void;
}) {
  if (!hydrated) return <span className="text-[11px] text-faint">Loading…</span>;
  if (status === "saving") return <span className="text-[11px] text-faint">Saving…</span>;
  if (status === "saved") return <span className="text-[11px] text-mut">Saved</span>;
  if (status === "error")
    return (
      <button onClick={onRetry} className="text-[11px] font-medium text-amber underline">
        Save failed — Retry
      </button>
    );
  return null;
}
```

- [ ] **Step 4: Update the footer copy**

Change the footer note from "Deal assumptions are stored per-browser (localStorage) — …" to:

```tsx
            Deal assumptions are saved to your database — switch deals from the title bar, edit
            them in the assumptions drawer.{" "}
```

- [ ] **Step 5: Typecheck**

Run: `npm run build`
Expected: compiles with no type errors. (If `useEffect`/`resetCurrent`/`Store` remain imported but unused, remove them.)

- [ ] **Step 6: Commit**

```bash
git add src/app/real-estate/page.tsx
git commit -m "feat(real-estate): page reads/writes deals via Neon-backed hook + save status"
```

---

### Task 8: Remove the localStorage layer from `deals.ts`

**Files:**
- Modify: `dashboard/src/lib/realestate/deals.ts`

- [ ] **Step 1: Confirm nothing imports the doomed functions**

Run: `grep -rn "loadStore\|saveStore" src/`
Expected: no matches (page.tsx no longer uses them after Task 7).

- [ ] **Step 2: Delete the localStorage layer**

In `dashboard/src/lib/realestate/deals.ts`, remove: the `KEY` constant, `loadStore()`, `saveStore()`, and the private `seed()` function. Keep everything else (`Deal`/`Store` types, `INITIAL_STORE`, `newId`, `blankDeal`, `migrateInputs`, and all pure ops).

Update the file header comment (lines 1–4) to:

```ts
// Per-deal model + pure store operations for the real-estate view. A "deal" is
// one named saved scenario — its inputs, strategy, and USD rate. Persistence
// lives in Neon (see ./db, ./deals-api, ./use-deals-store); this module is pure
// data + transforms with no I/O, so it stays trivially testable.
```

- [ ] **Step 3: Typecheck + full test run**

Run: `npm run build && npm test`
Expected: build clean; vitest green (engine/financing/timeline unchanged; new suites pass; db integration passes or skips).

- [ ] **Step 4: Commit**

```bash
git add src/lib/realestate/deals.ts
git commit -m "refactor(real-estate): drop localStorage layer now that deals live in Neon"
```

---

### Task 9: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Build + test**

Run: `npm run build && npm test`
Expected: both green.

- [ ] **Step 2: Manual smoke (requires MCP server :8000, link helper :8765, and `DATABASE_URL` set in `.env.local`)**

Run: `npm run dev`, open `http://localhost:3000/real-estate`, and verify:
- First load **auto-migrates** the existing SMV/localStorage deal(s) into Neon (check the DB has rows; status shows "Saved").
- Editing an assumption recomputes instantly; "Saving…" → "Saved"; the change **survives a refresh**.
- Create / duplicate / delete / switch all persist across refresh; deleting the last deal reseeds a default.
- Invalid inputs still block metrics (the correction card shows).
- Dark + light + mobile widths unaffected.
- Stop the MCP/DB briefly → a save shows "Save failed — Retry"; Retry recovers once the DB is back.

- [ ] **Step 3: Confirm the MCP surface is untouched**

Run (from repo root): `.venv/bin/python -m pytest tests/test_dashboard_contract.py -q`
Expected: PASS (no allowlist drift — we added no MCP tools).

---

## Self-Review

**Spec coverage:**
- Local-only write path (Decision 1) → Tasks 2–4 (DB module, routes, client helpers); no MCP tool added (Task 9 Step 3 guards it). ✓
- Auto-migrate once (Decision 2) → Task 5 + hook load effect (Task 6). ✓
- Approach A thin mirror (Decision 3) → `deals.ts` pure ops kept; only I/O swapped (Tasks 6–8). ✓
- JSONB schema + server-authoritative `updated_at` + preserved `created_at` → Task 2 (`db.ts`), Task 1 (`dealToInsertParams` passes `created_at`, SQL keeps it on conflict). ✓
- Debounced vs immediate save semantics → Task 6 (`persistMode` + `schedule`). ✓
- Save-status UI + copy change → Task 7. ✓
- `pg` over Neon HTTP driver for test-DB parity; integration skips when down → Task 2. ✓
- Tests: serialization, migration, route, deals-api, persistMode, integration → Tasks 1–6. ✓
- Non-goals (no engine/UI/MCP change) → enforced by Global Constraints + Task 9 Step 3. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code. ✓

**Type consistency:** `Deal`/`Store`/`Inputs`/`Strategy` reused from existing modules; `DealRow`, `persistMode`, `SaveStatus`, `PersistAction`, and the `actions` method names are consistent across Tasks 1–7 (`updateInputs`/`setStrategy`/`setUsdRate`/`rename`/`create`/`duplicate`/`remove`/`select`/`reset`/`retry`). ✓
