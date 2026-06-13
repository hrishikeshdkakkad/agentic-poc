#!/usr/bin/env bash
# One-time, idempotent security setup for personal-finance-mcp. Run LOCALLY
# (as the account owner) — it reads .env + the local Fernet keyfile, which
# never reach GitHub.
#
# Creates: a customer-managed KMS key (alias/personal-finance-mcp) whose policy
# DENIES the other shared-account admins; an SSM SecureString config parameter
# encrypted with that key; the sync Lambda execution role; least-privilege
# read-config policies on both Lambda roles; and the EventBridge Scheduler
# invoke role. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

REGION=${REGION:-us-east-1}
PY=${PY:-.venv/bin/python}
ALIAS=alias/personal-finance-mcp
PARAM=/personal-finance-mcp/config
SERVER_ROLE=personal-finance-mcp-lambda
SYNC_ROLE=personal-finance-mcp-sync-lambda
SCHED_ROLE=personal-finance-mcp-scheduler
SYNC_FUNC=personal-finance-mcp-sync
# Shared-account admins to fence out of the finance secrets (edit if the set
# of other admins changes). Root and the two Lambda roles are NOT in this list.
DENY_USERS=("sumeetaher" "tilaksharma")

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "account: $ACCOUNT  region: $REGION"

# --- 1. Lambda execution roles (server pre-exists; sync may be new) ----------
ensure_lambda_role() {
    local role=$1
    if ! aws iam get-role --role-name "$role" >/dev/null 2>&1; then
        echo "creating role $role"
        aws iam create-role --role-name "$role" --assume-role-policy-document \
            '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
        aws iam attach-role-policy --role-name "$role" \
            --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
    fi
}
ensure_lambda_role "$SERVER_ROLE"
ensure_lambda_role "$SYNC_ROLE"
SERVER_ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${SERVER_ROLE}"
SYNC_ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${SYNC_ROLE}"

# --- 2. customer-managed KMS key (find by alias, else create) ----------------
KEY_ID=$(aws kms list-aliases --region "$REGION" \
    --query "Aliases[?AliasName=='${ALIAS}'].TargetKeyId | [0]" --output text 2>/dev/null || true)
if [ -z "$KEY_ID" ] || [ "$KEY_ID" = "None" ]; then
    echo "creating CMK"
    KEY_ID=$(aws kms create-key --region "$REGION" \
        --description "personal-finance-mcp config encryption (denies non-PF admins)" \
        --query KeyMetadata.KeyId --output text)
    aws kms create-alias --region "$REGION" --alias-name "$ALIAS" --target-key-id "$KEY_ID"
fi
KEY_ARN="arn:aws:kms:${REGION}:${ACCOUNT}:key/${KEY_ID}"
echo "CMK: $KEY_ID"

# --- 3. key policy: root full; app roles decrypt; named admins DENIED --------
DENY_ARNS=$(printf '"arn:aws:iam::%s:user/%s",' "$ACCOUNT" "${DENY_USERS[@]}")
DENY_ARNS="[${DENY_ARNS%,}]"
KEYPOLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Id": "personal-finance-mcp-key",
  "Statement": [
    {"Sid":"EnableRootAndIAMDelegation","Effect":"Allow",
     "Principal":{"AWS":"arn:aws:iam::${ACCOUNT}:root"},
     "Action":"kms:*","Resource":"*"},
    {"Sid":"AllowAppLambdaRolesDecrypt","Effect":"Allow",
     "Principal":{"AWS":["${SERVER_ROLE_ARN}","${SYNC_ROLE_ARN}"]},
     "Action":["kms:Decrypt","kms:DescribeKey"],"Resource":"*"},
    {"Sid":"DenyOtherAccountAdmins","Effect":"Deny",
     "Principal":{"AWS":${DENY_ARNS}},
     "Action":"kms:*","Resource":"*"}
  ]
}
EOF
)
aws kms put-key-policy --region "$REGION" --key-id "$KEY_ID" \
    --policy-name default --policy "$KEYPOLICY"
echo "key policy applied (root=full, app roles=decrypt, DENY: ${DENY_USERS[*]})"

# --- 4. push .env config into SSM SecureString under the CMK -----------------
# Secret never touches argv: a chmod-600 cli-input-json temp file is used.
SSM_INPUT=$(mktemp -t pfm-ssm-input)
chmod 600 "$SSM_INPUT"
trap 'rm -f "$SSM_INPUT"' EXIT
"$PY" - "$SSM_INPUT" "$PARAM" "$ALIAS" <<'PYEOF'
import json, os, sys
from dotenv import dotenv_values
out_path, param, key_id = sys.argv[1], sys.argv[2], sys.argv[3]
v = dotenv_values(".env")
fk = (v.get("FERNET_KEY") or "").strip()
if not fk:
    with open(os.path.expanduser("~/.config/personal-finance-mcp/fernet.key")) as f:
        fk = f.read().strip()
cfg = {
    "PLAID_CLIENT_ID": v.get("PLAID_CLIENT_ID"),
    "PLAID_SECRET": v.get("PLAID_SECRET"),
    "PLAID_ENV": v.get("PLAID_ENV") or "production",
    "DATABASE_URL": v.get("DATABASE_URL"),
    "FERNET_KEY": fk,
    "MCP_AUTH_TOKEN": (v.get("MCP_AUTH_TOKEN") or "").strip(),
}
missing = [k for k, val in cfg.items() if not val and k != "MCP_AUTH_TOKEN"]
if missing:
    sys.exit("missing in .env: " + ", ".join(missing))
json.dump({
    "Name": param, "Type": "SecureString", "KeyId": key_id,
    "Value": json.dumps(cfg), "Overwrite": True,
    "Description": "personal-finance-mcp runtime config (Plaid/DB/Fernet/auth)",
}, open(out_path, "w"))
PYEOF
aws ssm put-parameter --region "$REGION" --cli-input-json "file://$SSM_INPUT" >/dev/null
echo "SSM SecureString $PARAM written (encrypted with $ALIAS)"

# --- 5. least-privilege read-config policy on both Lambda roles --------------
PARAM_ARN="arn:aws:ssm:${REGION}:${ACCOUNT}:parameter${PARAM}"
READ_POLICY=$(cat <<EOF
{"Version":"2012-10-17","Statement":[
  {"Sid":"ReadConfigParam","Effect":"Allow","Action":"ssm:GetParameter","Resource":"${PARAM_ARN}"},
  {"Sid":"DecryptConfigKey","Effect":"Allow","Action":["kms:Decrypt","kms:DescribeKey"],"Resource":"${KEY_ARN}"}
]}
EOF
)
for role in "$SERVER_ROLE" "$SYNC_ROLE"; do
    aws iam put-role-policy --role-name "$role" \
        --policy-name pfm-read-config --policy-document "$READ_POLICY"
done
echo "pfm-read-config attached to $SERVER_ROLE and $SYNC_ROLE"

# --- 6. EventBridge Scheduler invoke role (invokes only the sync function) ---
if ! aws iam get-role --role-name "$SCHED_ROLE" >/dev/null 2>&1; then
    echo "creating role $SCHED_ROLE"
    aws iam create-role --role-name "$SCHED_ROLE" --assume-role-policy-document \
        "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"scheduler.amazonaws.com\"},\"Action\":\"sts:AssumeRole\",\"Condition\":{\"StringEquals\":{\"aws:SourceAccount\":\"${ACCOUNT}\"}}}]}" >/dev/null
fi
SYNC_FN_ARN="arn:aws:lambda:${REGION}:${ACCOUNT}:function:${SYNC_FUNC}"
aws iam put-role-policy --role-name "$SCHED_ROLE" --policy-name invoke-sync \
    --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"lambda:InvokeFunction\",\"Resource\":[\"${SYNC_FN_ARN}\",\"${SYNC_FN_ARN}:*\"]}]}"
echo "scheduler role $SCHED_ROLE can invoke $SYNC_FUNC"

echo
echo "security setup complete."
