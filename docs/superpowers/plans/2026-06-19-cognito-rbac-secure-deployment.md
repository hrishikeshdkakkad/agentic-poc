# Cognito OAuth + Page-Level RBAC + Vercel Deployment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the personal-finance dashboard to Vercel behind invitation-only AWS Cognito sign-in with per-page RBAC, keeping MCP + sync on Lambda, at ~$0 cost.

**Architecture:** Cognito Hosted UI (OAuth2 auth-code + PKCE) authenticates users; Auth.js v5 manages the session cookie in Next.js. RBAC is enforced **server-side in the Next.js layer** (the only place that holds the MCP bearer token and Neon creds) via a single permission map keyed off Cognito group membership. The MCP Lambda stays single-token / full-access by design.

**Tech Stack:** Next.js 16.2.9 (App Router), React 19, Auth.js v5 (`next-auth@beta`), AWS Cognito, AWS CLI, Vercel CLI, Neon Postgres, `@modelcontextprotocol/sdk` (TS client).

**Spec:** `docs/superpowers/specs/2026-06-19-cognito-rbac-secure-deployment-design.md`

## Global Constraints

- AWS account `471112572248`, region `us-east-1`. Do NOT touch the unrelated `expenseForce-dev` pool (`us-east-1_AW88ON1sT`).
- MCP Function URL: `https://3a6q4qkjrmx5ewdazow7objvmu0uktgz.lambda-url.us-east-1.on.aws/` (append `/mcp`). Bearer-gated; `AuthType: NONE` unchanged.
- All secrets server-only. NEVER use `NEXT_PUBLIC_` for `MCP_AUTH_TOKEN`, `DATABASE_URL`, `AUTH_SECRET`, or any Cognito client secret.
- `next-auth@beta` requires `legacy-peer-deps` on Next 16 → pin via `dashboard/.npmrc` so Vercel's build matches local.
- Next.js 16 renamed middleware → **`proxy.ts`** (must `export default` a function). Use `proxy.ts`, not `middleware.ts`.
- MCP bearer goes in an **Authorization header** via `StreamableHTTPClientTransport(url, { requestInit: { headers } })` — never in the URL path.
- Roles are Cognito groups: `admin` (full) and `realestate-viewer` (`realestate:read` only). Store only `roles` in the session; compute permissions from the config map at each check.
- Deny-by-default: unknown tool/page → denied unless admin.
- `query_finances` / `describe_tables` are admin-only (raw SQL bypasses page scoping).
- Cost: stay in free tiers (Cognito ≤10k MAU, Vercel Hobby, Lambda/Neon unchanged).

---

## File Structure

**New (dashboard):**
- `dashboard/.npmrc` — `legacy-peer-deps=true`
- `dashboard/src/lib/rbac.ts` — permission maps + resolvers (the heart; pure, tested)
- `dashboard/src/lib/rbac.test.ts` — vitest spec for the gate
- `dashboard/auth.config.ts` — edge-safe Auth.js config (Cognito provider + callbacks)
- `dashboard/auth.ts` — full Auth.js instance (`handlers`, `auth`, `signIn`, `signOut`)
- `dashboard/proxy.ts` — Next 16 middleware: session + page-RBAC redirect
- `dashboard/src/types/next-auth.d.ts` — session/JWT type augmentation
- `dashboard/src/app/api/auth/[...nextauth]/route.ts` — Auth.js handlers
- `dashboard/src/lib/session.ts` — server helpers (`getRoles`, `requireTool`, `requirePerm`)
- `dashboard/src/lib/session.test.ts` — helper tests
- `dashboard/src/components/session-provider.tsx` — client `<SessionProvider>` wrapper
- `dashboard/src/app/login/page.tsx` — branded sign-in entry
- `dashboard/src/app/403/page.tsx` — forbidden page
- `dashboard/vercel.json` — `maxDuration` for the MCP proxy route
- `deploy/setup_cognito.sh` — idempotent pool/domain/client/groups
- `deploy/invite.sh` — create user + assign role
- `deploy/cognito_helpers.sh` — list-users / revoke

**Modified (dashboard):**
- `dashboard/package.json` — add `next-auth@beta`
- `dashboard/src/lib/mcp.ts` — attach bearer header to upstream transport
- `dashboard/src/app/api/mcp/[tool]/route.ts` — session + tool-RBAC before forward
- `dashboard/src/app/api/realestate/deals/route.ts` — require `realestate:read`
- `dashboard/src/app/api/realestate/deals/[id]/route.ts` — require `realestate:write`
- `dashboard/src/app/api/link/[...path]/route.ts` — require `connections:manage`
- `dashboard/src/app/layout.tsx` — wrap in `<SessionProvider>`
- `dashboard/src/components/app-shell.tsx` — nav filter by perms; user menu + sign-out; repoint Sync/last-sync to MCP tools
- `dashboard/src/components/command-palette.tsx` — filter NAV by perms
- `dashboard/src/components/realestate/context-strip.tsx` — return null when lacking `networth:read`/`investments:read`
- `dashboard/.env.local.example` — new env vars
- `CLAUDE.md`, `dashboard/README.md` — document the auth model

---

## PHASE 0 — Cognito provisioning (AWS CLI)

### Task 0.1: Idempotent Cognito setup script

**Files:**
- Create: `deploy/setup_cognito.sh`

**Interfaces:**
- Produces (printed to stdout, for later Vercel env): `USER_POOL_ID`, `APP_CLIENT_ID`, `APP_CLIENT_SECRET`, `ISSUER`, `HOSTED_DOMAIN`.
- Consumes: env `CALLBACK_BASE` (e.g. `https://<vercel-prod-domain>`); optional `DEV_CALLBACK_BASE` (default `http://localhost:3000`).

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Idempotent AWS Cognito setup for personal-finance dashboard.
# Re-runnable: creates-or-reuses the pool/domain/client/groups and updates callback URLs.
# Usage: CALLBACK_BASE="https://your-app.vercel.app" ./deploy/setup_cognito.sh
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
POOL_NAME="personal-finance-mcp"
CLIENT_NAME="personal-finance-dashboard"
CALLBACK_BASE="${CALLBACK_BASE:?set CALLBACK_BASE to your Vercel prod URL, e.g. https://app.vercel.app}"
DEV_CALLBACK_BASE="${DEV_CALLBACK_BASE:-http://localhost:3000}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
DOMAIN_PREFIX="${COGNITO_DOMAIN_PREFIX:-pf-mcp-${ACCOUNT_ID}}"

cb() { printf '%s/api/auth/callback/cognito' "$1"; }
CALLBACKS="$(cb "$CALLBACK_BASE"),$(cb "$DEV_CALLBACK_BASE")"
LOGOUTS="${CALLBACK_BASE}/login,${DEV_CALLBACK_BASE}/login"

echo "Region=$REGION Account=$ACCOUNT_ID Domain=$DOMAIN_PREFIX" >&2

# 1) Find or create the user pool (invitation-only, strong password, MFA off).
POOL_ID="$(aws cognito-idp list-user-pools --max-results 60 --region "$REGION" \
  --query "UserPools[?Name=='${POOL_NAME}'].Id | [0]" --output text)"
if [ "$POOL_ID" = "None" ] || [ -z "$POOL_ID" ]; then
  POOL_ID="$(aws cognito-idp create-user-pool --region "$REGION" --pool-name "$POOL_NAME" \
    --admin-create-user-config '{"AllowAdminCreateUserOnly":true}' \
    --auto-verified-attributes email \
    --username-attributes email \
    --mfa-configuration OFF \
    --account-recovery-setting '{"RecoveryMechanisms":[{"Priority":1,"Name":"verified_email"}]}' \
    --policies '{"PasswordPolicy":{"MinimumLength":12,"RequireUppercase":true,"RequireLowercase":true,"RequireNumbers":true,"RequireSymbols":true,"TemporaryPasswordValidityDays":7}}' \
    --query 'UserPool.Id' --output text)"
  echo "Created pool $POOL_ID" >&2
else
  echo "Reusing pool $POOL_ID" >&2
fi

# 2) Hosted UI domain (ignore error if it already exists).
aws cognito-idp create-user-pool-domain --region "$REGION" \
  --domain "$DOMAIN_PREFIX" --user-pool-id "$POOL_ID" 2>/dev/null \
  && echo "Created domain $DOMAIN_PREFIX" >&2 || echo "Domain exists/!available; reusing $DOMAIN_PREFIX" >&2

# 3) Groups = roles.
for g in admin realestate-viewer; do
  aws cognito-idp create-group --region "$REGION" --user-pool-id "$POOL_ID" --group-name "$g" 2>/dev/null \
    && echo "Created group $g" >&2 || echo "Group $g exists" >&2
done

# 4) App client (confidential): create or update callbacks/scopes.
CLIENT_ID="$(aws cognito-idp list-user-pool-clients --region "$REGION" --user-pool-id "$POOL_ID" --max-results 60 \
  --query "UserPoolClients[?ClientName=='${CLIENT_NAME}'].ClientId | [0]" --output text)"
COMMON_CLIENT_ARGS=(--region "$REGION" --user-pool-id "$POOL_ID"
  --allowed-o-auth-flows code --allowed-o-auth-scopes openid email profile
  --allowed-o-auth-flows-user-pool-client
  --supported-identity-providers COGNITO
  --callback-urls "$CALLBACKS" --logout-urls "$LOGOUTS"
  --explicit-auth-flows ALLOW_REFRESH_TOKEN_AUTH ALLOW_USER_SRP_AUTH
  --prevent-user-existence-errors ENABLED
  --enable-token-revocation
  --access-token-validity 60 --id-token-validity 60 --refresh-token-validity 30
  --token-validity-units '{"AccessToken":"minutes","IdToken":"minutes","RefreshToken":"days"}')
if [ "$CLIENT_ID" = "None" ] || [ -z "$CLIENT_ID" ]; then
  CLIENT_ID="$(aws cognito-idp create-user-pool-client --client-name "$CLIENT_NAME" \
    --generate-secret "${COMMON_CLIENT_ARGS[@]}" --query 'UserPoolClient.ClientId' --output text)"
  echo "Created client $CLIENT_ID" >&2
else
  aws cognito-idp update-user-pool-client --client-id "$CLIENT_ID" "${COMMON_CLIENT_ARGS[@]}" >/dev/null
  echo "Updated client $CLIENT_ID" >&2
fi

CLIENT_SECRET="$(aws cognito-idp describe-user-pool-client --region "$REGION" \
  --user-pool-id "$POOL_ID" --client-id "$CLIENT_ID" --query 'UserPoolClient.ClientSecret' --output text)"

cat <<EOF

# ---- Cognito ready. Put these in Vercel env (server-only) ----
AUTH_COGNITO_ID=$CLIENT_ID
AUTH_COGNITO_SECRET=$CLIENT_SECRET
AUTH_COGNITO_ISSUER=https://cognito-idp.${REGION}.amazonaws.com/${POOL_ID}
COGNITO_HOSTED_DOMAIN=https://${DOMAIN_PREFIX}.auth.${REGION}.amazoncognito.com
# USER_POOL_ID=$POOL_ID  (for deploy/invite.sh)
EOF
```

- [ ] **Step 2: Make executable**

Run: `chmod +x deploy/setup_cognito.sh`

- [ ] **Step 3: Verify syntax (no AWS calls)**

Run: `bash -n deploy/setup_cognito.sh`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add deploy/setup_cognito.sh
git commit -m "feat(cognito): idempotent user-pool/client/groups provisioning script"
```

> NOTE: actual execution (which creates AWS resources) happens in Phase 3 once the Vercel prod domain is known, so `CALLBACK_BASE` is correct.

### Task 0.2: Invite + helper CLI scripts

**Files:**
- Create: `deploy/invite.sh`, `deploy/cognito_helpers.sh`

**Interfaces:**
- Consumes: env `USER_POOL_ID` (from Task 0.1 output) or auto-resolves by pool name.
- `deploy/invite.sh <email> <role>` → creates user (emails temp password) + adds to group.

- [ ] **Step 1: Write `deploy/invite.sh`**

```bash
#!/usr/bin/env bash
# Invite a user (invitation-only sign-up) and assign a role.
# Usage: ./deploy/invite.sh dad@example.com realestate-viewer
set -euo pipefail
REGION="${AWS_REGION:-us-east-1}"
EMAIL="${1:?usage: invite.sh <email> <role: admin|realestate-viewer>}"
ROLE="${2:?usage: invite.sh <email> <role>}"
POOL_ID="${USER_POOL_ID:-$(aws cognito-idp list-user-pools --max-results 60 --region "$REGION" \
  --query "UserPools[?Name=='personal-finance-mcp'].Id | [0]" --output text)}"
[ -n "$POOL_ID" ] && [ "$POOL_ID" != "None" ] || { echo "pool not found; run setup_cognito.sh" >&2; exit 1; }

aws cognito-idp admin-create-user --region "$REGION" --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL >/dev/null
aws cognito-idp admin-add-user-to-group --region "$REGION" --user-pool-id "$POOL_ID" \
  --username "$EMAIL" --group-name "$ROLE"
echo "Invited $EMAIL as $ROLE. Cognito emailed a temporary password."
```

- [ ] **Step 2: Write `deploy/cognito_helpers.sh`**

```bash
#!/usr/bin/env bash
# List users + their groups, or revoke a user.
# Usage: ./deploy/cognito_helpers.sh list
#        ./deploy/cognito_helpers.sh revoke user@example.com
set -euo pipefail
REGION="${AWS_REGION:-us-east-1}"
POOL_ID="${USER_POOL_ID:-$(aws cognito-idp list-user-pools --max-results 60 --region "$REGION" \
  --query "UserPools[?Name=='personal-finance-mcp'].Id | [0]" --output text)}"
case "${1:-list}" in
  list)
    aws cognito-idp list-users --region "$REGION" --user-pool-id "$POOL_ID" \
      --query 'Users[].{email:Attributes[?Name==`email`].Value|[0],status:UserStatus,enabled:Enabled}' --output table ;;
  revoke)
    EMAIL="${2:?usage: revoke <email>}"
    aws cognito-idp admin-user-global-sign-out --region "$REGION" --user-pool-id "$POOL_ID" --username "$EMAIL"
    aws cognito-idp admin-disable-user --region "$REGION" --user-pool-id "$POOL_ID" --username "$EMAIL"
    echo "Revoked + disabled $EMAIL (delete with admin-delete-user if desired)." ;;
  *) echo "unknown command: $1" >&2; exit 1 ;;
esac
```

- [ ] **Step 3: Make executable + syntax check**

Run: `chmod +x deploy/invite.sh deploy/cognito_helpers.sh && bash -n deploy/invite.sh && bash -n deploy/cognito_helpers.sh`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add deploy/invite.sh deploy/cognito_helpers.sh
git commit -m "feat(cognito): invite + list/revoke CLI helpers"
```

---

## PHASE 1 — Auth + RBAC core (TDD)

### Task 1.1: Install Auth.js + pin legacy-peer-deps

**Files:**
- Create: `dashboard/.npmrc`
- Modify: `dashboard/package.json`

- [ ] **Step 1: Pin legacy-peer-deps**

Create `dashboard/.npmrc`:
```
legacy-peer-deps=true
```

- [ ] **Step 2: Install next-auth beta**

Run: `cd dashboard && npm install next-auth@beta`
Expected: `next-auth` appears in `dashboard/package.json` dependencies; install succeeds (the `.npmrc` allows the Next 16 peer range).

- [ ] **Step 3: Verify it resolved**

Run: `cd dashboard && node -e "console.log(require('next-auth/package.json').version)"`
Expected: prints a `5.x.x-beta.*` version.

- [ ] **Step 4: Commit**

```bash
git add dashboard/.npmrc dashboard/package.json dashboard/package-lock.json
git commit -m "build(dashboard): add next-auth@beta (legacy-peer-deps for Next 16)"
```

### Task 1.2: RBAC permission map + tests (the heart)

**Files:**
- Create: `dashboard/src/lib/rbac.ts`
- Test: `dashboard/src/lib/rbac.test.ts`

**Interfaces:**
- Produces: `permissionsForRoles(roles: string[]): Set<string>`, `can(perms, required): boolean`, `isAdmin(perms): boolean`, `canUseTool(perms, tool: string): boolean`, `canAccessPage(perms, href: string): boolean`, `allowedPages(perms): string[]`, and consts `ROLE_PERMISSIONS`, `PAGE_PERMISSION`, `TOOL_PERMISSION`.

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/src/lib/rbac.test.ts
import { describe, it, expect } from "vitest";
import {
  permissionsForRoles, can, isAdmin, canUseTool, canAccessPage, allowedPages,
} from "./rbac";

describe("rbac", () => {
  const admin = permissionsForRoles(["admin"]);
  const viewer = permissionsForRoles(["realestate-viewer"]);
  const none = permissionsForRoles([]);

  it("admin is wildcard and can do everything", () => {
    expect(isAdmin(admin)).toBe(true);
    expect(can(admin, "transactions:read")).toBe(true);
    expect(canUseTool(admin, "query_finances")).toBe(true);
    expect(canAccessPage(admin, "/transactions")).toBe(true);
  });

  it("realestate-viewer is scoped to real estate only", () => {
    expect(isAdmin(viewer)).toBe(false);
    expect(can(viewer, "realestate:read")).toBe(true);
    expect(canAccessPage(viewer, "/real-estate")).toBe(true);
    expect(canAccessPage(viewer, "/transactions")).toBe(false);
    expect(canAccessPage(viewer, "/")).toBe(false);
    expect(allowedPages(viewer)).toEqual(["/real-estate"]);
  });

  it("viewer cannot reach the real-estate context strip's tools", () => {
    expect(canUseTool(viewer, "get_net_worth_history")).toBe(false);
    expect(canUseTool(viewer, "get_portfolio_analysis")).toBe(false);
  });

  it("raw SQL tools are admin-only", () => {
    expect(canUseTool(viewer, "query_finances")).toBe(false);
    expect(canUseTool(none, "describe_tables")).toBe(false);
    expect(canUseTool(admin, "describe_tables")).toBe(true);
  });

  it("unknown tools and unknown pages are denied by default", () => {
    expect(canUseTool(viewer, "rm_minus_rf")).toBe(false);
    expect(canUseTool(admin, "rm_minus_rf")).toBe(false); // not in map → denied even for admin tool path? admin wildcard still gates by map
    expect(canAccessPage(none, "/")).toBe(false);
  });

  it("no roles grants nothing", () => {
    expect(can(none, "realestate:read")).toBe(false);
    expect(allowedPages(none)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd dashboard && npx vitest run src/lib/rbac.test.ts`
Expected: FAIL (module `./rbac` not found).

- [ ] **Step 3: Implement `rbac.ts`**

```typescript
// dashboard/src/lib/rbac.ts
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
```

- [ ] **Step 4: Run tests to confirm green**

Run: `cd dashboard && npx vitest run src/lib/rbac.test.ts`
Expected: PASS (all assertions).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/rbac.ts dashboard/src/lib/rbac.test.ts
git commit -m "feat(rbac): permission map + resolvers with tests (deny-by-default)"
```

### Task 1.3: Auth.js config (edge-safe split) + types + handlers

**Files:**
- Create: `dashboard/auth.config.ts`, `dashboard/auth.ts`, `dashboard/src/types/next-auth.d.ts`, `dashboard/src/app/api/auth/[...nextauth]/route.ts`

**Interfaces:**
- Produces: `auth`, `handlers`, `signIn`, `signOut` from `dashboard/auth.ts`; session shape `session.user.roles: string[]`.
- Consumes env: `AUTH_SECRET`, `AUTH_COGNITO_ID`, `AUTH_COGNITO_SECRET`, `AUTH_COGNITO_ISSUER`.

- [ ] **Step 1: Edge-safe config** — `dashboard/auth.config.ts`

```typescript
import type { NextAuthConfig } from "next-auth";
import Cognito from "next-auth/providers/cognito";

// Edge-safe: imported by both proxy.ts (middleware) and auth.ts.
// Stores ONLY cognito groups as `roles`; permissions are computed from the
// rbac config at each check so map changes don't require re-login.
export const authConfig: NextAuthConfig = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Cognito({
      clientId: process.env.AUTH_COGNITO_ID,
      clientSecret: process.env.AUTH_COGNITO_SECRET,
      issuer: process.env.AUTH_COGNITO_ISSUER,
    }),
  ],
  callbacks: {
    jwt({ token, profile }) {
      if (profile) {
        const groups = profile["cognito:groups"];
        token.roles = Array.isArray(groups) ? (groups as string[]) : [];
      }
      return token;
    },
    session({ session, token }) {
      session.user.roles = (token.roles as string[]) ?? [];
      return session;
    },
  },
};
```

- [ ] **Step 2: Full instance** — `dashboard/auth.ts`

```typescript
import NextAuth from "next-auth";
import { authConfig } from "./auth.config";

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
```

- [ ] **Step 3: Types** — `dashboard/src/types/next-auth.d.ts`

```typescript
import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user: { roles: string[] } & import("next-auth").DefaultSession["user"];
  }
}
declare module "next-auth/jwt" {
  interface JWT {
    roles?: string[];
  }
}
```

- [ ] **Step 4: Handlers route** — `dashboard/src/app/api/auth/[...nextauth]/route.ts`

```typescript
import { handlers } from "@/auth";
export const { GET, POST } = handlers;
```

- [ ] **Step 5: Typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: no errors from the new files (pre-existing unrelated errors, if any, unchanged).

- [ ] **Step 6: Commit**

```bash
git add dashboard/auth.config.ts dashboard/auth.ts dashboard/src/types/next-auth.d.ts dashboard/src/app/api/auth
git commit -m "feat(auth): Auth.js v5 Cognito provider (edge-safe split) + handlers"
```

### Task 1.4: Route protection via proxy.ts

**Files:**
- Create: `dashboard/proxy.ts`

**Interfaces:**
- Consumes: `authConfig`, `permissionsForRoles`, `canAccessPage`, `allowedPages`.

- [ ] **Step 1: Write `dashboard/proxy.ts`**

```typescript
// Next.js 16 middleware (renamed to proxy.ts). Runs on the edge.
// Layer 1 of defense in depth: redirect unauthenticated users to /login, and
// redirect authenticated-but-unauthorized PAGE access to their first allowed
// page (or /403). API routes self-enforce (layer 2) and are left to pass.
import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "./auth.config";
import { permissionsForRoles, canAccessPage, allowedPages } from "@/lib/rbac";

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const { pathname } = req.nextUrl;

  // Always let Auth.js endpoints and the public pages through.
  if (pathname.startsWith("/api/auth") || pathname === "/login" || pathname === "/403") {
    return;
  }

  if (!req.auth) {
    const url = new URL("/login", req.nextUrl.origin);
    url.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  // API routes enforce their own tool/route permission (layer 2).
  if (pathname.startsWith("/api")) return;

  const perms = permissionsForRoles(req.auth.user?.roles ?? []);
  if (!canAccessPage(perms, pathname)) {
    const home = allowedPages(perms)[0];
    return NextResponse.redirect(new URL(home ?? "/403", req.nextUrl.origin));
  }
});

export const config = {
  // Run on everything except static assets and image optimizer.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
```

- [ ] **Step 2: Build to confirm Next 16 accepts proxy.ts**

Run: `cd dashboard && npx next build 2>&1 | tail -30`
Expected: build completes; NO error like `The Proxy file "/proxy" must export a function named 'proxy' or a default function`. (If that error appears, the default export is the fix — it is present here.)

- [ ] **Step 3: Commit**

```bash
git add dashboard/proxy.ts
git commit -m "feat(auth): proxy.ts route protection + page-level RBAC redirect"
```

### Task 1.5: Server session helpers + tests

**Files:**
- Create: `dashboard/src/lib/session.ts`, `dashboard/src/lib/session.test.ts`

**Interfaces:**
- Produces: `forbidden()`, `unauthorized()` (Response builders), `denyTool(roles, tool): Response | null`, `denyPerm(roles, perm): Response | null`. (Pure deny-helpers take roles so they're unit-testable without mocking `auth()`.)

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/src/lib/session.test.ts
import { describe, it, expect } from "vitest";
import { denyTool, denyPerm } from "./session";

describe("session deny-helpers", () => {
  it("returns a 403 Response when role lacks the tool", async () => {
    const res = denyTool(["realestate-viewer"], "query_finances");
    expect(res?.status).toBe(403);
  });
  it("returns null (allowed) when role has the tool", () => {
    expect(denyTool(["admin"], "query_finances")).toBeNull();
    expect(denyTool(["realestate-viewer"], "get_optimizer_plan")).not.toBeNull();
  });
  it("denyPerm gates a raw permission", () => {
    expect(denyPerm(["realestate-viewer"], "realestate:read")).toBeNull();
    expect(denyPerm(["realestate-viewer"], "transactions:read")?.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd dashboard && npx vitest run src/lib/session.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `session.ts`**

```typescript
// dashboard/src/lib/session.ts
import { auth } from "@/auth";
import { permissionsForRoles, canUseTool, can, type Permission } from "@/lib/rbac";

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
export function forbidden(): Response {
  return Response.json({ error: "forbidden" }, { status: 403 });
}

/** Pure: returns a 403 Response if `roles` cannot use `tool`, else null. */
export function denyTool(roles: string[], tool: string): Response | null {
  return canUseTool(permissionsForRoles(roles), tool) ? null : forbidden();
}
/** Pure: returns a 403 Response if `roles` lacks `perm`, else null. */
export function denyPerm(roles: string[], perm: Permission): Response | null {
  return can(permissionsForRoles(roles), perm) ? null : forbidden();
}

/** Resolve the caller's roles from the session, or null if unauthenticated. */
export async function callerRoles(): Promise<string[] | null> {
  const session = await auth();
  if (!session?.user) return null;
  return session.user.roles ?? [];
}
```

- [ ] **Step 4: Run tests to confirm green**

Run: `cd dashboard && npx vitest run src/lib/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/session.ts dashboard/src/lib/session.test.ts
git commit -m "feat(auth): server session deny-helpers with tests"
```

---

## PHASE 2 — Wire RBAC into the app

### Task 2.1: MCP proxy — bearer header + tool RBAC

**Files:**
- Modify: `dashboard/src/lib/mcp.ts`, `dashboard/src/app/api/mcp/[tool]/route.ts`

- [ ] **Step 1: Attach bearer in `mcp.ts`** — change the `connect()` function (lines 5, 10-14) to:

```typescript
const MCP_URL = process.env.MCP_URL ?? "http://localhost:8000/mcp";
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";

// ...
async function connect(): Promise<Client> {
  const client = new Client({ name: "finance-dashboard", version: "1.0.0" });
  const requestInit: RequestInit | undefined = MCP_AUTH_TOKEN
    ? { headers: { Authorization: `Bearer ${MCP_AUTH_TOKEN}` } }
    : undefined;
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit }));
  return client;
}
```

- [ ] **Step 2: Gate the route** — replace `dashboard/src/app/api/mcp/[tool]/route.ts` with:

```typescript
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
      { error: `MCP server unreachable or call failed: ${e instanceof Error ? e.message : e}`, service: "mcp" },
      { status: 502 },
    );
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/lib/mcp.ts "dashboard/src/app/api/mcp/[tool]/route.ts"
git commit -m "feat(auth): MCP proxy attaches bearer + enforces per-tool RBAC"
```

### Task 2.2: Real-estate API RBAC

**Files:**
- Modify: `dashboard/src/app/api/realestate/deals/route.ts`, `dashboard/src/app/api/realestate/deals/[id]/route.ts`

- [ ] **Step 1: Gate GET (read)** — at the top of `GET()` in `deals/route.ts`, after the existing imports add `import { callerRoles, unauthorized, denyPerm } from "@/lib/session";` and insert:

```typescript
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
```

- [ ] **Step 2: Gate PUT + DELETE (write)** — in `deals/[id]/route.ts` add `import { callerRoles, unauthorized, denyPerm } from "@/lib/session";` and, as the first lines inside BOTH `PUT` and `DELETE` (after `const { id } = await ctx.params;`):

```typescript
  const roles = await callerRoles();
  if (roles === null) return unauthorized();
  const denied = denyPerm(roles, "realestate:write");
  if (denied) return denied;
```

- [ ] **Step 3: Typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/app/api/realestate
git commit -m "feat(auth): real-estate APIs require realestate:read (GET) / :write (PUT,DELETE)"
```

### Task 2.3: Link proxy — admin only

**Files:**
- Modify: `dashboard/src/app/api/link/[...path]/route.ts`

- [ ] **Step 1: Gate the proxy** — add `import { callerRoles, unauthorized, denyPerm } from "@/lib/session";` and at the top of `proxy()` (before resolving the route):

```typescript
async function proxy(req: Request, ctx: Ctx, method: "GET" | "POST") {
  const roles = await callerRoles();
  if (roles === null) return unauthorized();
  const denied = denyPerm(roles, "connections:manage");
  if (denied) return denied;
  const { path } = await ctx.params;
  // ...unchanged
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd dashboard && npx tsc --noEmit`
```bash
git add "dashboard/src/app/api/link/[...path]/route.ts"
git commit -m "feat(auth): link_helper proxy is admin-only (connections:manage)"
```

### Task 2.4: Client session provider + layout

**Files:**
- Create: `dashboard/src/components/session-provider.tsx`
- Modify: `dashboard/src/app/layout.tsx`

- [ ] **Step 1: Provider wrapper** — `dashboard/src/components/session-provider.tsx`

```typescript
"use client";
import { SessionProvider } from "next-auth/react";
export function AuthSessionProvider({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
```

- [ ] **Step 2: Wrap the app** — in `dashboard/src/app/layout.tsx`, import the provider and wrap `<AppShell>`:

```typescript
import { AuthSessionProvider } from "@/components/session-provider";
// ...
<body className="min-h-screen antialiased">
  <AuthSessionProvider>
    <ThemeProvider>
      <AppShell>{children}</AppShell>
    </ThemeProvider>
  </AuthSessionProvider>
</body>
```

- [ ] **Step 3: Typecheck + commit**

Run: `cd dashboard && npx tsc --noEmit`
```bash
git add dashboard/src/components/session-provider.tsx dashboard/src/app/layout.tsx
git commit -m "feat(auth): wrap app in Auth.js SessionProvider"
```

### Task 2.5: Nav filtering + user menu + MCP-based sync

**Files:**
- Modify: `dashboard/src/components/app-shell.tsx`, `dashboard/src/components/command-palette.tsx`

- [ ] **Step 1: Filter nav + repoint sync in `app-shell.tsx`.** Add imports:

```typescript
import { useSession, signOut } from "next-auth/react";
import { permissionsForRoles, allowedPages } from "@/lib/rbac";
import { callTool } from "@/lib/api";
```

Inside `AppShell()`, derive the user's allowed nav and admin status:

```typescript
  const { data: session } = useSession();
  const roles = session?.user?.roles ?? [];
  const perms = permissionsForRoles(roles);
  const allowed = new Set(allowedPages(perms));
  const isAdminUser = perms.has("*");
  const visibleNav = NAV.filter((n) => allowed.has(n.href));
```

Then replace `NAV.filter((n) => n.group === group)` with `visibleNav.filter((n) => n.group === group)` in `navBody`.

- [ ] **Step 2: Replace link_helper sync with MCP `sync_now`.** Change `runSync` to call the MCP tool (works in cloud; admin-gated by the API anyway) and drop `useLinkStatus`:

```typescript
  const runSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true); setToast(null);
    try {
      const d = await callTool<{ total_transactions_stored?: number; warnings?: unknown[] }>("sync_now");
      const ok = !(d.warnings && d.warnings.length);
      setToast({ ok, text: ok ? `Synced · ${d.total_transactions_stored ?? 0} transactions stored` : "Sync finished with issues" });
      await mutate(() => true, undefined, { revalidate: true });
    } catch (e) {
      setToast({ ok: false, text: e instanceof Error ? e.message : "Sync failed" });
    } finally { setSyncing(false); }
  }, [syncing, mutate]);
```

Replace the `status`/`lastSync` block: use `useTool<{ items?: { last_synced_at?: string|null }[] }>(isAdminUser ? "get_sync_status" : "")` and derive `lastSync` from it (mirror the existing `.map().filter().sort().pop()` over whatever field `get_sync_status` returns; inspect its shape during execution and adapt). Only render the Sync button when `isAdminUser` (or `perms.has("sync:run")`).

- [ ] **Step 3: Add a user menu + sign-out** in the header (next to the theme toggle):

```tsx
{session?.user && (
  <div className="hidden items-center gap-2 sm:flex">
    <span className="max-w-[160px] truncate text-[12px] text-mut">{session.user.email}</span>
    <Button variant="ghost" onClick={() => signOut({ callbackUrl: "/login" })}>Sign out</Button>
  </div>
)}
```

- [ ] **Step 4: Filter the command palette.** In `command-palette.tsx`, import `useSession`, `permissionsForRoles`, `allowedPages` and filter the `NAV.map(...)` source to only allowed hrefs (mirror Step 1). (Read the file first; apply the same `allowed.has(n.href)` filter to the nav commands array, and gate the "Sync" command on admin.)

- [ ] **Step 5: Build + commit**

Run: `cd dashboard && npx next build 2>&1 | tail -20`
Expected: build succeeds.
```bash
git add dashboard/src/components/app-shell.tsx dashboard/src/components/command-palette.tsx
git commit -m "feat(auth): filter nav/palette by permissions; sync via MCP; user menu + sign-out"
```

### Task 2.6: Context strip scoping + login + 403 pages

**Files:**
- Modify: `dashboard/src/components/realestate/context-strip.tsx`
- Create: `dashboard/src/app/login/page.tsx`, `dashboard/src/app/403/page.tsx`

- [ ] **Step 1: Hide the strip when scope is missing.** At the top of `ContextStrip()` (before the `useTool` calls), add:

```typescript
import { useSession } from "next-auth/react";
import { permissionsForRoles, can } from "@/lib/rbac";
// ...inside ContextStrip, first lines:
  const { data: session } = useSession();
  const perms = permissionsForRoles(session?.user?.roles ?? []);
  const canSeeContext = can(perms, "networth:read") && can(perms, "investments:read");
  if (!canSeeContext) return null; // real-estate-only viewers never see live portfolio
```

(Keep the existing `useTool` hooks AFTER this guard so they aren't called for viewers — early return is before the hooks; move the guard to the very top so no hooks run. If lint complains about conditional hooks, instead render `null` by wrapping the JSX and passing a `skip` tool name `useTool(canSeeContext ? "get_net_worth_history" : "")` — choose whichever keeps the Rules of Hooks satisfied. Prefer the skip-token form to avoid conditional hook calls.)

Concretely, use the skip-token form:
```typescript
  const nw = useTool<NetWorthHistory>(canSeeContext ? "get_net_worth_history" : "");
  const pf = useTool<Portfolio>(canSeeContext ? "get_portfolio_analysis" : "");
  if (!canSeeContext) return null;
```

- [ ] **Step 2: Login page** — `dashboard/src/app/login/page.tsx`

```tsx
import { signIn } from "@/auth";

export default function LoginPage() {
  return (
    <div className="grid min-h-screen place-items-center bg-bg px-6">
      <div className="w-full max-w-sm rounded-[var(--radius-lg)] border border-line bg-card p-8 text-center shadow-[var(--shadow-sm)]">
        <h1 className="text-lg font-semibold tracking-tight text-txt">Vault · Personal Finance</h1>
        <p className="mt-2 text-sm text-mut">Sign in to continue. Access is invitation-only.</p>
        <form
          action={async () => { "use server"; await signIn("cognito", { redirectTo: "/" }); }}
          className="mt-6"
        >
          <button className="w-full rounded-[var(--radius)] bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90">
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 403 page** — `dashboard/src/app/403/page.tsx`

```tsx
import Link from "next/link";
export default function Forbidden() {
  return (
    <div className="grid min-h-[60vh] place-items-center text-center">
      <div>
        <h1 className="text-lg font-semibold text-txt">No access</h1>
        <p className="mt-2 text-sm text-mut">Your account doesn’t have permission for this page.</p>
        <Link href="/" className="mt-4 inline-block text-sm text-accent">Back to start</Link>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Build + commit**

Run: `cd dashboard && npx next build 2>&1 | tail -20`
Expected: success.
```bash
git add dashboard/src/components/realestate/context-strip.tsx dashboard/src/app/login dashboard/src/app/403
git commit -m "feat(auth): scope context strip to portfolio perms; add login + 403 pages"
```

### Task 2.7: Env example + full test run

**Files:**
- Modify: `dashboard/.env.local.example`

- [ ] **Step 1: Document env** — append to `dashboard/.env.local.example`:

```
# --- Auth (Cognito via Auth.js v5) ---
AUTH_SECRET=                 # generate: npx auth secret  (or openssl rand -base64 33)
AUTH_URL=http://localhost:3000
AUTH_COGNITO_ID=             # from deploy/setup_cognito.sh
AUTH_COGNITO_SECRET=
AUTH_COGNITO_ISSUER=https://cognito-idp.us-east-1.amazonaws.com/<USER_POOL_ID>
COGNITO_HOSTED_DOMAIN=https://<prefix>.auth.us-east-1.amazoncognito.com

# --- MCP server (remote, bearer-gated) ---
MCP_URL=https://3a6q4qkjrmx5ewdazow7objvmu0uktgz.lambda-url.us-east-1.on.aws/mcp
MCP_AUTH_TOKEN=              # same token as SSM /personal-finance-mcp/config
```

- [ ] **Step 2: Run the full dashboard suite + the python contract guard**

Run: `cd dashboard && npm test`
Expected: rbac + session tests pass; existing suite still green.

Run: `cd /Users/hrishikeshkakkad/Documents/agentic-poc && .venv/bin/python -m pytest tests/test_dashboard_contract.py -q`
Expected: PASS (tool allowlist unchanged).

- [ ] **Step 3: Commit**

```bash
git add dashboard/.env.local.example
git commit -m "docs(dashboard): document Cognito + MCP env vars"
```

---

## PHASE 3 — Vercel deployment

### Task 3.1: Vercel project + function config

**Files:**
- Create: `dashboard/vercel.json`

- [ ] **Step 1: Function duration config** — `dashboard/vercel.json`

```json
{
  "functions": {
    "src/app/api/mcp/[tool]/route.ts": { "maxDuration": 60 }
  }
}
```

- [ ] **Step 2: Link/create the Vercel project** (root = dashboard)

Run: `cd dashboard && vercel link --yes`
Then set the project's Root Directory to `dashboard` if prompted (the repo root is the Python project). Confirm framework = Next.js.
Expected: a `.vercel/project.json` is created; note the project name + the stable production domain `https://<project>.vercel.app`.

- [ ] **Step 3: Commit the config (not .vercel)**

Ensure `.vercel` is gitignored (Vercel adds it). Then:
```bash
git add dashboard/vercel.json
git commit -m "build(vercel): maxDuration for MCP proxy route"
```

### Task 3.2: Provision Cognito with the real domain, set env, deploy

- [ ] **Step 1: Run Cognito setup with the Vercel prod domain**

Run: `CALLBACK_BASE="https://<project>.vercel.app" ./deploy/setup_cognito.sh`
Expected: prints `AUTH_COGNITO_ID/SECRET/ISSUER`, `COGNITO_HOSTED_DOMAIN`, and `USER_POOL_ID`. Save these.

- [ ] **Step 2: Generate AUTH_SECRET**

Run: `cd dashboard && npx auth secret` (or `openssl rand -base64 33`). Save the value.

- [ ] **Step 3: Read MCP_AUTH_TOKEN + DATABASE_URL from local config**

Run: `grep -E '^(MCP_AUTH_TOKEN|DATABASE_URL)=' /Users/hrishikeshkakkad/Documents/agentic-poc/.env`
(If `MCP_AUTH_TOKEN` isn't in `.env`, read it from SSM: `aws ssm get-parameter --name /personal-finance-mcp/config --with-decryption --query 'Parameter.Value' --output text | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["MCP_AUTH_TOKEN"]);print(d["DATABASE_URL"])'`.)

- [ ] **Step 4: Push all env vars to Vercel (Production)**

For each var, run `vercel env add <NAME> production` and paste the value (so secrets never hit shell history/argv):
`AUTH_SECRET`, `AUTH_URL` (=`https://<project>.vercel.app`), `AUTH_COGNITO_ID`, `AUTH_COGNITO_SECRET`, `AUTH_COGNITO_ISSUER`, `COGNITO_HOSTED_DOMAIN`, `MCP_URL` (=`…lambda-url…/mcp`), `MCP_AUTH_TOKEN`, `DATABASE_URL`.
Expected: `vercel env ls production` lists all nine; none prefixed `NEXT_PUBLIC_`.

- [ ] **Step 5: Set the functions region to iad1**

In Vercel project settings (or `vercel.json` `"regions": ["iad1"]`), set deployment region `iad1` to co-locate with Lambda + Neon.

- [ ] **Step 6: Deploy production**

Run: `cd dashboard && vercel --prod`
Expected: a production deployment URL; build succeeds (legacy-peer-deps via `.npmrc`).

- [ ] **Step 7: Smoke — unauthenticated must redirect to /login**

Run: `curl -sI "https://<project>.vercel.app/" | grep -i location`
Expected: a redirect to `/login` (or the Cognito Hosted UI). The home page must NOT render data unauthenticated.

---

## PHASE 4 — End-to-end verification

### Task 4.1: Admin login

- [ ] **Step 1: Invite yourself as admin**

Run: `USER_POOL_ID=<pool> ./deploy/invite.sh hrishidkakkad@gmail.com admin`
Expected: email with a temporary password.

- [ ] **Step 2: Log in via the browser** (Hosted UI), set a new password, land on `/`.
Expected: all 11 nav items visible; Overview, transactions, net worth, real estate all load data (proves the bearer reaches the MCP server and Neon is reachable). The header Sync button triggers `sync_now` successfully.

### Task 4.2: Father as realestate-viewer — the RBAC proof

- [ ] **Step 1: Invite the viewer**

Run: `USER_POOL_ID=<pool> ./deploy/invite.sh <father-email> realestate-viewer`

- [ ] **Step 2: Log in as the viewer.**
Expected: nav shows ONLY "Real estate"; landing redirects to `/real-estate`; the deal model loads and recomputes live; the live-portfolio **context strip is absent**; there is no Sync button.

- [ ] **Step 3: Verify the server actually denies (not just hides).** While logged in as the viewer, in the browser devtools console run:

```js
await fetch("/api/mcp/query_finances", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({args:{sql:"SELECT 1"}})}).then(r=>r.status)
await fetch("/api/mcp/get_portfolio_analysis", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({args:{}})}).then(r=>r.status)
await fetch("/api/realestate/deals").then(r=>r.status)
```
Expected: `403`, `403`, `200`. (The first two prove tool-level denial; the third proves the allowed scope still works.)

- [ ] **Step 4: Verify a direct page hit is gated.** Visit `https://<project>.vercel.app/transactions` as the viewer.
Expected: redirected away (to `/real-estate` or `/403`), never the transactions UI.

---

## PHASE 5 — Hardening + docs

### Task 5.1: Optional MCP token rotation

- [ ] **Step 1 (optional):** Rotate `MCP_AUTH_TOKEN` now that Vercel also holds it. Generate a new token, update SSM `/personal-finance-mcp/config` AND the claude.ai connector AND the Vercel env together, redeploy the MCP Lambda env (`deploy/deploy.sh` env path) and Vercel. Skip if not desired. Document either way.

### Task 5.2: Documentation

**Files:**
- Modify: `CLAUDE.md`, `dashboard/README.md`

- [ ] **Step 1:** Add an "Auth & RBAC" section to `dashboard/README.md`: the role→permission model, how to invite (`deploy/invite.sh`), where the gate lives (`src/lib/rbac.ts` + API routes + `proxy.ts`), and the `/transactions` admin-only caveat.
- [ ] **Step 2:** Add a short note to `CLAUDE.md` under Architecture: the dashboard is now Cognito-gated on Vercel; RBAC is enforced in the Next.js layer; the MCP server remains single-token by design.
- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md dashboard/README.md
git commit -m "docs: document Cognito auth + page RBAC model"
```

---

## Self-Review

**Spec coverage:** Cognito pool/invite (Phase 0, 4) ✓; role-bundle RBAC map (1.2) ✓; Auth.js + Hosted UI (1.3) ✓; 3-layer enforcement — proxy (1.4) + API (2.1-2.3) + nav/strip (2.5-2.6) ✓; MCP bearer header (2.1) ✓; context-strip scoping (2.6) ✓; `/connections` admin-only + cloud sync via MCP (2.3, 2.5) ✓; Vercel deploy + env (3) ✓; free-tier (maxDuration 60s, Cognito groups) ✓; tests (1.2, 1.5, 2.7) ✓; docs (5.2) ✓; `query_finances` admin-only (1.2) ✓.

**Placeholder scan:** Deploy-time parameters (`<project>`, `<pool>`, `<father-email>`) are inputs, not undecided design. Two spots require reading a file's exact shape at execution (`get_sync_status` field in 2.5; command-palette nav array in 2.5 Step 4) — these are flagged with explicit "read first" instructions and the transformation to apply, not left vague.

**Type consistency:** `permissionsForRoles → Set<string>` consumed by `can`/`canUseTool`/`canAccessPage`/`allowedPages` (1.2); `callerRoles(): string[]|null`, `denyTool/denyPerm(roles,…): Response|null` (1.5) consumed identically in 2.1-2.3; session shape `session.user.roles: string[]` defined in types (1.3) and read in proxy (1.4) + components (2.5, 2.6). Consistent.
