#!/usr/bin/env bash
# Configures TEAM delegated administration for a fresh CloudWatch-backed deployment.
# The default mode is read-only; pass --apply for organization-level changes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARAMETERS_FILE="${SCRIPT_DIR}/parameters.sh"
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
: "${TEAM_ACCOUNT:?TEAM_ACCOUNT is required}"
: "${REGION:?REGION is required}"

is_delegated_administrator() {
  local service_principal="$1"
  aws organizations list-delegated-administrators \
    --profile "${ORG_MANAGEMENT_PROFILE}" \
    --service-principal "${service_principal}" \
    --query "DelegatedAdministrators[?Id=='${TEAM_ACCOUNT}'] | length(@)" \
    --output text
}

ensure_delegated_administrator() {
  local service_principal="$1"
  local service_label="$2"

  if [[ "$(is_delegated_administrator "${service_principal}")" == "1" ]]; then
    echo "${service_label} delegated administrator is configured."
    return
  fi

  if [[ "${APPLY}" == "false" ]]; then
    echo "${service_label} delegated administrator is not configured."
    return
  fi

  aws organizations enable-aws-service-access \
    --profile "${ORG_MANAGEMENT_PROFILE}" \
    --service-principal "${service_principal}"
  aws organizations register-delegated-administrator \
    --profile "${ORG_MANAGEMENT_PROFILE}" \
    --account-id "${TEAM_ACCOUNT}" \
    --service-principal "${service_principal}"
  echo "${service_label} delegated administrator was configured."
}

ensure_delegated_administrator "account.amazonaws.com" "Account Management"
ensure_delegated_administrator "sso.amazonaws.com" "IAM Identity Center"

if [[ "${APPLY}" == "true" ]]; then
  "${SCRIPT_DIR}/cloudwatch-audit/bootstrap.sh" --apply
else
  "${SCRIPT_DIR}/cloudwatch-audit/bootstrap.sh"
fi

# CloudTrail Lake delegated administration is intentionally not changed. Existing
# Lake deployments can continue running in parallel during the pilot.
