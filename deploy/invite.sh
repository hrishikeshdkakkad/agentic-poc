#!/usr/bin/env bash
# Invite a user (invitation-only sign-up) and assign a role.
# Usage: ./deploy/invite.sh dad@example.com realestate-viewer
set -euo pipefail
REGION="${AWS_REGION:-us-east-1}"
EMAIL="${1:?usage: invite.sh <email> <role: admin|realestate-viewer>}"
ROLE="${2:?usage: invite.sh <email> <role>}"
POOL_ID="${USER_POOL_ID:-$(aws cognito-idp list-user-pools --max-results 60 --region "$REGION" \
  --query "UserPools[?Name=='personal-finance-mcp'].Id | [0]" --output text)}"
[ -n "$POOL_ID" ] && [ "$POOL_ID" != "None" ] || { echo "pool not found; run setup_cognito.sh first" >&2; exit 1; }

aws cognito-idp admin-create-user --region "$REGION" --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL >/dev/null
aws cognito-idp admin-add-user-to-group --region "$REGION" --user-pool-id "$POOL_ID" \
  --username "$EMAIL" --group-name "$ROLE"
echo "Invited $EMAIL as $ROLE. Cognito emailed a temporary password."
