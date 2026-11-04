#!/usr/bin/env bash
# Creates a CloudFormation change set for the independent TEAM audit stack.
# Pass --apply only after reviewing the generated change set in a non-production target.
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

: "${TEAM_ACCOUNT_PROFILE:?TEAM_ACCOUNT_PROFILE is required}"
: "${REGION:?REGION is required}"
: "${ORGANIZATION_ID:?ORGANIZATION_ID is required}"
: "${ORGANIZATION_TRAIL_HOME_REGION:?ORGANIZATION_TRAIL_HOME_REGION is required}"

TRAIL_HOME_REGION="${ORGANIZATION_TRAIL_HOME_REGION//[[:space:]]/}"

STACK_NAME="${AUDIT_STACK_NAME:-TEAM-CLOUDWATCH-AUDIT}"
CENTRAL_RETENTION_DAYS="${AUDIT_CENTRAL_RETENTION_DAYS:-7}"
SOURCE_RETENTION_DAYS="${AUDIT_SOURCE_RETENTION_DAYS:-1}"
CENTRAL_KMS_KEY_ARN="${AUDIT_CENTRAL_KMS_KEY_ARN:-}"
CENTRALIZATION_SOURCE_LOG_GROUP_SELECTION_CRITERIA="${CENTRALIZATION_SOURCE_LOG_GROUP_SELECTION_CRITERIA:-LogGroupName LIKE 'TEAM/CloudTrail%'}"

DEPLOY_ARGUMENTS=(
  cloudformation deploy
  --profile "${TEAM_ACCOUNT_PROFILE}"
  --region "${REGION}"
  --template-file "${SCRIPT_DIR}/template.yml"
  --stack-name "${STACK_NAME}"
  --parameter-overrides
  "OrganizationId=${ORGANIZATION_ID}"
  "OrganizationTrailHomeRegion=${TRAIL_HOME_REGION}"
  "CentralizationSourceLogGroupSelectionCriteria=${CENTRALIZATION_SOURCE_LOG_GROUP_SELECTION_CRITERIA}"
  "SourceRetentionDays=${SOURCE_RETENTION_DAYS}"
  "CentralRetentionDays=${CENTRAL_RETENTION_DAYS}"
  "CentralKmsKeyArn=${CENTRAL_KMS_KEY_ARN}"
  --no-fail-on-empty-changeset
)

if [[ -n "${TAGS:-}" ]]; then
  read -r -a TAG_ARGUMENTS <<< "${TAGS}"
  DEPLOY_ARGUMENTS+=(--tags "${TAG_ARGUMENTS[@]}")
fi

if [[ "${APPLY}" == "false" ]]; then
  DEPLOY_ARGUMENTS+=(--no-execute-changeset)
  echo "Creating an unexecuted audit-stack change set for review."
else
  echo "Applying the reviewed audit-stack change set."
fi

aws "${DEPLOY_ARGUMENTS[@]}"

if [[ "${APPLY}" == "true" ]]; then
  aws cloudformation update-termination-protection \
    --profile "${TEAM_ACCOUNT_PROFILE}" \
    --region "${REGION}" \
    --stack-name "${STACK_NAME}" \
    --enable-termination-protection >/dev/null
fi
