#!/usr/bin/env bash
# Prints credentials for a machine-auth client in the namespaced TEAM pilot.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/parameters.sh"

NAMESPACE="${TEAM_DEPLOYMENT_NAMESPACE:-cloudwatch}"
APP_NAME="TEAM-IDC-APP-${NAMESPACE}"
PROFILE="${TEAM_ACCOUNT_PROFILE:-${ORG_MANAGEMENT_PROFILE:?deployment profile is required}}"
user_pool_id="$(aws cognito-idp list-user-pools --profile "${PROFILE}" --region "${REGION}" --max-results 60 --query "UserPools[?contains(Name, '${NAMESPACE}') && contains(Name, 'team06dbb7fc')].Id | [0]" --output text)"
user_pool_domain="$(aws cognito-idp describe-user-pool --profile "${PROFILE}" --region "${REGION}" --user-pool-id "${user_pool_id}" --query 'UserPool.Domain' --output text)"
client_id="$(aws cognito-idp list-user-pool-clients --profile "${PROFILE}" --region "${REGION}" --user-pool-id "${user_pool_id}" --query "UserPoolClients[?ClientName=='machine_auth'].ClientId | [0]" --output text)"
client="$(aws cognito-idp describe-user-pool-client --profile "${PROFILE}" --region "${REGION}" --user-pool-id "${user_pool_id}" --client-id "${client_id}" --query 'UserPoolClient' --output json)"
graph_endpoint="$(aws appsync list-graphql-apis --profile "${PROFILE}" --region "${REGION}" --query "graphqlApis[?contains(name, 'team-${NAMESPACE}')].uris.GRAPHQL | [0]" --output text)"

echo "token_endpoint=https://${user_pool_domain}.auth.${REGION}.amazoncognito.com/oauth2/token"
echo "graph_endpoint=${graph_endpoint}"
echo "client_id=$(jq -r '.ClientId' <<< "${client}")"
echo "client_secret=$(jq -r '.ClientSecret' <<< "${client}")"
echo "application=${APP_NAME}"
