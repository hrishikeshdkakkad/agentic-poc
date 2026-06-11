# GitHub Pipelines (CI/CD) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every PR runs tests + builds the Lambda zip; every push to `main` additionally deploys that exact zip to the `personal-finance-mcp` Lambda via an OIDC role and smoke-checks the live endpoint.

**Architecture:** One workflow (`.github/workflows/ci.yml`) with four chained jobs (test → build → deploy → smoke). Deploy assumes a branch-pinned OIDC role (no AWS keys in GitHub). Config/secret deploys stay local in `deploy/deploy.sh`.

**Tech Stack:** GitHub Actions, aws-actions/configure-aws-credentials@v4, postgres:16 service container, existing `deploy/build_lambda.sh`.

Spec: `docs/superpowers/specs/2026-06-11-github-pipelines-design.md`

**Facts established during design (do not re-derive):**
- OIDC provider `token.actions.githubusercontent.com` ALREADY exists in account 471112572248 — do not create one.
- `origin/main` is an ancestor of HEAD — plain (non-force) push fast-forwards it.
- `tests/conftest.py` defaults to `postgresql://finance:finance@127.0.0.1:5433/finance` and SKIPS db tests if unreachable — CI must provide that Postgres and pre-verify connectivity so skips can't masquerade as green.
- Tests need no real credentials (Plaid is mocked; conftest pins DATABASE_URL per-test).
- The home-directory pyproject/pytest gotcha is local-only; plain `pytest -q` is correct on CI runners.

---

### Task 1: Make build_lambda.sh runnable on CI (PIP override)

**Files:**
- Modify: `deploy/build_lambda.sh`

- [ ] **Step 1: Add the override**

Replace the two `.venv/bin/pip install` invocations: insert near the top (after `set -euo pipefail; cd ...`):

```bash
PIP="${PIP:-.venv/bin/pip}"
```

and change both install commands to start with `"$PIP" install` (phase 1 platform install and phase 2 plaid-python install).

- [ ] **Step 2: Verify locally (unchanged default path)**

Run: `./deploy/build_lambda.sh`
Expected: ends with `deploy/lambda.zip` listing, ~27M, `unzipped size: 107M`.

- [ ] **Step 3: Commit**

```bash
git add deploy/build_lambda.sh
git commit -m "Allow overriding pip in build_lambda.sh for CI"
```

### Task 2: Create the workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the workflow exactly as follows**

```yaml
name: CI/CD

on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: finance
          POSTGRES_PASSWORD: finance
          POSTGRES_DB: finance
        ports:
          - 5433:5432
        options: >-
          --health-cmd "pg_isready -U finance"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      TEST_DATABASE_URL: postgresql://finance:finance@127.0.0.1:5433/finance
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
          cache: pip
      - run: pip install -r requirements.txt
      # conftest SKIPS db tests when Postgres is unreachable; fail loudly
      # here instead so a misconfigured service can't produce a green run.
      - name: Verify test database is reachable
        run: python -c "import psycopg; psycopg.connect('${TEST_DATABASE_URL}', connect_timeout=5).close()"
      - run: pytest -q

  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: PIP=pip ./deploy/build_lambda.sh
      - uses: actions/upload-artifact@v4
        with:
          name: lambda-zip
          path: deploy/lambda.zip
          if-no-files-found: error

  deploy:
    if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'
    needs: [test, build]
    runs-on: ubuntu-latest
    concurrency:
      group: lambda-deploy
      cancel-in-progress: false
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: lambda-zip
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: us-east-1
      - run: >
          aws lambda update-function-code
          --function-name personal-finance-mcp
          --zip-file fileb://lambda.zip
      - run: aws lambda wait function-updated --function-name personal-finance-mcp

  smoke:
    if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'
    needs: deploy
    runs-on: ubuntu-latest
    steps:
      - name: Health check (retries absorb cold start)
        env:
          MCP_REMOTE_URL: ${{ secrets.MCP_REMOTE_URL }}
        run: |
          BASE="${MCP_REMOTE_URL%/mcp}"
          ok=""
          for i in 1 2 3 4 5 6; do
            if curl -fsS --max-time 20 "$BASE/health"; then ok=1; break; fi
            sleep 10
          done
          [ -n "$ok" ]
      - name: tools/list returns at least 28 tools
        env:
          MCP_REMOTE_URL: ${{ secrets.MCP_REMOTE_URL }}
          MCP_AUTH_TOKEN: ${{ secrets.MCP_AUTH_TOKEN }}
        run: |
          COUNT=$(curl -fsS --max-time 30 -X POST "$MCP_REMOTE_URL" \
            -H "authorization: Bearer $MCP_AUTH_TOKEN" \
            -H 'content-type: application/json' \
            -H 'accept: application/json, text/event-stream' \
            -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
            | jq '.result.tools | length')
          echo "tools: $COUNT"
          [ "$COUNT" -ge 28 ]
```

- [ ] **Step 2: Validate YAML parses**

Run: `.venv/bin/python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "Add CI/CD workflow: test, build, OIDC deploy, smoke check"
```

### Task 3: Create the OIDC deploy role (AWS, one-time)

No files; cloud state. OIDC provider already exists — create role + inline policy only.

- [ ] **Step 1: Create the role with a branch-pinned trust policy**

```bash
aws iam create-role --role-name personal-finance-mcp-github-deploy \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Federated": "arn:aws:iam::471112572248:oidc-provider/token.actions.githubusercontent.com"},
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:hrishikeshdkakkad/agentic-poc:ref:refs/heads/main"
        }
      }
    }]
  }'
```

- [ ] **Step 2: Attach the minimal inline policy**

```bash
aws iam put-role-policy --role-name personal-finance-mcp-github-deploy \
  --policy-name deploy-code-only \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["lambda:UpdateFunctionCode", "lambda:GetFunctionConfiguration"],
      "Resource": "arn:aws:lambda:us-east-1:471112572248:function:personal-finance-mcp"
    }]
  }'
```

- [ ] **Step 3: Verify**

Run: `aws iam get-role --role-name personal-finance-mcp-github-deploy --query 'Role.Arn'`
Expected: `arn:aws:iam::471112572248:role/personal-finance-mcp-github-deploy`

### Task 4: Set repo secrets

- [ ] **Step 1: Set all three secrets from local state**

```bash
gh secret set AWS_ROLE_ARN --repo hrishikeshdkakkad/agentic-poc \
  --body "arn:aws:iam::471112572248:role/personal-finance-mcp-github-deploy"
.venv/bin/python -c "from dotenv import dotenv_values; print(dotenv_values('.env')['MCP_REMOTE_URL'])" \
  | gh secret set MCP_REMOTE_URL --repo hrishikeshdkakkad/agentic-poc
.venv/bin/python -c "from dotenv import dotenv_values; print(dotenv_values('.env')['MCP_AUTH_TOKEN'])" \
  | gh secret set MCP_AUTH_TOKEN --repo hrishikeshdkakkad/agentic-poc
```

- [ ] **Step 2: Verify**

Run: `gh secret list --repo hrishikeshdkakkad/agentic-poc`
Expected: AWS_ROLE_ARN, MCP_AUTH_TOKEN, MCP_REMOTE_URL listed.

### Task 5: Consolidate branches and push

- [ ] **Step 1: Push the working branch, fast-forward main, switch default**

```bash
git push origin claude/finance-mcp-duckdb-k6q9dw
git push origin HEAD:main          # fast-forward (ancestry verified)
gh repo edit hrishikeshdkakkad/agentic-poc --default-branch main
```

- [ ] **Step 2: Track main locally**

```bash
git checkout -b main --track origin/main
```

- [ ] **Step 3: Verify**

Run: `gh repo view hrishikeshdkakkad/agentic-poc --json defaultBranchRef -q .defaultBranchRef.name`
Expected: `main`

### Task 6: Verify the main-push pipeline end to end

- [ ] **Step 1: Record the pre-deploy code hash**

Run: `aws lambda get-function-configuration --function-name personal-finance-mcp --query CodeSha256 --output text`
Save the value.

- [ ] **Step 2: Watch the run triggered by the Task 5 push**

```bash
gh run list --repo hrishikeshdkakkad/agentic-poc --branch main --limit 1
gh run watch --repo hrishikeshdkakkad/agentic-poc <run-id> --exit-status
```

Expected: jobs test, build, deploy, smoke all ✓. If deploy fails on AssumeRole,
check the trust policy `sub` matches `repo:hrishikeshdkakkad/agentic-poc:ref:refs/heads/main` exactly.

- [ ] **Step 3: Confirm the function actually changed and still serves**

Run: `aws lambda get-function-configuration --function-name personal-finance-mcp --query CodeSha256 --output text`
Expected: DIFFERENT hash from Step 1.
Run: `.venv/bin/python verify_remote.py`
Expected: `all 34 remote checks passed`.

### Task 7: Verify the PR path runs without secrets

- [ ] **Step 1: Open a trivial PR**

```bash
git checkout -b ci-smoke-test
echo "" >> README.md && git add README.md && git commit -m "CI smoke: trivial change"
git push origin ci-smoke-test
gh pr create --repo hrishikeshdkakkad/agentic-poc --title "CI smoke test" --body "Verifying PR path runs test+build only." --base main --head ci-smoke-test
```

- [ ] **Step 2: Watch and assert job set**

```bash
gh run watch --repo hrishikeshdkakkad/agentic-poc <pr-run-id> --exit-status
gh run view --repo hrishikeshdkakkad/agentic-poc <pr-run-id> --json jobs -q '.jobs[].name'
```

Expected: only `test` and `build` ran (deploy/smoke absent or skipped), both ✓.

- [ ] **Step 3: Close PR and clean up**

```bash
gh pr close --repo hrishikeshdkakkad/agentic-poc <pr-number> --delete-branch
git checkout main && git branch -D ci-smoke-test
```

### Task 8: Document and persist

**Files:**
- Modify: `docs/DEPLOYMENT.md` (AWS Lambda section)

- [ ] **Step 1: Add a CI/CD paragraph to docs/DEPLOYMENT.md** (after the deploy commands block):

```markdown
### CI/CD (GitHub Actions)

`.github/workflows/ci.yml` runs tests + builds the zip on every PR, and on
pushes to `main` deploys that exact artifact via the OIDC role
`personal-finance-mcp-github-deploy` (no AWS keys in GitHub) and smoke-checks
the live endpoint (`/health` + authenticated `tools/list ≥ 28`). Code-only:
env/config changes still deploy from a laptop with `./deploy/deploy.sh`.
Repo secrets used: `AWS_ROLE_ARN`, `MCP_REMOTE_URL`, `MCP_AUTH_TOKEN`.
```

- [ ] **Step 2: Commit and push (this push itself exercises the pipeline)**

```bash
git add docs/DEPLOYMENT.md docs/superpowers/plans/2026-06-11-github-pipelines.md
git commit -m "Document CI/CD pipeline"
git push origin main
```

- [ ] **Step 3: Confirm that run also goes green**

Run: `gh run watch --repo hrishikeshdkakkad/agentic-poc <new-run-id> --exit-status`
Expected: 4 jobs ✓.
