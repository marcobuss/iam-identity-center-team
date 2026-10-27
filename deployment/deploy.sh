#!/usr/bin/env bash
# Deploys a namespaced, fresh CloudWatch-backed TEAM application.
# This script does not support updating an existing CloudTrail Lake deployment.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PARAMETERS_FILE="${SCRIPT_DIR}/parameters.sh"

if [[ "${1:-}" != "--apply" ]]; then
  echo "Usage: $0 --apply" >&2
  echo "Without --apply no repository, branch, or CloudFormation resources are changed." >&2
  exit 2
fi

if [[ ! -f "${PARAMETERS_FILE}" ]]; then
  echo "Missing ${PARAMETERS_FILE}; create it from deployment/parameters-template.sh." >&2
  exit 1
fi

# shellcheck source=/dev/null
source "${PARAMETERS_FILE}"

: "${REGION:?REGION is required}"
: "${IDC_LOGIN_URL:?IDC_LOGIN_URL is required}"
: "${TEAM_ADMIN_GROUP:?TEAM_ADMIN_GROUP is required}"
: "${TEAM_AUDITOR_GROUP:?TEAM_AUDITOR_GROUP is required}"

DEPLOYMENT_NAMESPACE="${TEAM_DEPLOYMENT_NAMESPACE:-cloudwatch}"
STACK_NAME="TEAM-IDC-APP-${DEPLOYMENT_NAMESPACE}"
REPOSITORY_NAME="team-idc-app-${DEPLOYMENT_NAMESPACE}"
BRANCH_NAME="${DEPLOYMENT_NAMESPACE}"
CACHE_TTL="${CACHE_TTL:-604800}"
TEAM_ACCOUNT="${TEAM_ACCOUNT:-}"
SECRET_NAME="${SECRET_NAME:-}"
TAGS="${TAGS:-}"
UI_DOMAIN="${UI_DOMAIN:-}"

if [[ -n "${TEAM_ACCOUNT}" ]]; then
  : "${TEAM_ACCOUNT_PROFILE:?TEAM_ACCOUNT_PROFILE is required}"
  DEPLOYMENT_PROFILE="${TEAM_ACCOUNT_PROFILE}"
else
  : "${ORG_MANAGEMENT_PROFILE:?ORG_MANAGEMENT_PROFILE is required}"
  DEPLOYMENT_PROFILE="${ORG_MANAGEMENT_PROFILE}"
fi

if [[ -z "${SECRET_NAME}" ]]; then
  if ! aws codecommit get-repository \
    --profile "${DEPLOYMENT_PROFILE}" \
    --region "${REGION}" \
    --repository-name "${REPOSITORY_NAME}" >/dev/null 2>&1; then
    aws codecommit create-repository \
      --profile "${DEPLOYMENT_PROFILE}" \
      --region "${REGION}" \
      --repository-name "${REPOSITORY_NAME}" \
      --repository-description "Namespaced CloudWatch-backed TEAM application" >/dev/null
  fi

  DEPLOYMENT_REMOTE="team-cloudwatch-deployment"
  if git -C "${REPOSITORY_ROOT}" remote get-url "${DEPLOYMENT_REMOTE}" >/dev/null 2>&1; then
    git -C "${REPOSITORY_ROOT}" remote set-url \
      "${DEPLOYMENT_REMOTE}" "codecommit::${REGION}://${REPOSITORY_NAME}"
  else
    git -C "${REPOSITORY_ROOT}" remote add \
      "${DEPLOYMENT_REMOTE}" "codecommit::${REGION}://${REPOSITORY_NAME}"
  fi
  git -C "${REPOSITORY_ROOT}" push -u "${DEPLOYMENT_REMOTE}" "HEAD:${BRANCH_NAME}"
fi

PARAMETER_OVERRIDES=(
  "Login=${IDC_LOGIN_URL}"
  "DeploymentNamespace=${DEPLOYMENT_NAMESPACE}"
  "teamAdminGroup=${TEAM_ADMIN_GROUP}"
  "teamAuditGroup=${TEAM_AUDITOR_GROUP}"
  "teamAccount=${TEAM_ACCOUNT}"
  "cacheTTL=${CACHE_TTL}"
)

if [[ -n "${UI_DOMAIN}" ]]; then
  PARAMETER_OVERRIDES+=("customAmplifyDomain=${UI_DOMAIN}")
fi
if [[ -n "${SECRET_NAME}" ]]; then
  PARAMETER_OVERRIDES+=(
    "customRepository=Yes"
    "customRepositorySecretName=${SECRET_NAME}"
  )
fi

DEPLOY_ARGUMENTS=(
  cloudformation deploy
  --profile "${DEPLOYMENT_PROFILE}"
  --region "${REGION}"
  --template-file "${SCRIPT_DIR}/template.yml"
  --stack-name "${STACK_NAME}"
  --parameter-overrides "${PARAMETER_OVERRIDES[@]}"
  --capabilities CAPABILITY_NAMED_IAM
  --no-fail-on-empty-changeset
)

if [[ -n "${TAGS}" ]]; then
  read -r -a TAG_ARGUMENTS <<< "${TAGS}"
  DEPLOY_ARGUMENTS+=(--tags "${TAG_ARGUMENTS[@]}")
fi

aws "${DEPLOY_ARGUMENTS[@]}"
