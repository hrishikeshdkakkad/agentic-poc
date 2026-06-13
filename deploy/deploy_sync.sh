#!/usr/bin/env bash
# Deploy the scheduled Plaid sync Lambda (personal-finance-mcp-sync) and its
# EventBridge Scheduler trigger. Reuses deploy/lambda.zip (run build_lambda.sh
# first) and the security resources from setup_security.sh. Idempotent.
#
# The sync function has NO Function URL — it is invoked only by the schedule,
# which assumes the personal-finance-mcp-scheduler role (no Lambda resource
# permission needed). Secrets come from SSM at cold start; env holds only
# non-secret pointers.
set -euo pipefail
cd "$(dirname "$0")/.."

REGION=${REGION:-us-east-1}
FUNC=personal-finance-mcp-sync
RUNTIME=python3.11
ARCH=arm64
MEMORY=512
TIMEOUT=300
PARAM=/personal-finance-mcp/config
ZIP=deploy/lambda.zip
RATE=${SYNC_RATE:-"rate(4 hours)"}   # ~6x/day; override e.g. SYNC_RATE="rate(5 hours)"

[ -f "$ZIP" ] || { echo "run deploy/build_lambda.sh first" >&2; exit 1; }

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/personal-finance-mcp-sync-lambda"
SCHED_ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/personal-finance-mcp-scheduler"
SYNC_FN_ARN="arn:aws:lambda:${REGION}:${ACCOUNT}:function:${FUNC}"

# Non-secret pointer env only.
ENVJSON='{"Variables":{"PFM_CONFIG_PARAM":"'"$PARAM"'","HORIZON":"1","PFM_SECRETS_DIR":"/tmp/pfm-secrets"}}'

if aws lambda get-function --function-name "$FUNC" --region "$REGION" >/dev/null 2>&1; then
    echo "updating $FUNC code"
    aws lambda update-function-code --function-name "$FUNC" \
        --zip-file "fileb://$ZIP" --region "$REGION" >/dev/null
    aws lambda wait function-updated-v2 --function-name "$FUNC" --region "$REGION"
    echo "updating $FUNC configuration"
    aws lambda update-function-configuration --function-name "$FUNC" \
        --handler sync.lambda_handler --runtime "$RUNTIME" \
        --environment "$ENVJSON" --memory-size "$MEMORY" --timeout "$TIMEOUT" \
        --region "$REGION" >/dev/null
    aws lambda wait function-updated-v2 --function-name "$FUNC" --region "$REGION"
else
    echo "creating $FUNC"
    created=0
    for attempt in 1 2 3 4 5 6; do
        if aws lambda create-function --function-name "$FUNC" \
            --runtime "$RUNTIME" --architectures "$ARCH" \
            --handler sync.lambda_handler --role "$ROLE_ARN" \
            --zip-file "fileb://$ZIP" --environment "$ENVJSON" \
            --memory-size "$MEMORY" --timeout "$TIMEOUT" \
            --region "$REGION" >/dev/null 2>deploy/.sync-create-err; then
            created=1; break
        fi
        if grep -q "cannot be assumed" deploy/.sync-create-err; then
            echo "  waiting for IAM role propagation (attempt $attempt)"; sleep 8
        else
            cat deploy/.sync-create-err >&2; rm -f deploy/.sync-create-err; exit 1
        fi
    done
    rm -f deploy/.sync-create-err
    [ "$created" = 1 ] || { echo "create-function kept failing" >&2; exit 1; }
    aws lambda wait function-active-v2 --function-name "$FUNC" --region "$REGION"
fi

# EventBridge Scheduler schedule (create or update). Retry x2 absorbs a
# transient Plaid/Neon blip before the next scheduled run.
TARGET="{\"Arn\":\"${SYNC_FN_ARN}\",\"RoleArn\":\"${SCHED_ROLE_ARN}\",\"RetryPolicy\":{\"MaximumRetryAttempts\":2}}"
if aws scheduler get-schedule --name "$FUNC" --region "$REGION" >/dev/null 2>&1; then
    aws scheduler update-schedule --name "$FUNC" --region "$REGION" \
        --schedule-expression "$RATE" --flexible-time-window '{"Mode":"OFF"}' \
        --target "$TARGET" >/dev/null
else
    aws scheduler create-schedule --name "$FUNC" --region "$REGION" \
        --schedule-expression "$RATE" --flexible-time-window '{"Mode":"OFF"}' \
        --target "$TARGET" >/dev/null
fi
echo "deployed $FUNC + schedule ($RATE)"
