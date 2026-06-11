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
