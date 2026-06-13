#!/usr/bin/env bash
# Deploy deploy/lambda.zip to AWS Lambda behind a public Function URL.
#
# Cost shape: Lambda always-free tier (1M requests + 400k GB-s/month) plus a
# free Function URL — a single-user MCP server rounds to $0/month. No API
# Gateway, no VPC, no NAT, no load balancer, no container registry.
#
# Idempotent: safe to re-run after every rebuild; creates the IAM role,
# function, and URL on first run, updates code+config afterwards.
#
# Secrets handling: env vars are assembled by a Python helper straight from
# .env + the local Fernet keyfile into a chmod-600 temp file, passed to the
# AWS CLI, then deleted. MCP_AUTH_TOKEN is generated on first run and
# persisted into .env (gitignored).
set -euo pipefail
cd "$(dirname "$0")/.."

FUNC_NAME=personal-finance-mcp
ROLE_NAME=personal-finance-mcp-lambda
REGION=us-east-1
RUNTIME=python3.11
ARCH=arm64
MEMORY=1024
TIMEOUT=240
ZIP=deploy/lambda.zip
PY=.venv/bin/python

[ -f "$ZIP" ] || { echo "run deploy/build_lambda.sh first" >&2; exit 1; }

# Secrets are NOT set as plaintext function env vars (a shared-account admin
# could otherwise read them via GetFunctionConfiguration). Generate the MCP
# bearer token once into .env, then setup_security.sh pushes ALL secrets into
# the KMS-encrypted SSM parameter (alias/personal-finance-mcp, which denies the
# other admins) and provisions the least-privilege roles. The function only
# ever receives non-secret pointers. PFM_TOKENS_DATABASE_URL stays unset: token
# ciphertext is read from plaid_tokens inside DATABASE_URL; HORIZON=1 guards
# link_helper from ever running in a deployment.
"$PY" - <<'PYEOF'
import secrets
from dotenv import dotenv_values
env_path = ".env"
values = dotenv_values(env_path)
if not (values.get("MCP_AUTH_TOKEN") or "").strip():
    with open(env_path, "a") as f:
        f.write(
            "\n# Bearer token required by the remote (AWS Lambda) MCP endpoint.\n"
            f"MCP_AUTH_TOKEN={secrets.token_urlsafe(32)}\n"
        )
PYEOF

REGION="$REGION" PY="$PY" bash deploy/setup_security.sh

ENV_JSON=$(mktemp -t pfm-lambda-env)
chmod 600 "$ENV_JSON"
trap 'rm -f "$ENV_JSON"' EXIT
printf '%s' \
  '{"Variables":{"PFM_CONFIG_PARAM":"/personal-finance-mcp/config","HORIZON":"1","PFM_SECRETS_DIR":"/tmp/pfm-secrets"}}' \
  > "$ENV_JSON"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    echo "creating IAM role $ROLE_NAME"
    aws iam create-role --role-name "$ROLE_NAME" \
        --assume-role-policy-document '{
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Principal": {"Service": "lambda.amazonaws.com"},
                "Action": "sts:AssumeRole"
            }]
        }' >/dev/null
    aws iam attach-role-policy --role-name "$ROLE_NAME" \
        --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
fi

if aws lambda get-function --function-name "$FUNC_NAME" --region "$REGION" >/dev/null 2>&1; then
    echo "updating function code"
    aws lambda update-function-code --function-name "$FUNC_NAME" \
        --zip-file "fileb://$ZIP" --region "$REGION" >/dev/null
    aws lambda wait function-updated-v2 --function-name "$FUNC_NAME" --region "$REGION"
    echo "updating function configuration"
    aws lambda update-function-configuration --function-name "$FUNC_NAME" \
        --environment "file://$ENV_JSON" \
        --memory-size "$MEMORY" --timeout "$TIMEOUT" \
        --region "$REGION" >/dev/null
    aws lambda wait function-updated-v2 --function-name "$FUNC_NAME" --region "$REGION"
else
    echo "creating function $FUNC_NAME"
    # First create can race fresh-role propagation; retry briefly.
    created=0
    for attempt in 1 2 3 4 5 6; do
        if aws lambda create-function --function-name "$FUNC_NAME" \
            --runtime "$RUNTIME" --architectures "$ARCH" \
            --handler lambda_app.handler \
            --role "$ROLE_ARN" \
            --zip-file "fileb://$ZIP" \
            --environment "file://$ENV_JSON" \
            --memory-size "$MEMORY" --timeout "$TIMEOUT" \
            --region "$REGION" >/dev/null 2>deploy/.create-err; then
            created=1; break
        fi
        if grep -q "cannot be assumed" deploy/.create-err; then
            echo "  waiting for IAM role propagation (attempt $attempt)"; sleep 8
        else
            cat deploy/.create-err >&2; rm -f deploy/.create-err; exit 1
        fi
    done
    rm -f deploy/.create-err
    [ "$created" = 1 ] || { echo "create-function kept failing" >&2; exit 1; }
    aws lambda wait function-active-v2 --function-name "$FUNC_NAME" --region "$REGION"
fi

if ! aws lambda get-function-url-config --function-name "$FUNC_NAME" --region "$REGION" >/dev/null 2>&1; then
    aws lambda create-function-url-config --function-name "$FUNC_NAME" \
        --auth-type NONE --invoke-mode BUFFERED --region "$REGION" >/dev/null
fi
# Public invoke permission for the URL; app-level bearer auth is the gate.
# Since October 2025 AWS requires BOTH statements for new function URLs:
# lambda:InvokeFunctionUrl (authtype NONE) and lambda:InvokeFunction scoped
# by the InvokedViaFunctionUrl condition (which also blocks direct Invoke).
aws lambda add-permission --function-name "$FUNC_NAME" \
    --statement-id FunctionURLAllowPublicAccess \
    --action lambda:InvokeFunctionUrl --principal '*' \
    --function-url-auth-type NONE --region "$REGION" >/dev/null 2>&1 || true
aws lambda add-permission --function-name "$FUNC_NAME" \
    --statement-id FunctionURLInvokeAllowPublicAccess \
    --action lambda:InvokeFunction --principal '*' \
    --invoked-via-function-url --region "$REGION" >/dev/null 2>&1 || true

FUNC_URL=$(aws lambda get-function-url-config --function-name "$FUNC_NAME" \
    --region "$REGION" --query FunctionUrl --output text)
MCP_URL="${FUNC_URL%/}/mcp"

"$PY" - "$MCP_URL" <<'PYEOF'
import sys
url = sys.argv[1]
path = ".env"
with open(path) as f:
    lines = f.readlines()
out, seen = [], False
for line in lines:
    if line.startswith("MCP_REMOTE_URL="):
        out.append(f"MCP_REMOTE_URL={url}\n"); seen = True
    else:
        out.append(line)
if not seen:
    out.append("# Deployed remote MCP endpoint (AWS Lambda Function URL).\n")
    out.append(f"MCP_REMOTE_URL={url}\n")
with open(path, "w") as f:
    f.writelines(out)
PYEOF

AUTH_TOKEN=$("$PY" -c "from dotenv import dotenv_values; print(dotenv_values('.env')['MCP_AUTH_TOKEN'])")
echo
echo "deployed: $MCP_URL"
echo
echo "connect a Claude agent with:"
echo "  claude mcp add --transport http personal-finance \"$MCP_URL\" --header \"Authorization: Bearer $AUTH_TOKEN\""
