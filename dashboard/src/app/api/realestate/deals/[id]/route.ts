import { upsertDeal, deleteDeal } from "@/lib/realestate/db";
import { dealFromPayload } from "@/lib/realestate/db-serialize";
import { callerRoles, unauthorized, denyPerm } from "@/lib/session";

// DB-backed: never statically evaluate at build time.
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const roles = await callerRoles();
  if (roles === null) return unauthorized();
  const denied = denyPerm(roles, "realestate:write");
  if (denied) return denied;
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
  const roles = await callerRoles();
  if (roles === null) return unauthorized();
  const denied = denyPerm(roles, "realestate:write");
  if (denied) return denied;
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
