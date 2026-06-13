#!/usr/bin/env bash
# Assert the hardened posture for personal-finance-mcp. Read-only. Prints
# PASS/FAIL per check; exits non-zero if any check fails. Never prints secret
# values (env checks inspect variable NAMES only).
set -uo pipefail
cd "$(dirname "$0")/.."

REGION=${REGION:-us-east-1}
ALIAS=alias/personal-finance-mcp
PARAM=/personal-finance-mcp/config
SERVER=personal-finance-mcp
SYNC=personal-finance-mcp-sync
DENY_USERS=("sumeetaher" "tilaksharma")
SECRET_KEYS=("PLAID_SECRET" "FERNET_KEY" "DATABASE_URL" "PLAID_CLIENT_ID")

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
fail=0
pass() { echo "  PASS  $1"; }
bad()  { echo "  FAIL  $1"; fail=1; }

echo "== KMS key policy denies the other admins =="
KEY_ID=$(aws kms list-aliases --region "$REGION" \
    --query "Aliases[?AliasName=='${ALIAS}'].TargetKeyId | [0]" --output text)
if [ -z "$KEY_ID" ] || [ "$KEY_ID" = "None" ]; then
    bad "CMK $ALIAS not found"
else
    POL=$(aws kms get-key-policy --region "$REGION" --key-id "$KEY_ID" \
        --policy-name default --query Policy --output text)
    DENY=$(printf '%s' "$POL" | python3 -c 'import json,sys; p=json.load(sys.stdin); print(next((s for s in p["Statement"] if s["Sid"]=="DenyOtherAccountAdmins"),""))')
    for u in "${DENY_USERS[@]}"; do
        if printf '%s' "$DENY" | grep -q "user/$u"; then pass "deny includes $u"; else bad "deny missing $u"; fi
    done
    printf '%s' "$DENY" | grep -q "'Effect': 'Deny'" && pass "explicit Deny present" || bad "no Deny effect"
fi

echo "== SSM config is a SecureString under the CMK =="
PTYPE=$(aws ssm describe-parameters --region "$REGION" \
    --parameter-filters "Key=Name,Values=$PARAM" --query 'Parameters[0].Type' --output text 2>/dev/null)
[ "$PTYPE" = "SecureString" ] && pass "$PARAM is SecureString" || bad "$PARAM type=$PTYPE (want SecureString)"
PKEY=$(aws ssm describe-parameters --region "$REGION" \
    --parameter-filters "Key=Name,Values=$PARAM" --query 'Parameters[0].KeyId' --output text 2>/dev/null)
case "$PKEY" in
    "$ALIAS"|*"$KEY_ID"*) pass "encrypted with $ALIAS" ;;
    *) bad "encrypted with $PKEY (want $ALIAS)" ;;
esac

echo "== neither function exposes plaintext secrets (names only) =="
for fn in "$SERVER" "$SYNC"; do
    KEYS=$(aws lambda get-function-configuration --function-name "$fn" --region "$REGION" \
        --query 'Environment.Variables' --output json 2>/dev/null | python3 -c 'import json,sys
try: print(" ".join(json.load(sys.stdin).keys()))
except Exception: print("")')
    if [ -z "$KEYS" ]; then bad "$fn not found / no env"; continue; fi
    leaked=""
    for k in "${SECRET_KEYS[@]}"; do echo "$KEYS" | grep -qw "$k" && leaked="$leaked $k"; done
    [ -z "$leaked" ] && pass "$fn env has no plaintext secrets" || bad "$fn LEAKS:$leaked"
    echo "$KEYS" | grep -qw PFM_CONFIG_PARAM && pass "$fn points at SSM config" || bad "$fn missing PFM_CONFIG_PARAM"
done

echo "== sync function has no public Function URL =="
if aws lambda get-function-url-config --function-name "$SYNC" --region "$REGION" >/dev/null 2>&1; then
    bad "$SYNC has a Function URL (should not)"
else
    pass "$SYNC has no Function URL"
fi

echo "== schedule exists =="
SCHED=$(aws scheduler get-schedule --name "$SYNC" --region "$REGION" --query 'ScheduleExpression' --output text 2>/dev/null)
[ -n "$SCHED" ] && [ "$SCHED" != "None" ] && pass "schedule: $SCHED" || bad "no schedule for $SYNC"

echo
[ "$fail" = 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit $fail
