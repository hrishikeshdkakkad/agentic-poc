# GitHub Pipelines (CI/CD) — Design

Date: 2026-06-11
Status: approved by user (conversation), pending spec review

## Goal

Automate test → build → deploy → verify for the personal-finance-mcp repo:
every PR gets tested; every push to `main` ships the tested artifact to the
existing AWS Lambda (`personal-finance-mcp`, us-east-1) and smoke-checks the
live endpoint.

## Decisions (user-confirmed)

| Decision | Choice |
|---|---|
| Repo visibility | Stays **public** — pipeline designed defensively |
| Scope | CI + CD + post-deploy smoke verify |
| AWS auth | **OIDC federated role** — no AWS keys in GitHub |
| Deploy branch | **`main`**, consolidated from `claude/finance-mcp-duckdb-k6q9dw`; becomes GitHub default |

## Architecture

One workflow, `.github/workflows/ci.yml`, four chained jobs:

```
pull_request ──▶ [test]   [build]            (no secrets, fork-safe)
push to main ──▶ [test]   [build] ──▶ [deploy] ──▶ [smoke]
workflow_dispatch ──▶ same as push to main
```

### Job: test
- `ubuntu-latest`, Python 3.11 (matches Lambda runtime), pip cache.
- `postgres:16` service container; tests run with
  `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pfm_test`.
- `pip install -r requirements.txt`, `pytest -q` (131 tests).

### Job: build
- Runs `deploy/build_lambda.sh`, uploads `deploy/lambda.zip` as artifact.
- Script change required: `PIP="${PIP:-.venv/bin/pip}"` so CI can supply its
  own interpreter; behavior unchanged locally.

### Job: deploy (push to main / dispatch only)
- `permissions: id-token: write, contents: read`.
- `aws-actions/configure-aws-credentials@v4` assuming
  `personal-finance-mcp-github-deploy` (ARN in repo secret `AWS_ROLE_ARN`).
- Downloads the artifact from THIS run (the exact zip that passed CI),
  `aws lambda update-function-code --zip-file fileb://lambda.zip`,
  `aws lambda wait function-updated`.
- `concurrency: group: lambda-deploy, cancel-in-progress: false` —
  serialized deploys.

### Job: smoke (after deploy)
- Unauthenticated `GET <endpoint base>/health` → expect HTTP 200 (with
  retries to absorb cold start).
- Authenticated JSON-RPC `tools/list` POST → expect **≥ 28** tools (catches
  total/partial tool loss without breaking CI on legitimate tool additions).
- Uses repo secrets `MCP_REMOTE_URL`, `MCP_AUTH_TOKEN`. Deliberately NOT
  `verify_remote.py` (live Plaid calls + sync writes stay a local command).

## Division of labor with existing tooling

- **GitHub CD = code-only deploys** (`update-function-code`).
- **Local `./deploy/deploy.sh` = config deploys**: env vars, FERNET_KEY,
  MCP_AUTH_TOKEN rotation, first-time provisioning. `.env` and the Fernet
  keyfile never reach GitHub.
- **`deploy/migrate_tokens_to_neon.py`** stays local (new banks need no
  deploy at all).

## One-time provisioning (done with local AWS creds, not in CI)

1. IAM OIDC provider `token.actions.githubusercontent.com` (create if the
   account lacks one).
2. IAM role `personal-finance-mcp-github-deploy`:
   - Trust: federated OIDC, `aud=sts.amazonaws.com`,
     `sub=repo:hrishikeshdkakkad/agentic-poc:ref:refs/heads/main`.
   - Inline policy: `lambda:UpdateFunctionCode`, `lambda:GetFunction` on
     `arn:aws:lambda:us-east-1:471112572248:function:personal-finance-mcp` only.
3. Branch consolidation: push local work, fast-forward `main`, push, set
   `main` as GitHub default branch.
4. Repo secrets: `MCP_REMOTE_URL`, `MCP_AUTH_TOKEN`, `AWS_ROLE_ARN`.

## Public-repo security posture

- Fork PRs run only test/build; GitHub withholds secrets and OIDC tokens
  from fork-initiated runs, and deploy/smoke are additionally gated by
  `github.event_name == 'push' || 'workflow_dispatch'` on `main`.
- `GITHUB_TOKEN` minimal: `contents: read` everywhere; `id-token: write`
  only on deploy.
- The OIDC trust condition pins repo AND branch — another repo or branch
  cannot assume the role.
- Role actions: `lambda:UpdateFunctionCode` + `lambda:GetFunctionConfiguration`
  (the `function-updated` waiter polls the latter), on the one function ARN.
  Acknowledged trade-off: `GetFunctionConfiguration` returns env var values
  (FERNET_KEY etc.). This is acceptable because the role is assumable only
  from pushes to `main` of this repo — anyone who can push to `main` can
  already ship arbitrary code to the Lambda, which is strictly more power.
  No broader Lambda/IAM/logs access is granted.

## Failure behavior

- Any failed job stops the chain; GitHub notifies by email.
- Failed smoke = new code is live but unhealthy → fix forward
  (`git revert` + push) or redeploy locally. No auto-rollback (solo repo,
  YAGNI).

## Out of scope

- Branch protection rules, required reviews (solo developer).
- Auto-rollback / versioned aliases.
- OAuth for claude.ai connector (separate concern).
- Scheduled sync via Actions cron (sync stays manual by user choice).

## Acceptance criteria

1. A PR (or non-main push) runs test+build only, green, no secret access.
2. A push to `main` runs all four jobs green; the live endpoint serves the
   newly-deployed code.
3. Re-running deploy via `workflow_dispatch` works from the GitHub UI.
4. `aws sts` shows the role assumable only from this repo/branch (negative
   test: trust policy inspection).
5. Local `pytest`, `check_lambda_local.py`, and `verify_remote.py` all still
   pass; local deploy.sh path unchanged.
