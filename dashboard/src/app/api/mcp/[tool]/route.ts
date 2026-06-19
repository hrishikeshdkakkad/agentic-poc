import { callMcpTool } from "@/lib/mcp";
import { ALLOWED_TOOLS } from "@/lib/tools";
import { callerRoles, unauthorized, denyTool } from "@/lib/session";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tool: string }> },
) {
  const roles = await callerRoles();
  if (roles === null) return unauthorized();

  const { tool } = await params;
  if (!ALLOWED_TOOLS.has(tool)) {
    return Response.json({ error: `unknown tool: ${tool}` }, { status: 404 });
  }
  const denied = denyTool(roles, tool);
  if (denied) return denied;

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
