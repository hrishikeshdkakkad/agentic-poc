import { callerRoles, unauthorized, denyPerm } from "@/lib/session";

const LINK_HELPER_URL = process.env.LINK_HELPER_URL ?? "http://localhost:8765";

// dashboard path → { upstream path, allowed method }
const ROUTES: Record<string, { upstream: string; method: "GET" | "POST" }> = {
  status: { upstream: "api/status", method: "GET" },
  "create-link-token": { upstream: "create-link-token", method: "POST" },
  exchange: { upstream: "exchange", method: "POST" },
  sync: { upstream: "sync", method: "POST" },
  "import-apple-card": { upstream: "import-apple-card", method: "POST" },
  "reset-item": { upstream: "reset-item", method: "POST" },
};

type Ctx = { params: Promise<{ path: string[] }> };

async function proxy(req: Request, ctx: Ctx, method: "GET" | "POST") {
  const roles = await callerRoles();
  if (roles === null) return unauthorized();
  const denied = denyPerm(roles, "connections:manage");
  if (denied) return denied;
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
