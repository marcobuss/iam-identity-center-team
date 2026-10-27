#!/usr/bin/env bash
# Prints IAM Identity Center integration values for the namespaced TEAM pilot.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/parameters.sh"

NAMESPACE="${TEAM_DEPLOYMENT_NAMESPACE:-cloudwatch}"
APP_NAME="TEAM-IDC-APP-${NAMESPACE}"
BRANCH_NAME="${NAMESPACE}"
PROFILE="${TEAM_ACCOUNT_PROFILE:-${ORG_MANAGEMENT_PROFILE:?deployment profile is required}}"

app_id="$(aws amplify list-apps --profile "${PROFILE}" --region "${REGION}" --query "apps[?name=='${APP_NAME}'].appId | [0]" --output text)"
default_domain="$(aws amplify get-app --profile "${PROFILE}" --region "${REGION}" --app-id "${app_id}" --query 'app.defaultDomain' --output text)"
user_pool_id="$(aws cognito-idp list-user-pools --profile "${PROFILE}" --region "${REGION}" --max-results 60 --query "UserPools[?contains(Name, '${NAMESPACE}') && contains(Name, 'team06dbb7fc')].Id | [0]" --output text)"
user_pool_domain="$(aws cognito-idp describe-user-pool --profile "${PROFILE}" --region "${REGION}" --user-pool-id "${user_pool_id}" --query 'UserPool.Domain' --output text)"
web_client_id="$(aws cognito-idp list-user-pool-clients --profile "${PROFILE}" --region "${REGION}" --user-pool-id "${user_pool_id}" --query "UserPoolClients[?contains(ClientName, 'clientWeb')].ClientId | [0]" --output text)"

application_domain="${BRANCH_NAME}.${default_domain}"
custom_domain="$(aws amplify list-domain-associations --profile "${PROFILE}" --region "${REGION}" --app-id "${app_id}" --query 'domainAssociations[0].domainName' --output text 2>/dev/null || true)"
if [[ -n "${custom_domain}" && "${custom_domain}" != "None" ]]; then
  custom_prefix="$(aws amplify list-domain-associations --profile "${PROFILE}" --region "${REGION}" --app-id "${app_id}" --query "domainAssociations[0].subDomains[?subDomainSetting.branchName=='${BRANCH_NAME}'].subDomainSetting.prefix | [0]" --output text)"
  application_domain="${custom_domain}"
  if [[ -n "${custom_prefix}" && "${custom_prefix}" != "None" ]]; then
    application_domain="${custom_prefix}.${custom_domain}"
  fi
fi

hosted_ui_domain="${user_pool_domain}.auth.${REGION}.amazoncognito.com"
echo "application_start_url=https://${hosted_ui_domain}/authorize?client_id=${web_client_id}&response_type=code&scope=aws.cognito.signin.user.admin+email+openid+phone+profile&redirect_uri=https://${application_domain}/&idp_identifier=team"
echo "application_acs_url=https://${hosted_ui_domain}/saml2/idpresponse"
echo "application_saml_audience=urn:amazon:cognito:sp:${user_pool_id}"
