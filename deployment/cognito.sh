#!/usr/bin/env bash
# Configures Cognito federation for the namespaced TEAM pilot only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${1:-}" != "--apply" ]]; then
  echo "Usage: $0 --apply" >&2
  exit 2
fi
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/parameters.sh"

NAMESPACE="${TEAM_DEPLOYMENT_NAMESPACE:-cloudwatch}"
APP_NAME="TEAM-IDC-APP-${NAMESPACE}"
BRANCH_NAME="${NAMESPACE}"
PROFILE="${TEAM_ACCOUNT_PROFILE:-${ORG_MANAGEMENT_PROFILE:?deployment profile is required}}"
DETAILS_FILE="${SCRIPT_DIR}/details.json"
[[ -f "${DETAILS_FILE}" ]] || { echo "Missing ${DETAILS_FILE}" >&2; exit 1; }

app_id="$(aws amplify list-apps --profile "${PROFILE}" --region "${REGION}" --query "apps[?name=='${APP_NAME}'].appId | [0]" --output text)"
default_domain="$(aws amplify get-app --profile "${PROFILE}" --region "${REGION}" --app-id "${app_id}" --query 'app.defaultDomain' --output text)"
user_pool_id="$(aws cognito-idp list-user-pools --profile "${PROFILE}" --region "${REGION}" --max-results 60 --query "UserPools[?contains(Name, '${NAMESPACE}') && contains(Name, 'team06dbb7fc')].Id | [0]" --output text)"
client_id="$(aws cognito-idp list-user-pool-clients --profile "${PROFILE}" --region "${REGION}" --user-pool-id "${user_pool_id}" --query "UserPoolClients[?contains(ClientName, 'clientWeb')].ClientId | [0]" --output text)"
application_domain="${BRANCH_NAME}.${default_domain}"

if aws cognito-idp describe-identity-provider --profile "${PROFILE}" --region "${REGION}" --user-pool-id "${user_pool_id}" --provider-name IDC >/dev/null 2>&1; then
  aws cognito-idp update-identity-provider --profile "${PROFILE}" --region "${REGION}" --user-pool-id "${user_pool_id}" --provider-name IDC --provider-details "file://${DETAILS_FILE}" --attribute-mapping email=Email --idp-identifiers team >/dev/null
else
  aws cognito-idp create-identity-provider --profile "${PROFILE}" --region "${REGION}" --user-pool-id "${user_pool_id}" --provider-name IDC --provider-type SAML --provider-details "file://${DETAILS_FILE}" --attribute-mapping email=Email --idp-identifiers team >/dev/null
fi

aws cognito-idp update-user-pool-client \
  --profile "${PROFILE}" \
  --region "${REGION}" \
  --user-pool-id "${user_pool_id}" \
  --client-id "${client_id}" \
  --refresh-token-validity 1 \
  --supported-identity-providers IDC \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes phone email openid profile aws.cognito.signin.user.admin \
  --logout-urls "https://${application_domain}/" \
  --callback-urls "https://${application_domain}/" \
  --allowed-o-auth-flows-user-pool-client >/dev/null
