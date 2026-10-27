#!/usr/bin/env bash
# Deletes only a specifically confirmed namespaced TEAM application stack.
# The independent audit stack and any Lake deployment are intentionally untouched.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/parameters.sh"

NAMESPACE="${TEAM_DEPLOYMENT_NAMESPACE:-cloudwatch}"
APP_NAME="TEAM-IDC-APP-${NAMESPACE}"
BRANCH_NAME="${NAMESPACE}"
REPOSITORY_NAME="team-idc-app-${NAMESPACE}"
PROFILE="${TEAM_ACCOUNT_PROFILE:-${ORG_MANAGEMENT_PROFILE:?deployment profile is required}}"

if [[ "${1:-}" != "--apply" || "${2:-}" != "${APP_NAME}" ]]; then
  echo "Usage: $0 --apply ${APP_NAME}" >&2
  echo "The independent audit stack is retained and must be managed separately." >&2
  exit 2
fi

app_id="$(aws amplify list-apps --profile "${PROFILE}" --region "${REGION}" --query "apps[?name=='${APP_NAME}'].appId | [0]" --output text)"
backend_stack="$(aws amplify get-backend-environment --profile "${PROFILE}" --region "${REGION}" --app-id "${app_id}" --environment-name "${BRANCH_NAME}" --query 'backendEnvironment.stackName' --output text)"

aws cloudformation delete-stack --profile "${PROFILE}" --region "${REGION}" --stack-name "${backend_stack}"
aws cloudformation delete-stack --profile "${PROFILE}" --region "${REGION}" --stack-name "${APP_NAME}"

if [[ -z "${SECRET_NAME:-}" ]]; then
  aws codecommit delete-repository --profile "${PROFILE}" --region "${REGION}" --repository-name "${REPOSITORY_NAME}" >/dev/null
fi
