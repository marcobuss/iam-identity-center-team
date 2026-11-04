#!/usr/bin/env bash
# Deploys the management-account organization trail that feeds TEAM centralization.
# Default mode creates an unexecuted change set; --apply executes the reviewed change.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARAMETERS_FILE="${SCRIPT_DIR}/../parameters.sh"
APPLY=false

if [[ "${1:-}" == "--apply" ]]; then
  APPLY=true
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--apply]" >&2
  exit 2
fi

if [[ ! -f "${PARAMETERS_FILE}" ]]; then
  echo "Missing ${PARAMETERS_FILE}; create it from deployment/parameters-template.sh." >&2
  exit 1
fi

# shellcheck source=/dev/null
source "${PARAMETERS_FILE}"

: "${ORG_MANAGEMENT_PROFILE:?ORG_MANAGEMENT_PROFILE is required}"
: "${REGION:?REGION is required}"
: "${AUDIT_SOURCE_MODE:?AUDIT_SOURCE_MODE is required}"
: "${ORGANIZATION_TRAIL_HOME_REGION:?ORGANIZATION_TRAIL_HOME_REGION is required}"

if [[ "${AUDIT_SOURCE_MODE}" != "managed-organization-trail" ]]; then
  echo "deploy-organization-trail.sh applies only when AUDIT_SOURCE_MODE=managed-organization-trail." >&2
  exit 1
fi

if [[ "${ORGANIZATION_TRAIL_HOME_REGION}" != "${REGION}" ]]; then
  echo "ORGANIZATION_TRAIL_HOME_REGION must match REGION for a managed organization trail." >&2
  exit 1
fi

STACK_NAME="${ORGANIZATION_TRAIL_STACK_NAME:-TEAM-ORGANIZATION-AUDIT}"
SOURCE_LOG_GROUP_NAME="${ORGANIZATION_TRAIL_SOURCE_LOG_GROUP_NAME:-TEAM/CloudTrailManagementEvents}"
SOURCE_RETENTION_DAYS="${AUDIT_SOURCE_RETENTION_DAYS:-1}"

DEPLOY_ARGUMENTS=(
  cloudformation deploy
  --profile "${ORG_MANAGEMENT_PROFILE}"
  --region "${REGION}"
  --template-file "${SCRIPT_DIR}/organization-trail-template.yml"
  --stack-name "${STACK_NAME}"
  --parameter-overrides
  "SourceLogGroupName=${SOURCE_LOG_GROUP_NAME}"
  "SourceRetentionDays=${SOURCE_RETENTION_DAYS}"
  --capabilities CAPABILITY_IAM
  --no-fail-on-empty-changeset
)

if [[ -n "${TAGS:-}" ]]; then
  read -r -a TAG_ARGUMENTS <<< "${TAGS}"
  DEPLOY_ARGUMENTS+=(--tags "${TAG_ARGUMENTS[@]}")
fi

if [[ "${APPLY}" == "false" ]]; then
  DEPLOY_ARGUMENTS+=(--no-execute-changeset)
  echo "Creating an unexecuted management-account organization-trail change set for review."
else
  echo "Applying the reviewed management-account organization-trail change set."
fi

aws "${DEPLOY_ARGUMENTS[@]}"

if [[ "${APPLY}" == "true" ]]; then
  aws cloudformation update-termination-protection \
    --profile "${ORG_MANAGEMENT_PROFILE}" \
    --region "${REGION}" \
    --stack-name "${STACK_NAME}" \
    --enable-termination-protection >/dev/null
fi
