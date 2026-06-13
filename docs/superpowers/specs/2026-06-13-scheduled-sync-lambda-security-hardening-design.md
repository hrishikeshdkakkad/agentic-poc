# Scheduled Plaid sync Lambda + secret hardening — design

Date: 2026-06-13
Status: approved (scope: "harden in place"; root keys retained for now)

## Problem

1. The Plaid `sync` job (`sync.py`) has no scheduled runner — it only runs
   manually (`python sync.py`) or via the `sync_now` MCP tool. We want it to run
   automatically 5–6×/day.
2. `personal-finance-mcp` lives in a **shared, standalone** AWS account
   (`forceplatforms`, `471112572248`) alongside two other `AdministratorAccess`
   IAM users (`sumeetaher`, `tilaksharma`) and unrelated infra (EKS/ECS/
   CodePipeline/"accountforce"/"expenseforce"/Modal). The finance secrets
   (`PLAID_SECRET`, `FERNET_KEY`, `DATABASE_URL`) are **plaintext Lambda env
   vars** encrypted only by the default AWS-managed key, so either admin can
   `GetFunctionConfiguration` and exfiltrate everything needed to decrypt the
   user's Plaid tokens.

The caller operates as the **account root user** (root access keys), and the
account is **not** in an AWS Organization (no SCPs available).

## Goal & non-goals

- **Goal:** run sync on a schedule with no public surface; remove the trivial
  passive-read exposure of the finance secrets from the other two admins; keep
  least-privilege everywhere; touch only `personal-finance-*` resources.
- **Non-goal:** locking down *all* account secrets/lambdas (would break
  colleagues' infra). Migrating to a dedicated account (deferred). Moving off
  root keys (deferred by user choice).

## Security model (the crux)

A **customer-managed KMS key** `alias/personal-finance-mcp` with a 3-statement
key policy:

1. `EnableRootAndIAMDelegation` — `Allow` `arn:…:root` `kms:*` (keeps the key
   manageable by the user-as-root; prevents lockout).
2. `AllowAppLambdaRolesDecrypt` — `Allow` the two Lambda execution roles
   (`personal-finance-mcp-lambda`, `personal-finance-mcp-sync-lambda`)
   `kms:Decrypt`/`kms:DescribeKey`.
3. `DenyOtherAccountAdmins` — `Deny` `user/sumeetaher` + `user/tilaksharma`
   `kms:*`. **Explicit Deny overrides their `AdministratorAccess` `*`** — they
   can neither decrypt nor `PutKeyPolicy` to re-grant themselves.

Secrets move into one **SSM SecureString** parameter `/personal-finance-mcp/config`
(a JSON blob) encrypted by that CMK. Reading it requires `ssm:GetParameter`
**and** `kms:Decrypt` on the CMK — so the Deny fully blocks the two admins.

**Honest ceiling:** those admins keep `lambda:*`, so a determined one could edit
the function code to log decrypted config at runtime. That is the account-
boundary limit accepted under "harden in place"; `UpdateFunctionCode` is
recorded in the existing multi-region CloudTrail (`serverless_trail`).
Optional stronger variant: replace the named Deny with an allowlist Deny
(`Deny kms:* if aws:PrincipalArn NotLike [root, the 2 λ roles]`) to also fence
out future-created admins.

## Architecture

```
EventBridge Scheduler ─(rate(4 hours), retry x2)─▶ λ personal-finance-mcp-sync
  role: scheduler→InvokeFunction (sync only)          handler sync.lambda_handler
                                                       role: logs + ssm:GetParameter + kms:Decrypt
                                                       512 MB / 300 s, NO Function URL
λ personal-finance-mcp (existing server, URL kept) ─┐  both λ load config at cold start
  env: PFM_CONFIG_PARAM, HORIZON=1, PFM_SECRETS_DIR  ▼
                                  SSM SecureString /personal-finance-mcp/config
                                          │ encrypted by
                                          ▼  KMS alias/personal-finance-mcp
                                  (root=full · 2 λ roles=Decrypt · 2 admins=DENY)
both λ ─▶ Plaid API + Neon Postgres (unchanged)
```

## Code changes (additive, backward-compatible)

- **`config_secrets.py`** (new): `load_into_env()` — if `PFM_CONFIG_PARAM` is
  set, fetch the SSM SecureString via `boto3` (preinstalled in the Lambda
  runtime → no packaging change), parse JSON, populate `os.environ`. No-op when
  unset → local/dev/tests/`.env` unchanged. Fails loud if the param is named but
  unreadable (never silently runs unconfigured).
- **`sync.py`**: add `lambda_handler(event, context)` → `load_into_env()` then
  `run_sync()`; logs a summary; returns `{ok, items_synced, warnings,
  total_transactions_stored}`. Failure strategy: total failure propagates (so
  the schedule retries); per-Item warnings are returned, not raised (idempotent
  next run heals). Token material never logged/returned.
- **`lambda_app.py`**: call `load_into_env()` before `from server import mcp`
  and the `MCP_AUTH_TOKEN` check.
- **`deploy/build_lambda.sh`**: package `config_secrets.py`.

## Infra / deploy (run locally as root — secrets never reach GitHub)

- **`deploy/setup_security.sh`** (idempotent): ensure both Lambda roles; create
  CMK + alias; put the 3-statement key policy; push `.env`→SSM SecureString
  (via chmod-600 `--cli-input-json` temp file, never on argv); attach the
  `pfm-read-config` inline policy (one param + one key) to both Lambda roles;
  create the `personal-finance-mcp-scheduler` invoke role.
- **`deploy/deploy_sync.sh`**: create/update the sync function (same zip,
  handler `sync.lambda_handler`, pointer-only env) + the EventBridge Scheduler
  schedule (`rate(4 hours)`, retry x2, no Function URL; no Lambda resource
  permission needed — Scheduler invokes via its IAM role).
- **`deploy/migrate_server_secrets.sh`**: flip the existing server function's
  env to the pointer-only model (drops plaintext secrets). Run **last**, after
  the sync function has proven the SSM+KMS+role path end-to-end.
- **`deploy/deploy.sh`**: updated to the SSM model so future canonical deploys
  don't re-introduce plaintext env vars (regression guard).
- **`.github/workflows/ci.yml`** + deploy role: add the sync function ARN to the
  `deploy-code-only` inline policy and a second `update-function-code` step, so
  one push updates both functions from the single artifact.

## Cutover order (no server outage)

1. Code + scripts committed; unit tests green.
2. `build_lambda.sh` → `setup_security.sh` (CMK, SSM, roles).
3. `deploy_sync.sh` → manually invoke sync once → confirm it reads SSM, writes
   to Neon, returns a summary. This proves the exact role+SSM+KMS path.
4. Redeploy server code (SSM-aware) → `migrate_server_secrets.sh` (strip
   plaintext) → verify `/health` + `tools/list` ≥ 30.

## Verification

- Unit: `tests/test_config_secrets.py`, `tests/test_sync_handler.py`.
- Live: one-shot sync invoke; `verify_remote.py` (server still 30 tools).
- `deploy/verify_security.py`: assert key policy has the Deny, param is
  `SecureString` under the CMK, neither function exposes plaintext secret env.

## Cost & rollback

- **Cost:** +~$1/mo (CMK). SSM standard tier free; ~180 sync invocations/mo
  inside the Lambda free tier. Net ≈ prior ~$0/mo + $1.
- **Rollback:** re-put plaintext env from `.env`; delete schedule/sync
  function/param; `kms:ScheduleKeyDeletion` (7–30 day window) or just leave the
  key. Every step reversible.
