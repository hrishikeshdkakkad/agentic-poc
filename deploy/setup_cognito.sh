#!/usr/bin/env bash
# Idempotent AWS Cognito setup for the personal-finance dashboard.
# Re-runnable: creates-or-reuses the pool/domain/client/groups and updates callback URLs.
# Usage: CALLBACK_BASE="https://your-app.vercel.app" ./deploy/setup_cognito.sh
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
POOL_NAME="personal-finance-mcp"
CLIENT_NAME="personal-finance-dashboard"
CALLBACK_BASE="${CALLBACK_BASE:?set CALLBACK_BASE to your Vercel prod URL, e.g. https://app.vercel.app}"
DEV_CALLBACK_BASE="${DEV_CALLBACK_BASE:-http://localhost:3000}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
DOMAIN_PREFIX="${COGNITO_DOMAIN_PREFIX:-pf-mcp-${ACCOUNT_ID}}"

cb() { printf '%s/api/auth/callback/cognito' "$1"; }
CALLBACKS="$(cb "$CALLBACK_BASE"),$(cb "$DEV_CALLBACK_BASE")"
LOGOUTS="${CALLBACK_BASE}/login,${DEV_CALLBACK_BASE}/login"

echo "Region=$REGION Account=$ACCOUNT_ID Domain=$DOMAIN_PREFIX" >&2

# 1) Find or create the user pool (invitation-only, strong password, MFA off).
POOL_ID="$(aws cognito-idp list-user-pools --max-results 60 --region "$REGION" \
  --query "UserPools[?Name=='${POOL_NAME}'].Id | [0]" --output text)"
if [ "$POOL_ID" = "None" ] || [ -z "$POOL_ID" ]; then
  POOL_ID="$(aws cognito-idp create-user-pool --region "$REGION" --pool-name "$POOL_NAME" \
    --admin-create-user-config '{"AllowAdminCreateUserOnly":true}' \
    --auto-verified-attributes email \
    --username-attributes email \
    --mfa-configuration OFF \
    --account-recovery-setting '{"RecoveryMechanisms":[{"Priority":1,"Name":"verified_email"}]}' \
    --policies '{"PasswordPolicy":{"MinimumLength":12,"RequireUppercase":true,"RequireLowercase":true,"RequireNumbers":true,"RequireSymbols":true,"TemporaryPasswordValidityDays":7}}' \
    --query 'UserPool.Id' --output text)"
  echo "Created pool $POOL_ID" >&2
else
  echo "Reusing pool $POOL_ID" >&2
fi

# 2) Hosted UI domain (ignore error if it already exists / not available).
aws cognito-idp create-user-pool-domain --region "$REGION" \
  --domain "$DOMAIN_PREFIX" --user-pool-id "$POOL_ID" 2>/dev/null \
  && echo "Created domain $DOMAIN_PREFIX" >&2 \
  || echo "Domain exists or unavailable; reusing $DOMAIN_PREFIX" >&2

# 3) Groups = roles.
for g in admin realestate-viewer; do
  aws cognito-idp create-group --region "$REGION" --user-pool-id "$POOL_ID" --group-name "$g" 2>/dev/null \
    && echo "Created group $g" >&2 \
    || echo "Group $g exists" >&2
done

# 4) App client (confidential): create or update callbacks/scopes.
CLIENT_ID="$(aws cognito-idp list-user-pool-clients --region "$REGION" --user-pool-id "$POOL_ID" --max-results 60 \
  --query "UserPoolClients[?ClientName=='${CLIENT_NAME}'].ClientId | [0]" --output text)"
COMMON_CLIENT_ARGS=(--region "$REGION" --user-pool-id "$POOL_ID"
  --allowed-o-auth-flows code --allowed-o-auth-scopes openid email profile
  --allowed-o-auth-flows-user-pool-client
  --supported-identity-providers COGNITO
  --callback-urls "$CALLBACKS" --logout-urls "$LOGOUTS"
  --explicit-auth-flows ALLOW_REFRESH_TOKEN_AUTH ALLOW_USER_SRP_AUTH
  --prevent-user-existence-errors ENABLED
  --enable-token-revocation
  --access-token-validity 60 --id-token-validity 60 --refresh-token-validity 30
  --token-validity-units '{"AccessToken":"minutes","IdToken":"minutes","RefreshToken":"days"}')
if [ "$CLIENT_ID" = "None" ] || [ -z "$CLIENT_ID" ]; then
  CLIENT_ID="$(aws cognito-idp create-user-pool-client --client-name "$CLIENT_NAME" \
    --generate-secret "${COMMON_CLIENT_ARGS[@]}" --query 'UserPoolClient.ClientId' --output text)"
  echo "Created client $CLIENT_ID" >&2
else
  aws cognito-idp update-user-pool-client --client-id "$CLIENT_ID" "${COMMON_CLIENT_ARGS[@]}" >/dev/null
  echo "Updated client $CLIENT_ID" >&2
fi

CLIENT_SECRET="$(aws cognito-idp describe-user-pool-client --region "$REGION" \
  --user-pool-id "$POOL_ID" --client-id "$CLIENT_ID" --query 'UserPoolClient.ClientSecret' --output text)"

cat <<EOF

# ---- Cognito ready. Put these in Vercel env (server-only) ----
AUTH_COGNITO_ID=$CLIENT_ID
AUTH_COGNITO_SECRET=$CLIENT_SECRET
AUTH_COGNITO_ISSUER=https://cognito-idp.${REGION}.amazonaws.com/${POOL_ID}
COGNITO_HOSTED_DOMAIN=https://${DOMAIN_PREFIX}.auth.${REGION}.amazoncognito.com
# USER_POOL_ID=$POOL_ID  (for deploy/invite.sh)
EOF
