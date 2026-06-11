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

/** FastMCP returns structuredContent for dict results; older paths return text JSON.
 * Accepts unknown because the SDK's callTool return type is a union that
 * includes a legacy `toolResult` shape. */
export function parseToolResult(raw: unknown): unknown {
  const result = raw as RawResult;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (text === undefined) throw new Error("empty tool result");
  return JSON.parse(text);
}
