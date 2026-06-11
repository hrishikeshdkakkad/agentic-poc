# Deployment

This server runs anywhere Python 3.11+ and HTTP work. Options below, shortest to most featured.

## Local only

Fine if you only need to use it from the same machine:

```bash
source .venv/bin/activate
PORT=8000 python server.py
```

Point your MCP client at `http://localhost:8000/mcp`. No auth gate needed — nothing outside your machine can reach it.

## Docker

A minimal `Dockerfile` ships with the repo:

```bash
docker build -t personal-finance-mcp .
docker run --rm -p 8000:8000 --env-file .env personal-finance-mcp
```

`link_helper.py` is deliberately **not** copied into the image — it's a local-only tool for obtaining access tokens and must never run in a deployment. If you expose the container publicly, put an auth proxy in front (Caddy + OAuth, Cloudflare Access, nginx with basic auth, etc.).

## AWS Lambda (fully remote, ~$0/month — this fork's deployment)

A public HTTPS MCP endpoint with no idle cost: Lambda's always-free tier
(1M requests + 400k GB-seconds/month) covers single-user MCP traffic
entirely, the Function URL provides free HTTPS, and there is no API
Gateway, VPC, NAT, or load balancer. CloudWatch logs are capped at 30 days.

Architecture:

```
Claude agent ──Authorization: Bearer──▶ Lambda Function URL (free HTTPS)
    └─▶ Mangum (event→ASGI) ─▶ bearer gate ─▶ FastMCP stateless http app
            └─▶ Postgres (history + Fernet-encrypted plaid_tokens)
            └─▶ Plaid API (live tools)
```

Key choices (see `lambda_app.py`):

- `stateless_http=True` — every JSON-RPC POST is self-contained, so requests
  can land on any Lambda container; no session affinity exists or is needed.
- `json_response=True` — plain JSON instead of SSE, so a buffered Function
  URL never holds a stream open.
- Token ciphertext is read from `plaid_tokens` in `DATABASE_URL`; only the
  function's `FERNET_KEY` env var can decrypt it. The database alone still
  reveals nothing. If you use the `PFM_TOKENS_DATABASE_URL` split locally,
  copy ciphertext rows up first (and re-run after linking any new bank):
  `python deploy/migrate_tokens_to_neon.py`.

Deploy (idempotent; requires AWS CLI credentials):

```bash
./deploy/build_lambda.sh     # zip: manylinux aarch64 wheels + app modules
./deploy/deploy.sh           # IAM role + function + URL; prints endpoint
python verify_remote.py      # drives all 28 tools through the live endpoint
```

`deploy.sh` generates `MCP_AUTH_TOKEN` on first run and persists it (plus
`MCP_REMOTE_URL`) into `.env`. Every request must send
`Authorization: Bearer $MCP_AUTH_TOKEN`; only `GET /health` is open. To
rotate the token, change it in `.env` and re-run `deploy.sh`.

> **AWS gotcha (October 2025 change):** public Function URLs now require
> *two* resource-policy statements — `lambda:InvokeFunctionUrl` (authtype
> NONE) **and** `lambda:InvokeFunction` with the `InvokedViaFunctionUrl`
> condition. With only the first, every request 403s before reaching your
> code. `deploy.sh` adds both.

Connect a client:

```bash
claude mcp add --transport http personal-finance \
  "$MCP_REMOTE_URL" --header "Authorization: Bearer $MCP_AUTH_TOKEN"
```

Expect ~5-7s on the first call after idle (cold start); warm history-tool
calls run in ~100-200ms when Lambda and Postgres share a region.

## Prefect Horizon

The author's setup. Free tier with scale-to-zero, OAuth 2.1 built in, ~$0 recurring cost. Trade-off: 20-60s cold start after idle.

1. Push the repo to a **private** GitHub repo (your deployment will bake env vars into a dashboard, so a private source repo is a nice extra layer).
2. Go to https://horizon.prefect.io and sign in with GitHub.
3. **New Server → Connect repo → personal-finance-mcp**.
4. Configure:
   - **Entrypoint:** `server.py:mcp`
   - **Environment variables:** every line from your local `.env`, one per row:
     - `PLAID_CLIENT_ID`
     - `PLAID_SECRET`
     - `PLAID_ENV=production`
     - Every `PLAID_TOKEN_<NAME>` line
     - `HORIZON=1` (belt-and-braces guard that blocks `link_helper.py` from ever running on the deployment)
   - **Access control:** enable **OAuth 2.1**, restrict to your own email.
5. Click **Deploy**. Wait ~60s for the first build.
6. Copy the deployment URL (e.g. `https://<name>.fastmcp.app/mcp`).
7. Add to your MCP client:
   ```bash
   claude mcp add --transport http personal-finance https://<name>.fastmcp.app/mcp
   ```
   Claude Code will prompt you to complete the OAuth flow in a browser. Sign in with the email you restricted in step 4.

## Any other host

Anything that runs Python + HTTP works: Fly.io, Railway, a Raspberry Pi behind Tailscale, a VPS with systemd. Requirements:

- Python 3.11+
- Env vars from `.env.example` (plus `HORIZON=1` to keep `link_helper.py` disabled)
- Persistent HTTPS endpoint at `/mcp`
- Auth gate in front unless on a private network
- `server.py` reads `PORT` from env, which most PaaS hosts inject automatically

## Adding a bank after the initial setup

1. On your laptop: `source .venv/bin/activate && uvicorn link_helper:app --port 8765`
2. Open http://localhost:8765, click **Link a bank**, complete the flow
3. Copy the new `PLAID_TOKEN_<NAME>=access-prod-...` from the terminal
4. Add the new env var to your deployment (Horizon env panel, `docker run --env-file`, etc.)
5. Redeploy or wait for the next request — most platforms pick up new env vars automatically
6. (Optional) paste the line into your local `.env` too if you want to test against the real token locally

No code change or git push needed.

## Handling `ITEM_LOGIN_REQUIRED` (re-auth)

When a bank's MFA token expires or you change your password, Plaid returns `ITEM_LOGIN_REQUIRED`. You'll see it in `get_institutions_status()` or as a warning on any tool call.

```bash
source .venv/bin/activate
uvicorn link_helper:app --port 8765
```

In another terminal:

```bash
curl -X POST http://localhost:8765/create-link-token \
  -H 'content-type: application/json' \
  -d '{"update_access_token": "access-prod-YOUR-EXISTING-TOKEN"}'
```

Copy the returned `link_token` into a quick HTML snippet, or modify `INDEX_HTML` in `link_helper.py` to accept an `update_access_token` query param. Complete Plaid Link → your existing access token stays the same, just re-enabled on Plaid's side. No env var changes needed.
