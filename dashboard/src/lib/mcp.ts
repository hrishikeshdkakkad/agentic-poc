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
