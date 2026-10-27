#!/usr/bin/env bash
# Inspects or enables CloudWatch telemetry configuration and delegated administration.
# The default mode is read-only; pass --apply for organization-level changes.
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
: "${TEAM_ACCOUNT:?TEAM_ACCOUNT is required}"
: "${REGION:?REGION is required}"
: "${AUDIT_SOURCE_REGIONS:?AUDIT_SOURCE_REGIONS is required as a comma-separated list}"

SERVICE_PRINCIPAL="observabilityadmin.amazonaws.com"
POLL_SECONDS="${TELEMETRY_EVALUATION_POLL_SECONDS:-15}"
MAX_ATTEMPTS="${TELEMETRY_EVALUATION_MAX_ATTEMPTS:-20}"

is_delegated_administrator() {
  aws organizations list-delegated-administrators \
    --profile "${ORG_MANAGEMENT_PROFILE}" \
    --service-principal "${SERVICE_PRINCIPAL}" \
    --query "DelegatedAdministrators[?Id=='${TEAM_ACCOUNT}'] | length(@)" \
    --output text
}

ensure_config_service_linked_role() {
  if aws iam get-role \
    --profile "${ORG_MANAGEMENT_PROFILE}" \
    --role-name AWSServiceRoleForConfig >/dev/null 2>&1; then
    return
  fi

  aws iam create-service-linked-role \
    --profile "${ORG_MANAGEMENT_PROFILE}" \
    --aws-service-name config.amazonaws.com >/dev/null
}

inspect_configuration() {
  local delegated_count
  delegated_count="$(is_delegated_administrator)"
  if [[ "${delegated_count}" == "1" ]]; then
    echo "CloudWatch delegated administrator is configured."
  else
    echo "CloudWatch delegated administrator is not configured."
  fi

  aws observabilityadmin get-telemetry-evaluation-status-for-organization \
    --profile "${ORG_MANAGEMENT_PROFILE}" \
    --region "${REGION}" \
    --output json || true
}

start_telemetry_evaluation() {
  local -a requested_regions=()
  local -a additional_regions=()
  IFS=',' read -r -a requested_regions <<< "${AUDIT_SOURCE_REGIONS}"

  for source_region in "${requested_regions[@]}"; do
    source_region="${source_region//[[:space:]]/}"
    if [[ -n "${source_region}" && "${source_region}" != "${REGION}" ]]; then
      additional_regions+=("${source_region}")
    fi
  done

  if [[ "${#additional_regions[@]}" -gt 0 ]]; then
    aws observabilityadmin start-telemetry-evaluation-for-organization \
      --profile "${ORG_MANAGEMENT_PROFILE}" \
      --region "${REGION}" \
      --regions "${additional_regions[@]}"
  else
    aws observabilityadmin start-telemetry-evaluation-for-organization \
      --profile "${ORG_MANAGEMENT_PROFILE}" \
      --region "${REGION}"
  fi
}

wait_for_telemetry_evaluation() {
  local attempt evaluation_status failure_reason

  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1)); do
    evaluation_status="$(aws observabilityadmin get-telemetry-evaluation-status-for-organization \
      --profile "${ORG_MANAGEMENT_PROFILE}" \
      --region "${REGION}" \
      --query 'Status' \
      --output text)"

    case "${evaluation_status}" in
      RUNNING)
        echo "CloudWatch telemetry evaluation is RUNNING."
        return 0
        ;;
      FAILED_START|FAILED_STOP)
        failure_reason="$(aws observabilityadmin get-telemetry-evaluation-status-for-organization \
          --profile "${ORG_MANAGEMENT_PROFILE}" \
          --region "${REGION}" \
          --query 'FailureReason' \
          --output text)"
        echo "CloudWatch telemetry evaluation ${evaluation_status}: ${failure_reason}" >&2
        return 1
        ;;
      STARTING|NOT_STARTED|STOPPING|STOPPED)
        echo "Waiting for CloudWatch telemetry evaluation: ${evaluation_status} (${attempt}/${MAX_ATTEMPTS})"
        sleep "${POLL_SECONDS}"
        ;;
      *)
        echo "Unexpected CloudWatch telemetry evaluation status: ${evaluation_status}" >&2
        return 1
        ;;
    esac
  done

  echo "CloudWatch telemetry evaluation did not reach RUNNING after ${MAX_ATTEMPTS} attempts." >&2
  return 1
}

if [[ "${APPLY}" == "false" ]]; then
  echo "Inspecting CloudWatch organization telemetry configuration; no changes will be made."
  inspect_configuration
  exit 0
fi

aws organizations enable-aws-service-access \
  --profile "${ORG_MANAGEMENT_PROFILE}" \
  --service-principal "${SERVICE_PRINCIPAL}"

if [[ "$(is_delegated_administrator)" != "1" ]]; then
  aws organizations register-delegated-administrator \
    --profile "${ORG_MANAGEMENT_PROFILE}" \
    --account-id "${TEAM_ACCOUNT}" \
    --service-principal "${SERVICE_PRINCIPAL}"
fi

ensure_config_service_linked_role
start_telemetry_evaluation
wait_for_telemetry_evaluation
inspect_configuration
