# Dashboard Foundation (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the local Next.js dashboard, build the MCP + link_helper BFF layer and shared UI kit, and port the existing `link_helper` dashboard (Overview + Connections pages).

**Architecture:** Next.js 15 App Router app in `dashboard/`. API routes act as a BFF: `/api/mcp/[tool]` calls the local MCP server (`localhost:8000/mcp`) through a cached `@modelcontextprotocol/sdk` client with a tool allowlist; `/api/link/[...path]` proxies five allowlisted endpoints to `link_helper` (`localhost:8765`). Pages are client components using SWR hooks. No Python file is modified.

**Tech Stack:** Next.js 15 (TypeScript, App Router, Tailwind v4), `@modelcontextprotocol/sdk`, SWR, Recharts (installed now, used in Plan B), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-11-nextjs-dashboard-design.md`

---

### Task 1: Scaffold the app

**Files:**
- Create: `dashboard/` (via create-next-app), `dashboard/.env.local.example`
- Modify: `dashboard/src/app/globals.css`, `dashboard/package.json`, `.gitignore` (repo root)

- [ ] **Step 1: Scaffold and install deps**

```bash
cd /Users/hrishikeshkakkad/Documents/agentic-poc
npx --yes create-next-app@latest dashboard --ts --tailwind --app --eslint --src-dir --use-npm --turbopack --import-alias "@/*" --yes
cd dashboard
npm i @modelcontextprotocol/sdk swr recharts
npm i -D vitest
```

Expected: `dashboard/` exists with `src/app/`, install succeeds.

- [ ] **Step 2: Theme.** Replace `dashboard/src/app/globals.css` with:

```css
@import "tailwindcss";

@theme {
  --color-bg: #0f1115;
  --color-card: #181b21;
  --color-line: #262b33;
  --color-txt: #e6e9ef;
  --color-mut: #9aa3b2;
  --color-green: #2ecc71;
  --color-red: #ff5b5b;
  --color-amber: #f5a623;
  --color-accent: #4c8bf5;
}

body {
  background: var(--color-bg);
  color: var(--color-txt);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
```

- [ ] **Step 3: Env example + scripts.** Create `dashboard/.env.local.example`:

```bash
# Optional overrides; defaults shown.
MCP_URL=http://localhost:8000/mcp
LINK_HELPER_URL=http://localhost:8765
```

Add to `dashboard/package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 4: Verify build**

Run: `cd dashboard && npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add -A dashboard .gitignore
git commit -m "feat(dashboard): scaffold Next.js app with dark theme"
```

### Task 2: Formatting lib (TDD)

**Files:**
- Create: `dashboard/src/lib/format.ts`, `dashboard/vitest.config.ts`
- Test: `dashboard/src/lib/format.test.ts`

- [ ] **Step 1: vitest config.** Create `dashboard/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: { environment: "node" },
});
```

- [ ] **Step 2: Failing tests.** Create `dashboard/src/lib/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { usd, signedUsd, fmtDate, fmtDateTime, pct } from "./format";

describe("usd", () => {
  it("formats dollars", () => expect(usd(1234.5)).toBe("$1,234.50"));
  it("handles null", () => expect(usd(null)).toBe("—"));
  it("handles negatives", () => expect(usd(-20)).toBe("-$20.00"));
});

describe("signedUsd (Plaid sign: positive = outflow)", () => {
  // Display convention: spending shown as plain amount, inflows with a +.
  it("outflow", () => expect(signedUsd(42)).toEqual({ text: "$42.00", inflow: false }));
  it("inflow", () => expect(signedUsd(-42)).toEqual({ text: "+$42.00", inflow: true }));
});

describe("fmtDate", () => {
  it("formats ISO date", () => expect(fmtDate("2026-06-11")).toMatch(/2026/));
  it("handles null", () => expect(fmtDate(null)).toBe("—"));
  it("passes through junk", () => expect(fmtDate("not-a-date")).toBe("not-a-date"));
});

describe("fmtDateTime", () => {
  it("handles null", () => expect(fmtDateTime(null)).toBe("—"));
});

describe("pct", () => {
  it("formats", () => expect(pct(12.345)).toBe("12.3%"));
  it("handles null", () => expect(pct(null)).toBe("—"));
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd dashboard && npx vitest run src/lib/format.test.ts`
Expected: FAIL — cannot resolve `./format`.

- [ ] **Step 4: Implement.** Create `dashboard/src/lib/format.ts`:

```ts
const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function usd(n: number | null | undefined): string {
  return n == null ? "—" : usdFmt.format(n);
}

/** Plaid sign convention: amount > 0 is an outflow (spend), < 0 an inflow. */
export function signedUsd(amount: number): { text: string; inflow: boolean } {
  const inflow = amount < 0;
  return { text: inflow ? `+${usdFmt.format(-amount)}` : usdFmt.format(amount), inflow };
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s.length === 10 ? `${s}T00:00:00` : s);
  return isNaN(d.getTime())
    ? s
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function fmtDateTime(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}

export function pct(n: number | null | undefined): string {
  return n == null ? "—" : `${n.toFixed(1)}%`;
}
```

- [ ] **Step 5: Run tests**

Run: `cd dashboard && npx vitest run src/lib/format.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/lib/format.ts dashboard/src/lib/format.test.ts dashboard/vitest.config.ts
git commit -m "feat(dashboard): money/date formatters with Plaid sign convention"
```

### Task 3: MCP client + tool allowlist (TDD on allowlist + result parsing)

**Files:**
- Create: `dashboard/src/lib/mcp.ts`, `dashboard/src/lib/tools.ts`
- Test: `dashboard/src/lib/tools.test.ts`

- [ ] **Step 1: Failing test.** Create `dashboard/src/lib/tools.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ALLOWED_TOOLS, parseToolResult } from "./tools";

describe("ALLOWED_TOOLS", () => {
  it("contains the read tools and allowed writes", () => {
    for (const t of ["get_net_worth", "list_transactions", "query_finances",
                     "sync_now", "set_category_override"]) {
      expect(ALLOWED_TOOLS.has(t)).toBe(true);
    }
  });
  it("never exposes unknown names", () => {
    expect(ALLOWED_TOOLS.has("drop_tables")).toBe(false);
  });
});

describe("parseToolResult", () => {
  it("prefers structuredContent", () => {
    expect(parseToolResult({ structuredContent: { a: 1 }, content: [] })).toEqual({ a: 1 });
  });
  it("falls back to text JSON", () => {
    expect(parseToolResult({ content: [{ type: "text", text: '{"b":2}' }] })).toEqual({ b: 2 });
  });
  it("throws on empty result", () => {
    expect(() => parseToolResult({ content: [] })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd dashboard && npx vitest run src/lib/tools.test.ts`
Expected: FAIL — cannot resolve `./tools`.

- [ ] **Step 3: Implement.** Create `dashboard/src/lib/tools.ts` (no SDK imports — testable in isolation):

```ts
/** Tools the BFF may call on the personal-finance MCP server (server.py).
 * Read tools plus the three sanctioned writes (sync, category overrides). */
export const ALLOWED_TOOLS = new Set([
  "list_accounts", "get_balances", "get_transactions", "get_recurring_transactions",
  "get_liabilities", "get_investment_holdings", "get_investment_transactions",
  "get_institutions_status", "search_transactions", "get_net_worth",
  "get_net_worth_history", "aggregate_spending", "query_finances", "describe_tables",
  "list_transactions", "get_sync_status", "get_optimizer_score", "get_debt_analysis",
  "get_portfolio_analysis", "get_income_analysis", "get_net_worth_trajectory",
  "get_recurring_analysis", "get_merchant_profile", "compare_periods",
  "get_financial_health", "list_category_overrides",
  "sync_now", "set_category_override",
]);

type RawResult = {
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
};

/** FastMCP returns structuredContent for dict results; older paths return text JSON. */
export function parseToolResult(result: RawResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (text === undefined) throw new Error("empty tool result");
  return JSON.parse(text);
}
```

- [ ] **Step 4: Run tests**

Run: `cd dashboard && npx vitest run src/lib/tools.test.ts`
Expected: PASS.

- [ ] **Step 5: MCP client singleton.** Create `dashboard/src/lib/mcp.ts`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseToolResult } from "./tools";

const MCP_URL = process.env.MCP_URL ?? "http://localhost:8000/mcp";

// Survives route-module reloads in dev; one MCP session per server process.
type G = typeof globalThis & { __mcpClient?: Promise<Client> };

async function connect(): Promise<Client> {
  const client = new Client({ name: "finance-dashboard", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
  return client;
}

function getClient(): Promise<Client> {
  const g = globalThis as G;
  if (!g.__mcpClient) g.__mcpClient = connect();
  return g.__mcpClient;
}

function resetClient(): void {
  (globalThis as G).__mcpClient = undefined;
}

export async function callMcpTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  let client: Client;
  try {
    client = await getClient();
  } catch (e) {
    resetClient();
    throw e;
  }
  try {
    return parseToolResult(await client.callTool({ name, arguments: args }));
  } catch {
    // Stale session (MCP server restarted): reconnect once, then surface.
    resetClient();
    client = await getClient();
    return parseToolResult(await client.callTool({ name, arguments: args }));
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/lib/tools.ts dashboard/src/lib/tools.test.ts dashboard/src/lib/mcp.ts
git commit -m "feat(dashboard): MCP client singleton with tool allowlist"
```

### Task 4: `/api/mcp/[tool]` route (TDD)

**Files:**
- Create: `dashboard/src/app/api/mcp/[tool]/route.ts`
- Test: `dashboard/src/app/api/mcp/route.test.ts`

- [ ] **Step 1: Failing test.** Create `dashboard/src/app/api/mcp/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp", () => ({ callMcpTool: vi.fn() }));

import { callMcpTool } from "@/lib/mcp";
import { POST } from "./[tool]/route";

const post = (tool: string, body?: unknown) =>
  POST(
    new Request("http://x/api/mcp/" + tool, {
      method: "POST",
      body: body === undefined ? null : JSON.stringify(body),
    }),
    { params: Promise.resolve({ tool }) },
  );

beforeEach(() => vi.clearAllMocks());

describe("POST /api/mcp/[tool]", () => {
  it("rejects unknown tools", async () => {
    const res = await post("drop_tables", {});
    expect(res.status).toBe(404);
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it("dispatches allowlisted tool with args", async () => {
    vi.mocked(callMcpTool).mockResolvedValue({ net_worth: 1 });
    const res = await post("get_net_worth", { args: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ net_worth: 1 });
    expect(callMcpTool).toHaveBeenCalledWith("get_net_worth", {});
  });

  it("treats empty body as no args", async () => {
    vi.mocked(callMcpTool).mockResolvedValue({ ok: true });
    const res = await post("get_sync_status");
    expect(res.status).toBe(200);
  });

  it("returns 502 with service tag when MCP is down", async () => {
    vi.mocked(callMcpTool).mockRejectedValue(new Error("fetch failed"));
    const res = await post("get_net_worth", {});
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ service: "mcp" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd dashboard && npx vitest run src/app/api/mcp/route.test.ts`
Expected: FAIL — cannot resolve `./[tool]/route`.

- [ ] **Step 3: Implement.** Create `dashboard/src/app/api/mcp/[tool]/route.ts` (plain `Request`/`Response` — keeps it unit-testable without Next server shims):

```ts
import { callMcpTool } from "@/lib/mcp";
import { ALLOWED_TOOLS } from "@/lib/tools";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tool: string }> },
) {
  const { tool } = await params;
  if (!ALLOWED_TOOLS.has(tool)) {
    return Response.json({ error: `unknown tool: ${tool}` }, { status: 404 });
  }
  let args: Record<string, unknown> = {};
  try {
    const body = await req.json();
    if (body && typeof body.args === "object" && body.args !== null) args = body.args;
  } catch {
    // empty body → no args
  }
  try {
    return Response.json(await callMcpTool(tool, args));
  } catch (e) {
    return Response.json(
      {
        error: `MCP server unreachable or call failed: ${e instanceof Error ? e.message : e}`,
        service: "mcp",
      },
      { status: 502 },
    );
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd dashboard && npx vitest run src/app/api/mcp/route.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app/api/mcp
git commit -m "feat(dashboard): /api/mcp/[tool] BFF route with allowlist"
```

### Task 5: `/api/link/[...path]` proxy (TDD)

**Files:**
- Create: `dashboard/src/app/api/link/[...path]/route.ts`
- Test: `dashboard/src/app/api/link/route.test.ts`

- [ ] **Step 1: Failing test.** Create `dashboard/src/app/api/link/route.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./[...path]/route";

const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) });

afterEach(() => vi.unstubAllGlobals());

describe("/api/link proxy", () => {
  it("rejects unknown paths", async () => {
    const res = await GET(new Request("http://x/api/link/nope"), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("maps status → upstream /api/status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"institutions":[]}', { headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(new Request("http://x/api/link/status"), ctx("status"));
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:8765/api/status");
  });

  it("rejects GET on POST-only endpoints", async () => {
    const res = await GET(new Request("http://x/api/link/sync"), ctx("sync"));
    expect(res.status).toBe(405);
  });

  it("forwards POST body and returns 502 when link_helper is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const res = await POST(
      new Request("http://x/api/link/sync", { method: "POST" }),
      ctx("sync"),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ service: "link_helper" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd dashboard && npx vitest run src/app/api/link/route.test.ts`
Expected: FAIL — cannot resolve `./[...path]/route`.

- [ ] **Step 3: Implement.** Create `dashboard/src/app/api/link/[...path]/route.ts`:

```ts
const LINK_HELPER_URL = process.env.LINK_HELPER_URL ?? "http://localhost:8765";

// dashboard path → { upstream path, allowed method }
const ROUTES: Record<string, { upstream: string; method: "GET" | "POST" }> = {
  status: { upstream: "api/status", method: "GET" },
  "create-link-token": { upstream: "create-link-token", method: "POST" },
  exchange: { upstream: "exchange", method: "POST" },
  sync: { upstream: "sync", method: "POST" },
  "import-apple-card": { upstream: "import-apple-card", method: "POST" },
};

type Ctx = { params: Promise<{ path: string[] }> };

async function proxy(req: Request, ctx: Ctx, method: "GET" | "POST") {
  const { path } = await ctx.params;
  const route = ROUTES[path.join("/")];
  if (!route) return Response.json({ error: "unknown link_helper path" }, { status: 404 });
  if (route.method !== method) {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  try {
    const upstream = await fetch(`${LINK_HELPER_URL}/${route.upstream}`, {
      method,
      headers: method === "POST"
        ? { "content-type": req.headers.get("content-type") ?? "application/json" }
        : undefined,
      body: method === "POST" ? await req.arrayBuffer() : undefined,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch (e) {
    return Response.json(
      {
        error: `link_helper unreachable (is uvicorn running on :8765?): ${e instanceof Error ? e.message : e}`,
        service: "link_helper",
      },
      { status: 502 },
    );
  }
}

export const GET = (req: Request, ctx: Ctx) => proxy(req, ctx, "GET");
export const POST = (req: Request, ctx: Ctx) => proxy(req, ctx, "POST");
```

- [ ] **Step 4: Run tests**

Run: `cd dashboard && npx vitest run src/app/api/link/route.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run full dashboard test suite + build**

Run: `cd dashboard && npm test && npm run build`
Expected: all tests pass; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/app/api/link
git commit -m "feat(dashboard): link_helper proxy route"
```

### Task 6: Client data layer + shared UI kit

**Files:**
- Create: `dashboard/src/lib/api.ts`, `dashboard/src/lib/hooks.ts`, `dashboard/src/components/ui.tsx`
- Modify: `dashboard/src/app/layout.tsx`

- [ ] **Step 1: Client fetchers.** Create `dashboard/src/lib/api.ts`:

```ts
export class ApiError extends Error {
  constructor(message: string, public service?: string, public status?: number) {
    super(message);
  }
}

async function unwrap<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, data.service, res.status);
  return data as T;
}

export async function callTool<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  return unwrap<T>(
    await fetch(`/api/mcp/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args }),
    }),
  );
}

export async function linkFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return unwrap<T>(await fetch(`/api/link/${path}`, init));
}
```

- [ ] **Step 2: SWR hooks.** Create `dashboard/src/lib/hooks.ts`:

```ts
"use client";

import useSWR from "swr";
import { callTool, linkFetch } from "./api";

/** SWR over an MCP tool call; key includes args so filter changes refetch. */
export function useTool<T>(tool: string, args: Record<string, unknown> = {}) {
  return useSWR<T>([`tool:${tool}`, JSON.stringify(args)], () => callTool<T>(tool, args), {
    revalidateOnFocus: false,
  });
}

export function useLinkStatus<T>() {
  return useSWR<T>("link:status", () => linkFetch<T>("status"), {
    revalidateOnFocus: false,
  });
}
```

- [ ] **Step 3: UI kit.** Create `dashboard/src/components/ui.tsx`:

```tsx
"use client";

import { ApiError } from "@/lib/api";
import { signedUsd, usd } from "@/lib/format";

export function Card({ title, right, children, className = "" }: {
  title?: React.ReactNode; right?: React.ReactNode;
  children: React.ReactNode; className?: string;
}) {
  return (
    <div className={`rounded-xl border border-line bg-card p-5 ${className}`}>
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between gap-4">
          <div className="font-semibold">{title}</div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function Stat({ label, value, sub }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-mut">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
      {sub && <div className="text-sm text-mut">{sub}</div>}
    </div>
  );
}

const STATUS_STYLES: Record<string, [string, string]> = {
  healthy: ["Connected", "bg-green/15 text-green"],
  re_auth_required: ["Re-auth needed", "bg-red/15 text-red"],
  pending_expiration: ["Expiring soon", "bg-amber/15 text-amber"],
  item_locked: ["Locked", "bg-amber/15 text-amber"],
  no_accounts: ["No accounts", "bg-mut/15 text-mut"],
  unknown_error: ["Error", "bg-red/15 text-red"],
  csv_import: ["CSV import", "bg-mut/15 text-mut"],
};

export function StatusBadge({ status }: { status: string }) {
  const [label, cls] = STATUS_STYLES[status] ?? [status || "unknown", "bg-mut/15 text-mut"];
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
      {label}
    </span>
  );
}

export type Warning = { institution?: string; status?: string; reason?: string | null };

export function WarningsBanner({ warnings }: { warnings?: Warning[] }) {
  if (!warnings?.length) return null;
  return (
    <div className="mb-4 rounded-lg border border-amber/40 bg-amber/10 px-4 py-3 text-sm">
      {warnings.map((w, i) => (
        <div key={i}>
          ⚠ <b>{w.institution ?? "unknown"}</b>
          {w.status ? ` — ${w.status}` : ""}
          {w.reason ? `: ${w.reason}` : ""}
        </div>
      ))}
    </div>
  );
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  const hint =
    e.service === "mcp"
      ? "Start it with: .venv/bin/python server.py"
      : e.service === "link_helper"
        ? "Start it with: .venv/bin/uvicorn link_helper:app --port 8765"
        : null;
  return (
    <div className="mb-4 rounded-lg border border-red/40 bg-red/10 px-4 py-3 text-sm">
      <b>{e.service ? `${e.service} unavailable` : "Request failed"}</b>
      <div className="text-mut">{e.message}</div>
      {hint && <div className="mt-1 text-mut">{hint}</div>}
    </div>
  );
}

/** Renders a Plaid-sign amount: spending plain, inflows green with +. */
export function Money({ amount }: { amount: number | null | undefined }) {
  if (amount == null) return <span className="text-mut">—</span>;
  const { text, inflow } = signedUsd(amount);
  return <span className={inflow ? "text-green" : ""}>{text}</span>;
}

/** Renders a balance (no sign flip): negative red. */
export function Balance({ amount }: { amount: number | null | undefined }) {
  if (amount == null) return <span className="text-mut">—</span>;
  return <span className={amount < 0 ? "text-red" : ""}>{usd(amount)}</span>;
}

export function Loading() {
  return <div className="py-8 text-center text-mut">Loading…</div>;
}
```

- [ ] **Step 4: Layout with sidebar nav.** Replace `dashboard/src/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Personal Finance",
  description: "Local drill-down dashboard over the personal-finance MCP",
};

const NAV: Array<[string, string]> = [
  ["/", "Overview"],
  ["/accounts", "Accounts"],
  ["/transactions", "Transactions"],
  ["/spending", "Spending"],
  ["/net-worth", "Net worth"],
  ["/investments", "Investments"],
  ["/debt", "Debt"],
  ["/cash-flow", "Cash flow"],
  ["/connections", "Connections"],
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <div className="flex min-h-screen">
          <aside className="w-52 shrink-0 border-r border-line p-4">
            <div className="mb-6 px-2 font-bold">💰 Finance</div>
            <nav className="flex flex-col gap-1">
              {NAV.map(([href, label]) => (
                <Link key={href} href={href}
                  className="rounded-md px-2 py-1.5 text-sm text-mut hover:bg-card hover:text-txt">
                  {label}
                </Link>
              ))}
            </nav>
          </aside>
          <main className="min-w-0 flex-1 p-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
```

Note: Plan B pages 404 until built — acceptable; nav ships once.

- [ ] **Step 5: Build check**

Run: `cd dashboard && npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/lib dashboard/src/components dashboard/src/app/layout.tsx
git commit -m "feat(dashboard): client data layer, UI kit, app shell"
```

### Task 7: Overview page

**Files:**
- Create: `dashboard/src/app/page.tsx` (replace scaffold page), delete scaffold `dashboard/src/app/page.module.css` if present

The shapes used below come from `server.py` impls: `get_net_worth` → `{net_worth, total_assets, total_liabilities, by_class, warnings}`; `get_financial_health` → `{score, grade, components, warnings}` (insights.py); `get_optimizer_score` → gamify's `{current_month:{total,target,remaining,elapsed_days,days_in_month,by_category,saved,allowance_to_date,new_record}, months_won, months_played, wedding_saved_total, personal_best}`; link `status` → `{institutions:[{env_key,institution,status,reason,accounts,last_synced_at}], db_ok, delivery, game, last_sync}`. Render defensively (`?.`, fallbacks) since exact keys can vary.

- [ ] **Step 1: Implement.** Replace `dashboard/src/app/page.tsx`:

```tsx
"use client";

import { useLinkStatus, useTool } from "@/lib/hooks";
import { fmtDateTime, usd } from "@/lib/format";
import { Balance, Card, ErrorBanner, Loading, Stat, StatusBadge, WarningsBanner } from "@/components/ui";
import Link from "next/link";

type NetWorth = {
  net_worth?: number; total_assets?: number; total_liabilities?: number;
  by_class?: Record<string, number>; warnings?: [];
};
type Health = { score?: number; grade?: string; warnings?: [] };
type Game = {
  current_month?: {
    total: number; target: number; remaining: number; elapsed_days: number;
    days_in_month: number; saved: number; new_record?: boolean;
    by_category?: Record<string, number>;
  };
  months_won?: number; months_played?: number; wedding_saved_total?: number;
};
type LinkStatus = {
  institutions: Array<{ env_key: string; institution: string; status: string;
    last_synced_at: string | null; accounts: Array<{ name: string; mask?: string }> }>;
  db_ok: boolean;
  delivery?: { this_month?: number; orders?: number; last_month?: number };
  last_sync?: { at: string; ok: boolean } | null;
};

export default function Overview() {
  const nw = useTool<NetWorth>("get_net_worth");
  const health = useTool<Health>("get_financial_health");
  const game = useTool<Game>("get_optimizer_score");
  const status = useLinkStatus<LinkStatus>();

  const cm = game.data?.current_month;
  const overBudget = cm ? cm.total > cm.target : false;
  const pctUsed = cm ? Math.min(100, Math.round((100 * cm.total) / cm.target)) : 0;
  const lastOk = status.data?.institutions.map((i) => i.last_synced_at).filter(Boolean).sort().pop();

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-1 text-xl font-bold">Overview</h1>
      <p className="mb-6 text-sm text-mut">Everything, at a glance.</p>

      <ErrorBanner error={nw.error ?? status.error} />
      <WarningsBanner warnings={nw.data?.warnings} />

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <Stat label="Net worth" value={<Balance amount={nw.data?.net_worth} />}
            sub={nw.data ? <>assets {usd(nw.data.total_assets)} · debts {usd(nw.data.total_liabilities)}</> : "…"} />
        </Card>
        <Card>
          <Stat label="Financial health"
            value={health.data?.grade ?? "…"}
            sub={health.data?.score != null ? `score ${health.data.score}` : undefined} />
        </Card>
        <Card>
          <Stat label="This month (Optimizer)"
            value={cm ? <span className={overBudget ? "text-red" : ""}>{usd(cm.total)}</span> : "…"}
            sub={cm ? `of ${usd(cm.target)} target · day ${cm.elapsed_days}/${cm.days_in_month}` : undefined} />
          {cm && (
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-line">
              <div className={`h-full ${overBudget ? "bg-red" : pctUsed > 80 ? "bg-amber" : "bg-green"}`}
                style={{ width: `${pctUsed}%` }} />
            </div>
          )}
        </Card>
      </div>

      {nw.data?.by_class && (
        <Card title="Breakdown by class" className="mt-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Object.entries(nw.data.by_class).map(([cls, v]) => (
              <Stat key={cls} label={cls.replace(/_/g, " ")} value={<Balance amount={v} />} />
            ))}
          </div>
        </Card>
      )}

      <Card title="Connections & sync" className="mt-4"
        right={<Link href="/connections" className="text-sm text-accent">Manage →</Link>}>
        {status.data ? (
          <>
            <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-mut">
              <span>Banks: <b className="text-txt">{status.data.institutions.length}</b></span>
              <span>History DB: <b className={status.data.db_ok ? "text-green" : "text-red"}>
                {status.data.db_ok ? "connected" : "unreachable"}</b></span>
              <span>Last successful sync: <b className="text-txt">{fmtDateTime(lastOk)}</b></span>
              {status.data.delivery?.this_month != null && (
                <span>🛵 Delivery this month: <b className="text-txt">{usd(status.data.delivery.this_month)}</b>
                  {" "}({status.data.delivery.orders})</span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {status.data.institutions.map((i) => (
                <span key={i.env_key} className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm">
                  {i.institution} <StatusBadge status={i.status} />
                </span>
              ))}
            </div>
          </>
        ) : status.error ? null : <Loading />}
      </Card>

      {cm && (
        <Card title="🎮 The Optimizer" className="mt-4">
          <div className="text-sm">
            {cm.saved > 0
              ? <>💍 On track to send <b className="text-green">{usd(cm.saved)}</b> to the wedding</>
              : <>📊 Allowance to date {usd(cm.allowance_to_date ?? 0)} · at {usd(cm.total)}</>}
            {" · "}<span className="text-mut">{usd(game.data?.wedding_saved_total ?? 0)} banked</span>
            {" · "}won {game.data?.months_won ?? 0}/{game.data?.months_played ?? 0} months
          </div>
          {cm.by_category && (
            <div className="mt-2 text-sm text-mut">
              where it&apos;s going: {Object.entries(cm.by_category).slice(0, 4)
                .map(([k, v]) => `${k} ${usd(v)}`).join(" · ")}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
```

Add `allowance_to_date?: number` to the `current_month` type if TypeScript complains (it is referenced above — include it in the Game type from the start).

- [ ] **Step 2: Build check**

Run: `cd dashboard && npm run build`
Expected: build succeeds.

- [ ] **Step 3: Live smoke (services running).** With MCP server + link_helper up:

Run: `cd dashboard && (npm run dev &) && sleep 5 && curl -s -X POST localhost:3000/api/mcp/get_net_worth -H 'content-type: application/json' -d '{"args":{}}' | head -c 400; curl -s localhost:3000/api/link/status | head -c 400; kill %1`
Expected: JSON from both (or a clean 502 JSON if a service is down — not a crash).

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/app/page.tsx
git rm -f --ignore-unmatch dashboard/src/app/page.module.css
git commit -m "feat(dashboard): overview page"
```

### Task 8: Connections page (full port of existing UI)

**Files:**
- Create: `dashboard/src/app/connections/page.tsx`

- [ ] **Step 1: Implement.** Create `dashboard/src/app/connections/page.tsx`:

```tsx
"use client";

import Script from "next/script";
import { useRef, useState } from "react";
import { useLinkStatus } from "@/lib/hooks";
import { linkFetch } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { Card, ErrorBanner, Loading, StatusBadge } from "@/components/ui";

declare global {
  interface Window {
    Plaid: {
      create(opts: {
        token: string;
        onSuccess(public_token: string): void;
        onExit(err: unknown): void;
      }): { open(): void };
    };
  }
}

type LinkStatus = {
  institutions: Array<{
    env_key: string; institution: string; status: string; reason: string | null;
    last_synced_at: string | null;
    accounts: Array<{ name?: string; mask?: string; subtype?: string }>;
  }>;
  db_ok: boolean;
  last_sync?: { at: string; ok: boolean; warnings?: unknown[]; error?: string } | null;
};

export default function Connections() {
  const status = useLinkStatus<LinkStatus>();
  const [syncOut, setSyncOut] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [linkOut, setLinkOut] = useState("");
  const [csvOut, setCsvOut] = useState("");
  const [csvName, setCsvName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function syncNow() {
    setSyncing(true);
    setSyncOut("Running sync…");
    try {
      const d = await linkFetch<{ ok: boolean; total_transactions_stored?: number }>("sync", { method: "POST" });
      setSyncOut(
        (d.ok ? `✓ Sync OK — ${d.total_transactions_stored} transactions stored` : "⚠ Sync completed with issues") +
        "\n" + JSON.stringify(d, null, 2),
      );
    } catch (e) {
      setSyncOut(`Sync failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSyncing(false);
      status.mutate();
    }
  }

  async function linkBank() {
    setLinkOut("");
    try {
      const d = await linkFetch<{ link_token?: string }>("create-link-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!d.link_token) { setLinkOut("Error: " + JSON.stringify(d)); return; }
      window.Plaid.create({
        token: d.link_token,
        onSuccess: async (public_token) => {
          const ex = await linkFetch<unknown>("exchange", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ public_token }),
          });
          setLinkOut("Linked! " + JSON.stringify(ex));
          status.mutate();
        },
        onExit: (err) => { if (err) setLinkOut("Exit: " + JSON.stringify(err)); },
      }).open();
    } catch (e) {
      setLinkOut(`Link failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function uploadCsv() {
    const f = fileRef.current?.files?.[0];
    if (!f) return;
    setCsvOut("Importing…");
    try {
      const d = await linkFetch<{
        ok: boolean; error?: string; imported?: number; skipped_existing_date?: number;
        skipped_duplicate_id?: number; file_date_range?: [string, string] | null; total_for_item?: number;
      }>("import-apple-card", { method: "POST", body: f });
      setCsvOut(
        d.ok
          ? `✓ Imported ${d.imported} new transaction(s).\n` +
            `  skipped (date already stored): ${d.skipped_existing_date}\n` +
            `  skipped (duplicate id): ${d.skipped_duplicate_id}\n` +
            `  file covered ${d.file_date_range ? d.file_date_range[0] + " → " + d.file_date_range[1] : "—"}\n` +
            `  Apple Card total now: ${d.total_for_item}`
          : "✗ " + (d.error ?? "import failed"),
      );
    } catch (e) {
      setCsvOut(`Upload failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      status.mutate();
    }
  }

  const ls = status.data?.last_sync;
  return (
    <div className="mx-auto max-w-4xl">
      <Script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js" strategy="afterInteractive" />
      <h1 className="mb-1 text-xl font-bold">Connections</h1>
      <p className="mb-6 text-sm text-mut">Linked accounts &amp; sync status</p>

      <ErrorBanner error={status.error} />

      <Card title="Linked banks"
        right={
          <span className="flex gap-2">
            <button onClick={() => status.mutate()}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-semibold">Refresh</button>
            <button onClick={syncNow} disabled={syncing}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
              {syncing ? "Syncing…" : "Sync now"}
            </button>
          </span>
        }>
        {status.data ? (
          status.data.institutions.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-mut">
                  <th className="py-2">Bank</th><th>Link status</th><th>Accounts</th><th>Last synced</th>
                </tr>
              </thead>
              <tbody>
                {status.data.institutions.map((i) => (
                  <tr key={i.env_key} className="border-t border-line align-top">
                    <td className="py-2.5 font-semibold">{i.institution}</td>
                    <td className="py-2.5">
                      <StatusBadge status={i.status} />
                      {i.reason && <div className="text-xs text-mut">{i.reason}</div>}
                    </td>
                    <td className="py-2.5 text-mut">
                      {i.accounts.length
                        ? i.accounts.map((a, k) => (
                            <div key={k}>{a.name ?? a.subtype ?? "account"}{a.mask ? ` ••${a.mask}` : ""}</div>
                          ))
                        : <span>— run sync —</span>}
                    </td>
                    <td className="py-2.5 text-mut">{fmtDateTime(i.last_synced_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-mut">No banks linked yet — click “Link a bank”.</div>
          )
        ) : status.error ? null : <Loading />}
        {(syncOut || ls?.error) && (
          <pre className="mt-3 whitespace-pre-wrap text-xs text-mut">
            {syncOut || `Last sync error: ${ls?.error}`}
          </pre>
        )}
      </Card>

      <Card className="mt-4">
        <div className="flex items-center justify-between">
          <span className="text-mut">Connect another bank account</span>
          <button onClick={linkBank}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white">Link a bank</button>
        </div>
        <p className="mt-2 text-xs text-mut">
          Re-auth for a broken link: use the curl flow in <code>link_helper.py</code> — tokens never reach the browser.
        </p>
        {linkOut && <pre className="mt-2 whitespace-pre-wrap text-xs text-mut">{linkOut}</pre>}
      </Card>

      <Card title="Import Apple Card" className="mt-4">
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm text-mut">
            Upload an Apple Card CSV export. Re-uploading overlapping statements only adds dates you don’t already have.
            <div className="mt-1 text-xs">{csvName || "No file chosen"}</div>
          </div>
          <span className="flex shrink-0 gap-2">
            <input type="file" ref={fileRef} accept=".csv,text/csv" className="hidden"
              onChange={() => setCsvName(fileRef.current?.files?.[0]?.name ?? "")} />
            <button onClick={() => fileRef.current?.click()}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-semibold">Choose CSV…</button>
            <button onClick={uploadCsv} disabled={!csvName}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
              Upload
            </button>
          </span>
        </div>
        {csvOut && <pre className="mt-2 whitespace-pre-wrap text-xs text-mut">{csvOut}</pre>}
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Build + tests**

Run: `cd dashboard && npm test && npm run build`
Expected: PASS / build succeeds.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/app/connections
git commit -m "feat(dashboard): connections page (Plaid Link, sync, CSV import)"
```

### Task 9: README + final verification

**Files:**
- Create: `dashboard/README.md`

- [ ] **Step 1: README.** Create `dashboard/README.md`:

```markdown
# Personal Finance Dashboard (local-only)

Next.js drill-down UI over the personal-finance MCP server and `link_helper`.
Never deploy this — it assumes a trusted localhost, like `link_helper` itself.

## Run

Requires both backends:

    .venv/bin/python server.py                      # MCP server, :8000
    .venv/bin/uvicorn link_helper:app --port 8765   # Plaid Link / sync / CSV

Then:

    cd dashboard
    npm install
    npm run dev        # http://localhost:3000

Optional `.env.local` (see `.env.local.example`): `MCP_URL`, `LINK_HELPER_URL`.

## Architecture

- `/api/mcp/[tool]` → MCP client → `localhost:8000/mcp` (allowlisted tools; all analytics)
- `/api/link/*` → proxy → `localhost:8765` (Plaid Link token/exchange, sync, CSV import, status)

All business logic stays in the Python modules; this app renders tool output.

## Tests

    npm test           # vitest: formatters, allowlist, BFF routes
```

- [ ] **Step 2: Full verification**

Run: `cd dashboard && npm test && npm run build`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add dashboard/README.md
git commit -m "docs(dashboard): run book"
```
