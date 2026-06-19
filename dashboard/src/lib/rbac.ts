// Single source of truth for role→permission→page/tool authorization.
// Pure + framework-free so it runs in edge middleware, API routes, and the browser.
// Enforced server-side (API routes / proxy); also drives nav + component filtering.

export type Permission =
  | "overview:read" | "transactions:read" | "spending:read" | "cashflow:read"
  | "accounts:read" | "networth:read" | "investments:read" | "debt:read"
  | "realestate:read" | "realestate:write" | "plan:read"
  | "connections:manage" | "corrections:write" | "sync:run";

const WILDCARD = "*";

export const ROLE_PERMISSIONS: Record<string, (Permission | "*")[]> = {
  admin: [WILDCARD],
  "realestate-viewer": ["realestate:read"],
};

export const PAGE_PERMISSION: Record<string, Permission> = {
  "/": "overview:read",
  "/transactions": "transactions:read",
  "/spending": "spending:read",
  "/cash-flow": "cashflow:read",
  "/accounts": "accounts:read",
  "/net-worth": "networth:read",
  "/investments": "investments:read",
  "/debt": "debt:read",
  "/real-estate": "realestate:read",
  "/plan": "plan:read",
  "/connections": "connections:manage",
};

// MCP tool → required permission. "admin" = wildcard required (raw SQL / dangerous).
export const TOOL_PERMISSION: Record<string, Permission | "admin"> = {
  list_accounts: "accounts:read", get_balances: "accounts:read",
  get_transactions: "transactions:read", list_transactions: "transactions:read",
  search_transactions: "transactions:read", get_merchant_profile: "transactions:read",
  list_category_overrides: "transactions:read",
  aggregate_spending: "spending:read", compare_periods: "spending:read",
  get_income_analysis: "cashflow:read", get_recurring_transactions: "cashflow:read",
  get_recurring_analysis: "cashflow:read",
  get_net_worth: "networth:read", get_net_worth_history: "networth:read",
  get_net_worth_trajectory: "networth:read",
  get_investment_holdings: "investments:read", get_investment_transactions: "investments:read",
  list_investment_transactions: "investments:read", get_portfolio_analysis: "investments:read",
  get_liabilities: "debt:read", get_debt_analysis: "debt:read",
  get_optimizer_score: "plan:read", get_optimizer_plan: "plan:read",
  get_financial_health: "overview:read",
  get_sync_status: "connections:manage", get_institutions_status: "connections:manage",
  sync_now: "sync:run",
  set_category_override: "corrections:write", set_manual_balance: "corrections:write",
  query_finances: "admin", describe_tables: "admin",
};

export function permissionsForRoles(roles: string[]): Set<string> {
  const out = new Set<string>();
  for (const r of roles ?? []) for (const p of ROLE_PERMISSIONS[r] ?? []) out.add(p);
  return out;
}

export function isAdmin(perms: Set<string>): boolean {
  return perms.has(WILDCARD);
}

export function can(perms: Set<string>, required: Permission): boolean {
  return perms.has(WILDCARD) || perms.has(required);
}

export function canUseTool(perms: Set<string>, tool: string): boolean {
  const required = TOOL_PERMISSION[tool];
  if (required === undefined) return false;        // deny unknown tools
  if (required === "admin") return isAdmin(perms); // raw SQL etc.
  return can(perms, required);
}

export function canAccessPage(perms: Set<string>, href: string): boolean {
  const required = PAGE_PERMISSION[href];
  if (required === undefined) return isAdmin(perms); // unknown page → admin only
  return can(perms, required);
}

export function allowedPages(perms: Set<string>): string[] {
  return Object.entries(PAGE_PERMISSION).filter(([, r]) => can(perms, r)).map(([h]) => h);
}
