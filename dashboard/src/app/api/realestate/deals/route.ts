import { listDeals } from "@/lib/realestate/db";
import { callerRoles, unauthorized, denyPerm } from "@/lib/session";

// DB-backed: never statically evaluate at build time.
export const dynamic = "force-dynamic";

export async function GET() {
  const roles = await callerRoles();
  if (roles === null) return unauthorized();
  const denied = denyPerm(roles, "realestate:read");
  if (denied) return denied;
  try {
    return Response.json({ deals: await listDeals() });
  } catch (e) {
    return Response.json(
      { error: `deals DB unreachable: ${e instanceof Error ? e.message : e}`, service: "realestate-db" },
      { status: 502 },
    );
  }
}
