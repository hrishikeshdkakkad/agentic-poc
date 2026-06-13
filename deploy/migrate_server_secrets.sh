#!/usr/bin/env bash
# Flip the EXISTING MCP server function (personal-finance-mcp) from plaintext
# secret env vars to the SSM-pointer model — i.e. REMOVE PLAID_SECRET,
# FERNET_KEY, DATABASE_URL, etc. from its environment so they're only readable
# via the KMS-protected SSM parameter.
#
# PRECONDITIONS (the cutover is safe only after these):
#   1. setup_security.sh has run (CMK + SSM param + pfm-read-config on the
#      server role).
#   2. The server function is running SSM-aware code (config_secrets +
#      lambda_app calling load_into_env at import) — redeploy its code first.
#   3. The sync function has already proven the SSM+KMS+role path end-to-end.
# Rollback: re-run deploy/deploy.sh (re-pushes config to SSM, keeps pointer
# model) — or temporarily re-set plaintext env from .env if ever needed.
set -euo pipefail
cd "$(dirname "$0")/.."

REGION=${REGION:-us-east-1}
FUNC=personal-finance-mcp
PARAM=/personal-finance-mcp/config

# Guard: refuse to strip env unless the role can actually read the SSM config.
if ! aws iam get-role-policy --role-name personal-finance-mcp-lambda \
        --policy-name pfm-read-config >/dev/null 2>&1; then
    echo "refusing: personal-finance-mcp-lambda is missing pfm-read-config; run setup_security.sh first" >&2
    exit 1
fi

ENVJSON='{"Variables":{"PFM_CONFIG_PARAM":"'"$PARAM"'","HORIZON":"1","PFM_SECRETS_DIR":"/tmp/pfm-secrets"}}'
aws lambda update-function-configuration --function-name "$FUNC" \
    --environment "$ENVJSON" --region "$REGION" >/dev/null
aws lambda wait function-updated-v2 --function-name "$FUNC" --region "$REGION"
echo "server $FUNC env stripped to SSM-pointer model (plaintext secrets removed)"
