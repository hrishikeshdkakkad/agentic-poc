# Cognito OAuth + Page-Level RBAC + Vercel Deployment — Design

**Date:** 2026-06-19
**Status:** Approved (decisions locked) — ready for implementation plan
**Author:** Claude (brainstormed with Hrishikesh)

## Goal

Take the personal-finance system from its current **single-tenant, shared-bearer-token** posture to an **invitation-only, AWS-Cognito-authenticated, page-level-RBAC** system that the owner can use **remotely** (not from local). Constraints:

- MCP server + scheduled sync stay on **AWS Lambda** (free tier).
- Frontend (Next.js dashboard) deployed on **Vercel** (Hobby / free).
- **Highly secure**, **invitation-only** sign-in.
- **Per-page RBAC**: e.g. inviting "father" grants only `/real-estate`, nothing else.
- Net new cost ≈ **$0**.

## Locked decisions (from brainstorming)

1. **RBAC model = role bundles.** Cognito Groups are roles; a single version-controlled map turns roles into fine-grained permissions. `admin` + `realestate-viewer` to start; new roles = one config entry.
2. **Invitations = local CLI script.** No AWS credentials ever stored on Vercel. `deploy/invite.sh <email> <role>` runs `admin-create-user` + `admin-add-user-to-group`.
3. **MFA = off for v1.** Strong password policy + forced temp-password change on first login. MFA is a later pool-setting flip, no code change.

## Current state (verified)

- **AWS** account `471112572248`, region `us-east-1`.
  - `personal-finance-mcp` Lambda — public Function URL `https://3a6q4qkjrmx5ewdazow7objvmu0uktgz.lambda-url.us-east-1.on.aws/`, `AuthType: NONE`, gated only by a shared bearer token (`Authorization: Bearer <MCP_AUTH_TOKEN>` **or** `/t/<token>/mcp` path for claude.ai).
  - `personal-finance-mcp-sync` Lambda — EventBridge schedule `rate(4 hours)`, no URL.
  - Secrets in SSM `/personal-finance-mcp/config` (JSON: `PLAID_CLIENT_ID/SECRET/ENV`, `DATABASE_URL`, `FERNET_KEY`, `MCP_AUTH_TOKEN`) under CMK `alias/personal-finance-mcp` whose key policy **denies all principals except root + the two function roles**.
  - An unrelated Cognito pool `us-east-1_AW88ON1sT` ("expenseForce-dev") exists — **do not touch it**.
- **Dashboard** (`dashboard/`): Next.js 16.2.9, React 19, App Router. **No auth at all.** 11 pages. Browser → Next.js API routes → upstreams:
  - `/api/mcp/[tool]` → MCP server at `MCP_URL` (default `http://localhost:8000/mcp`), **no bearer attached today** (localhost assumption). Tool allowlist in `src/lib/tools.ts`.
  - `/api/link/[...path]` → `link_helper` at `LINK_HELPER_URL` (localhost:8765) — **local-only service** (refuses to run when `HORIZON` is set; holds Plaid tokens; never deployed).
  - `/api/realestate/deals[/id]` → Neon directly via `DATABASE_URL` (`src/lib/realestate/db.ts`).
  - All secrets are server-only; **no `NEXT_PUBLIC_` leaks**. `.env.local` is gitignored and untracked.
  - Nav is defined in `src/components/nav.tsx` (`NAV` array); also consumed by `command-palette.tsx`.
  - **`/real-estate` is not self-contained**: `src/components/realestate/context-strip.tsx:56-57` calls `get_net_worth_history` + `get_portfolio_analysis` to show the owner's live net worth / portfolio. This must be scoped away from a real-estate-only viewer.
- **Vercel**: authed as `hrishikeshdkakkad`, team `hrishikeshdkakkads-projects`. Dashboard **not yet deployed** as its own project.

## Architecture — the security seam

```
Browser ──(httpOnly session cookie)──> Vercel: Next.js
                                          │  (1) middleware: no session → Cognito Hosted UI (invite-only)
                                          │  (2) API route: verify Cognito identity → map roles→permissions
                                          │        → 403 if requested tool/route not permitted   ← RBAC ENFORCED HERE
                                          │  (3) if allowed, attach server-only Bearer token
                                          ▼
                       MCP Lambda Function URL (unchanged, bearer-gated)  +  Neon (real_estate_deals)
```

**RBAC is enforced in the Next.js server layer, NOT the MCP server.** The MCP server stays single-token / full-access by design (also used by the claude.ai connector). The Next.js server holds the bearer token server-side and decides, per authenticated user, whether to forward each call. The browser never holds the MCP token or Neon creds.

Auth via **Cognito Hosted UI + Auth.js v5 (NextAuth)** — OAuth2 authorization-code + PKCE, confidential client. AWS hosts the login page (no custom login UI to secure; password reset / future MFA for free).

## Component A — Cognito

New, dedicated **User Pool** `personal-finance-mcp`:
- `AdminCreateUserConfig.AllowAdminCreateUserOnly = true` (invitation-only; no public signup).
- Username = email; `email` as the sign-in attribute, `email_verified` set true on invite.
- Password policy: min length 12, require upper/lower/number/symbol.
- MFA: `OFF` (v1). Token revocation: ON. "Prevent user existence errors": ON.
- Account recovery: email.
- Email: Cognito default sender (free; ~50/day cap — fine for family). SES not needed for v1.
- Hosted UI **domain** (Cognito-provided prefix, e.g. `pf-mcp-<suffix>.auth.us-east-1.amazoncognito.com`).

**App client** `personal-finance-dashboard` (confidential):
- Generate client secret (held server-side by Next.js).
- OAuth flows: authorization code grant. Scopes: `openid email profile`.
- Callback URLs: `https://<vercel-prod-domain>/api/auth/callback/cognito` + `http://localhost:3000/api/auth/callback/cognito` (dev).
- Sign-out URLs: `https://<vercel-prod-domain>/` + `http://localhost:3000/`.

**Groups (roles):** `admin` (precedence 0), `realestate-viewer` (precedence 10). Membership rides in tokens as `cognito:groups`.

**Provisioning script** `deploy/setup_cognito.sh` — idempotent (create-or-reuse pool, domain, client, groups), mirrors the style of `deploy/setup_security.sh`. Prints the values needed for Vercel env (pool id, client id, client secret, issuer URL, hosted domain).

**Invite CLI** `deploy/invite.sh <email> <role>`:
- `aws cognito-idp admin-create-user --user-pool-id <id> --username <email> --user-attributes Name=email,Value=<email> Name=email_verified,Value=true --desired-delivery-mediums EMAIL`
- `aws cognito-idp admin-add-user-to-group --user-pool-id <id> --username <email> --group-name <role>`
- Companion helpers: `deploy/list_users.sh`, `deploy/revoke.sh <email>` (remove from group / disable / delete).

## Component B — Permission model (`dashboard/src/lib/rbac.ts`)

Single source of truth, three maps + a resolver. Security-critical → covered by tests first (TDD).

**Permissions (scopes):** `overview:read`, `transactions:read`, `spending:read`, `cashflow:read`, `accounts:read`, `networth:read`, `investments:read`, `debt:read`, `realestate:read`, `realestate:write`, `plan:read`, `connections:manage`, `corrections:write`, `sync:run`, and the wildcard `*`.

**Roles → permissions:**
- `admin` → `["*"]`
- `realestate-viewer` → `["realestate:read"]`

**Page → required permission:**

| Page | Permission |
|---|---|
| `/` | `overview:read` |
| `/transactions` | `transactions:read` |
| `/spending` | `spending:read` |
| `/cash-flow` | `cashflow:read` |
| `/accounts` | `accounts:read` |
| `/net-worth` | `networth:read` |
| `/investments` | `investments:read` |
| `/debt` | `debt:read` |
| `/real-estate` | `realestate:read` |
| `/plan` | `plan:read` |
| `/connections` | `connections:manage` |

**MCP tool → required permission** (deny-by-default; unknown tool → refused):

| Tool(s) | Permission |
|---|---|
| `list_accounts`, `get_balances` | `accounts:read` |
| `get_transactions`, `list_transactions`, `search_transactions`, `get_merchant_profile`, `list_category_overrides` | `transactions:read` |
| `aggregate_spending`, `compare_periods` | `spending:read` |
| `get_income_analysis`, `get_recurring_transactions`, `get_recurring_analysis` | `cashflow:read` |
| `get_net_worth`, `get_net_worth_history`, `get_net_worth_trajectory` | `networth:read` |
| `get_investment_holdings`, `get_investment_transactions`, `list_investment_transactions`, `get_portfolio_analysis` | `investments:read` |
| `get_liabilities`, `get_debt_analysis` | `debt:read` |
| `get_optimizer_score`, `get_optimizer_plan` | `plan:read` |
| `get_financial_health` | `overview:read` |
| `get_sync_status`, `get_institutions_status` | `connections:manage` |
| `sync_now` | `sync:run` |
| `set_category_override`, `set_manual_balance` | `corrections:write` |
| `query_finances`, `describe_tables` | **`admin` only** |

**Critical rulings (non-obvious):**
- **`query_finances`/`describe_tables` are admin-only.** They run arbitrary read-only SQL and therefore cannot be safely scoped to a single page's permission (raw SQL ignores page boundaries). Consequence: the `/transactions` page (which builds raw SQL via `query_finances`) is **admin-tier in v1**. Acceptable because the only v1 viewer role is `realestate-viewer`. To later support a "transactions-only" viewer, the transactions page must be refactored to use structured tools instead of raw SQL — documented, not done now.
- **`/real-estate` needs two scopes.** The deal model (Neon `real_estate_deals`) needs `realestate:read`; the live context strip needs `networth:read` + `investments:read`. A `realestate-viewer` has only the first, so the strip is hidden client-side **and** its tools are denied server-side.
- **Real-estate read vs write.** `realestate:read` = GET deals + use the live client-side calculator (harmless, not persisted). `realestate:write` = PUT/DELETE to Neon (admin). The father can explore every lever but cannot overwrite the owner's saved deals.

**Resolver:** `permissionsForRoles(roles: string[]): Set<string>` (expands `*`); `can(perms, required): boolean`; `pagesFor(perms): string[]`; `requiredPermissionForTool(tool): string | "admin" | null`.

## Component C — Enforcement (defense in depth, 3 layers)

1. **Edge middleware** (`dashboard/src/middleware.ts`): no session → redirect to Hosted UI. Authenticated but lacking the page's permission → redirect to the user's first allowed page (or `/403`). Matcher excludes `/api/auth/*`, static assets, `/_next/*`. (UX layer.)
2. **API-route RBAC (the real gate):** every `/api/**` handler calls a shared `requirePermission(...)` that reads the verified session (`auth()`), resolves permissions, and returns **403** before any upstream call:
   - `/api/mcp/[tool]` → enforce existing `ALLOWED_TOOLS` allowlist **and** `requiredPermissionForTool(tool)` (admin tools require admin); then attach bearer and forward.
   - `/api/realestate/deals` → GET requires `realestate:read`; `/api/realestate/deals/[id]` PUT/DELETE require `realestate:write`.
   - `/api/link/[...path]` → `connections:manage` (admin) + graceful handling when `LINK_HELPER_URL` is unreachable.
3. **Nav + component filtering** (cosmetic): `nav.tsx`, `command-palette.tsx`, and `context-strip.tsx` render only what the session's permissions allow. Driven by `useSession().data.permissions` via Auth.js `<SessionProvider>`.

Layers 1 & 3 are UX; **layer 2 is security.** A viewer crafting `fetch('/api/mcp/query_finances')` gets a 403.

## Component D — Auth.js wiring & data plane

- `dashboard/auth.ts`: `NextAuth({ providers: [Cognito({ clientId, clientSecret, issuer })], session: { strategy: "jwt" }, callbacks })`.
  - `jwt` callback: on sign-in read `profile["cognito:groups"]` → `roles`; compute `permissions = [...permissionsForRoles(roles)]`; store both on the token.
  - `session` callback: expose `session.user.roles` and `session.user.permissions`.
- `dashboard/src/app/api/auth/[...nextauth]/route.ts`: `export const { GET, POST } = handlers`.
- `dashboard/src/lib/session.ts`: server helpers `getSessionPermissions()`, `requirePermission(perm)`, `requireToolPermission(tool)` returning 403 responses.
- **MCP proxy** (`src/app/api/mcp/[tool]/route.ts` + `src/lib/mcp.ts`): attach `Authorization: Bearer ${process.env.MCP_AUTH_TOKEN}` to the upstream MCP transport (`StreamableHTTPClientTransport` `requestInit.headers`). Fallback if header passing is awkward with the TS SDK: use the path form `MCP_URL=<functionUrl>/t/<token>/mcp`.
- **Sign-out**: Auth.js `signOut` clears the cookie; optionally redirect to the Cognito logout endpoint to end the Hosted UI session.

**`/connections` reality:** admin-only. Plaid *linking* stays local-only by design (tokens never leave the machine). Deployed `/connections` shows **sync status** (`get_sync_status`/`get_institutions_status`) and a **Sync now** button (`sync_now`) — all via the deployed MCP server — while link/relink/CSV-import actions display "run locally." Daily data freshness is unaffected (Lambda syncs 6×/day).

## Component E — Deployment

**AWS:** run `deploy/setup_cognito.sh` (idempotent). Cognito app-client creds are not data secrets → they go to Vercel env, not the CMK/SSM vault.

**Vercel:** new project, **root directory `dashboard/`**, framework Next.js, functions region `iad1` (co-located with Lambda + Neon). A small `dashboard/vercel.json` raises `maxDuration` on `/api/mcp/[tool]` (the `/` overview's `get_net_worth` runs ~36s).

**Vercel env (Production + Preview, all server-only):**
- `MCP_URL` = `https://3a6q4qkjrmx5ewdazow7objvmu0uktgz.lambda-url.us-east-1.on.aws/mcp`
- `MCP_AUTH_TOKEN` = (from SSM/.env)
- `DATABASE_URL` = Neon connection string
- `AUTH_SECRET` = freshly generated
- `AUTH_COGNITO_ID`, `AUTH_COGNITO_SECRET`, `AUTH_COGNITO_ISSUER` (`https://cognito-idp.us-east-1.amazonaws.com/<poolId>`)
- `AUTH_URL` = `https://<vercel-prod-domain>`
- `COGNITO_HOSTED_DOMAIN` (for logout)
- (`LINK_HELPER_URL` intentionally unset in cloud.)

**Order of operations** (resolves the callback-URL chicken-and-egg):
1. Create the Vercel project (root `dashboard/`); learn the stable `*.vercel.app` production domain.
2. `deploy/setup_cognito.sh` using that domain for callback/sign-out URLs.
3. Set Vercel env vars.
4. Deploy (`vercel --prod`).
5. `deploy/invite.sh <owner-email> admin`; log in; verify.
6. `deploy/invite.sh <father-email> realestate-viewer`; verify he sees only `/real-estate`, no context strip, cannot persist, and `/api/mcp/query_finances` returns 403.

## Security posture

- Invitation-only pool (no public signup); strong password + forced first-login change; token revocation; prevent-user-existence-errors.
- Confidential OAuth client (secret server-side); authorization-code + PKCE; httpOnly/secure/sameSite cookies (Auth.js defaults on HTTPS).
- Deny-by-default API RBAC; raw SQL locked to admin; mutations admin-only.
- MCP bearer token + Neon creds server-only; never shipped to the browser.
- Two independent enforcement layers (middleware + API).
- Consider rotating `MCP_AUTH_TOKEN` now that the Vercel server also holds it (optional; update SSM + Vercel together).
- Vercel Deployment Protection: rely on Cognito for production; ensure middleware also covers preview deployments (it does).

## Cost

Cognito free tier (≤10k MAU) covers family use; Vercel Hobby free; Lambda/SSM/Neon unchanged; CMK $1/mo already counted. **Net new ≈ $0.**

## Testing

- `dashboard/src/lib/rbac.test.ts` (vitest, TDD): `realestate-viewer` denied transactions/networth/investments/`query_finances`, allowed `realestate:read`, denied `realestate:write`; `admin` allowed all; unknown tool denied; `*` expansion correct; `pagesFor` returns exactly the allowed pages.
- API-route tests: mock session → assert 403 for disallowed tool/route, 200/forward for allowed.
- Keep `tests/test_dashboard_contract.py` (tool allowlist guard) green.

## To verify at start of planning (library specifics; do not change the design)

1. **Auth.js v5 (`next-auth@beta`) + Next.js 16 compatibility.** If they conflict, fall back to a minimal `jose`-based OIDC flow against Cognito (authorize redirect, code exchange, JWT verify via JWKS, httpOnly session cookie) — same seam, less magic.
2. **MCP TypeScript SDK** custom-header passing on the streamable-HTTP client (`requestInit.headers`) vs the `/t/<token>/mcp` path fallback.
3. **Vercel Hobby `maxDuration` cap** (confirm it covers the ~36s `get_net_worth`).
4. **Current Cognito free-tier tier name** (Essentials vs Lite) and Hosted UI ("Managed Login") inclusion.

## Out of scope (v1)

- In-app admin invite UI (CLI only for now).
- MFA enforcement (pool flip later).
- Per-user page overrides beyond role bundles.
- Deploying `link_helper` to the cloud (stays local by design).
- Refactoring `/transactions` off raw SQL to enable a transactions-only viewer.
