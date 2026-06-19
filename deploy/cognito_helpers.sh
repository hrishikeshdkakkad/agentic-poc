#!/usr/bin/env bash
# List users + their status, or revoke a user.
# Usage: ./deploy/cognito_helpers.sh list
#        ./deploy/cognito_helpers.sh revoke user@example.com
set -euo pipefail
REGION="${AWS_REGION:-us-east-1}"
POOL_ID="${USER_POOL_ID:-$(aws cognito-idp list-user-pools --max-results 60 --region "$REGION" \
  --query "UserPools[?Name=='personal-finance-mcp'].Id | [0]" --output text)}"
case "${1:-list}" in
  list)
    aws cognito-idp list-users --region "$REGION" --user-pool-id "$POOL_ID" \
      --query 'Users[].{email:Attributes[?Name==`email`].Value|[0],status:UserStatus,enabled:Enabled}' --output table ;;
  revoke)
    EMAIL="${2:?usage: revoke <email>}"
    aws cognito-idp admin-user-global-sign-out --region "$REGION" --user-pool-id "$POOL_ID" --username "$EMAIL"
    aws cognito-idp admin-disable-user --region "$REGION" --user-pool-id "$POOL_ID" --username "$EMAIL"
    echo "Revoked + disabled $EMAIL (delete with admin-delete-user if desired)." ;;
  *) echo "unknown command: $1" >&2; exit 1 ;;
esac
