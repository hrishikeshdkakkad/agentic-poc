# Auth & RBAC — Deployment Runbook

The dashboard is deployed to **Vercel** behind **AWS Cognito** (invitation-only OAuth) with **page-level RBAC**. The MCP server + scheduled sync stay on AWS Lambda, unchanged. This file is the operational guide.

## Live resources

| Thing | Value |
|---|---|
| App (production) | https://personal-finance-vault.vercel.app |
| Vercel project | `personal-finance-vault` (team `hrishikeshdkakkads-projects`, region iad1) |
| Cognito User Pool | `us-east-1_IefyP36vE` (name `personal-finance-mcp`) |
| Cognito Hosted UI | https://pf-mcp-471112572248.auth.us-east-1.amazoncognito.com |
| App client | `22lg9oc6oc5bimf4lvmbd05vrd` (confidential; secret in Vercel env) |
| Groups (roles) | `admin`, `realestate-viewer` |
| MCP server (unchanged) | `https://3a6q4qkjrmx5ewdazow7objvmu0uktgz.lambda-url.us-east-1.on.aws/mcp` (bearer-gated) |

## The security model

```
Browser ──(httpOnly session cookie)──> Vercel (Next.js)
   (1) proxy.ts: no session → /login (Cognito Hosted UI). Wrong page for your role → your first allowed page.
   (2) every /api route: verify session → map cognito groups → permissions → 403 if not allowed   ← REAL gate
   (3) if allowed, attach server-only Bearer token → MCP Lambda
```

RBAC is enforced **server-side in Next.js** (the only tier that holds the MCP bearer token + Neon creds). The MCP Lambda stays single-token / full-access by design (also used by the claude.ai connector). The browser never sees the MCP token.

**Single source of truth:** `dashboard/src/lib/rbac.ts` — three maps (`ROLE_PERMISSIONS`, `PAGE_PERMISSION`, `TOOL_PERMISSION`) + resolvers. Covered by `rbac.test.ts`. Enforced by `dashboard/src/lib/session.ts` in every API route and by `dashboard/src/proxy.ts` for page access. Roles come from the Cognito `cognito:groups` claim (only `roles` are stored in the session; permissions are recomputed from the map each request, so changing the map needs no re-login).

## Roles

| Role (Cognito group) | Permissions | Sees |
|---|---|---|
| `admin` | `*` | everything, incl. raw SQL, sync, mutations |
| `realestate-viewer` | `realestate:read`, `realestate:write` | only `/real-estate`, as a shared **read-write** workspace: view the deal, edit assumptions, log construction actuals, pin baselines. Live portfolio strip still hidden; no access to any other page. |

### Invite someone

```bash
USER_POOL_ID=us-east-1_IefyP36vE ./deploy/invite.sh <email> <role>
# e.g. invite your father, real-estate only:
USER_POOL_ID=us-east-1_IefyP36vE ./deploy/invite.sh dad@example.com realestate-viewer
```
Cognito emails a temporary password; they set their own on first login. No public sign-up exists.

### List / revoke

```bash
USER_POOL_ID=us-east-1_IefyP36vE ./deploy/cognito_helpers.sh list
USER_POOL_ID=us-east-1_IefyP36vE ./deploy/cognito_helpers.sh revoke <email>   # global sign-out + disable
```

### Add a new role

1. `aws cognito-idp create-group --user-pool-id us-east-1_IefyP36vE --group-name <role>`
2. Add `<role>: [<permissions>]` to `ROLE_PERMISSIONS` in `dashboard/src/lib/rbac.ts`, add a test, redeploy.

## Known constraints (by design)

- **`/transactions` is admin-only in v1.** It builds raw SQL via `query_finances`, which can read any table, so it's locked to `admin` (a page-scoped viewer would otherwise bypass scoping). To add a transactions-only viewer later, refactor that page off raw SQL onto structured tools.
- **`/connections` is admin-only, and Plaid *linking* stays local.** `link_helper.py` holds Plaid tokens and refuses to run in the cloud (tokens never leave your machine). The deployed `/connections` shows sync status + a Sync button (both via the MCP server); link/relink/CSV import are done locally. Daily data still refreshes via the sync Lambda (~6×/day).
- **MFA is off** (pool setting). Flip to OPTIONAL/REQUIRED in the Cognito console later — no code change.

## Redeploy

```bash
cd dashboard && vercel --prod --yes     # deploys the working tree
```
Env vars live in Vercel project settings (Production). To change one: `vercel env rm NAME production` then `vercel env add NAME production`, then redeploy. To reconfigure Cognito callback URLs (e.g. a custom domain): `CALLBACK_BASE="https://<new-domain>" ./deploy/setup_cognito.sh` (idempotent).

## Vercel env vars (all server-only — never `NEXT_PUBLIC_`)

`AUTH_SECRET`, `AUTH_URL`, `AUTH_COGNITO_ID`, `AUTH_COGNITO_SECRET`, `AUTH_COGNITO_ISSUER`, `COGNITO_HOSTED_DOMAIN`, `MCP_URL`, `MCP_AUTH_TOKEN`, `DATABASE_URL`.

## Verified posture (2026-06-19)

- Unauthenticated: `/` → 307 `/login`; every `/api/*` → 401 JSON.
- Authenticated `realestate-viewer` (live session): nav shows only Real estate; `GET` **and** `PUT /api/realestate/deals/*` → 200 (shared read-write workspace); cross-scope tools `query_finances`, `get_portfolio_analysis`, `get_net_worth_history`, `sync_now` → all **403**.
- Cognito emits `cognito:groups` in the ID token; MCP Lambda accepts the deployed bearer (wrong token → 401).
- 192 dashboard unit tests + 2 Python contract tests green; production build clean.
