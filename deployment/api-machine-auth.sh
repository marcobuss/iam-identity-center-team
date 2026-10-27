#!/usr/bin/env bash
# Creates machine-auth resources only in the namespaced TEAM user pool.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${1:-}" != "--apply" ]]; then
  echo "Usage: $0 --apply" >&2
  exit 2
fi
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/parameters.sh"

NAMESPACE="${TEAM_DEPLOYMENT_NAMESPACE:-cloudwatch}"
PROFILE="${TEAM_ACCOUNT_PROFILE:-${ORG_MANAGEMENT_PROFILE:?deployment profile is required}}"
user_pool_id="$(aws cognito-idp list-user-pools --profile "${PROFILE}" --region "${REGION}" --max-results 60 --query "UserPools[?contains(Name, '${NAMESPACE}') && contains(Name, 'team06dbb7fc')].Id | [0]" --output text)"

if ! aws cognito-idp describe-resource-server --profile "${PROFILE}" --region "${REGION}" --user-pool-id "${user_pool_id}" --identifier api >/dev/null 2>&1; then
  aws cognito-idp create-resource-server \
    --profile "${PROFILE}" --region "${REGION}" --user-pool-id "${user_pool_id}" \
    --identifier api --name api \
    --scopes ScopeName=admin,ScopeDescription="Provides Admin access to machine authentication flows" >/dev/null
fi

if [[ "$(aws cognito-idp list-user-pool-clients --profile "${PROFILE}" --region "${REGION}" --user-pool-id "${user_pool_id}" --query "UserPoolClients[?ClientName=='machine_auth'] | length(@)" --output text)" == "0" ]]; then
  aws cognito-idp create-user-pool-client \
    --profile "${PROFILE}" --region "${REGION}" --user-pool-id "${user_pool_id}" \
    --client-name machine_auth --generate-secret \
    --explicit-auth-flows ALLOW_REFRESH_TOKEN_AUTH \
    --supported-identity-providers COGNITO \
    --allowed-o-auth-flows client_credentials \
    --allowed-o-auth-scopes api/admin \
    --allowed-o-auth-flows-user-pool-client >/dev/null
fi
