#!/usr/bin/env bash
# Validates or explicitly configures CloudWatch Logs delivery for a customer-owned trail.
# Default mode is read-only. --apply creates the source log group and delivery role when
# absent, then updates only the CloudWatch Logs fields on the named existing trail.
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

: "${AUDIT_SOURCE_MODE:?AUDIT_SOURCE_MODE is required}"
: "${EXISTING_TRAIL_NAME:?EXISTING_TRAIL_NAME is required}"
: "${EXISTING_TRAIL_OWNER_PROFILE:?EXISTING_TRAIL_OWNER_PROFILE is required}"
: "${EXISTING_TRAIL_SOURCE_LOG_GROUP_NAME:?EXISTING_TRAIL_SOURCE_LOG_GROUP_NAME is required}"
: "${EXISTING_TRAIL_SOURCE_LOG_GROUP_REGION:?EXISTING_TRAIL_SOURCE_LOG_GROUP_REGION is required}"

if [[ "${AUDIT_SOURCE_MODE}" != "existing-trail" ]]; then
  echo "AUDIT_SOURCE_MODE must be existing-trail for this script." >&2
  exit 1
fi

SOURCE_REGION="${EXISTING_TRAIL_SOURCE_LOG_GROUP_REGION}"
SOURCE_GROUP="${EXISTING_TRAIL_SOURCE_LOG_GROUP_NAME}"
ROLE_NAME="${EXISTING_TRAIL_CLOUDWATCH_ROLE_NAME:-TEAMExistingTrailCloudWatchLogsDelivery}"
RETENTION_DAYS="${AUDIT_SOURCE_RETENTION_DAYS:-1}"

source_group_lower="$(printf '%s' "${SOURCE_GROUP}" | tr '[:upper:]' '[:lower:]')"
if [[ "${source_group_lower}" == aws/* ]]; then
  echo "EXISTING_TRAIL_SOURCE_LOG_GROUP_NAME cannot use the reserved aws/ prefix." >&2
  exit 1
fi

owner_identity="$(aws sts get-caller-identity --profile "${EXISTING_TRAIL_OWNER_PROFILE}" --output json)"
owner_account_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["Account"])' <<< "${owner_identity}")"

if [[ -n "${EXISTING_TRAIL_OWNER_ACCOUNT_ID:-}" && "${EXISTING_TRAIL_OWNER_ACCOUNT_ID}" != "${owner_account_id}" ]]; then
  echo "EXISTING_TRAIL_OWNER_ACCOUNT_ID does not match EXISTING_TRAIL_OWNER_PROFILE." >&2
  exit 1
fi

trail="$(aws cloudtrail get-trail \
  --profile "${EXISTING_TRAIL_OWNER_PROFILE}" \
  --region "${SOURCE_REGION}" \
  --name "${EXISTING_TRAIL_NAME}" \
  --output json)"

trail_summary="$(python3 -c '
import json,sys
trail=json.load(sys.stdin)["Trail"]
print(json.dumps({
  "name": trail.get("Name"),
  "arn": trail.get("TrailARN"),
  "isOrganizationTrail": trail.get("IsOrganizationTrail"),
  "isMultiRegionTrail": trail.get("IsMultiRegionTrail"),
  "existingLogGroup": trail.get("CloudWatchLogsLogGroupArn"),
  "existingRole": trail.get("CloudWatchLogsRoleArn"),
}, indent=2))
' <<< "${trail}")"
printf '%s\n' "${trail_summary}"

trail_owner_account_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["Trail"]["TrailARN"].split(":")[4])' <<< "${trail}")"
is_organization_trail="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["Trail"].get("IsOrganizationTrail", False))' <<< "${trail}")"
is_multi_region_trail="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["Trail"].get("IsMultiRegionTrail", False))' <<< "${trail}")"

if [[ "${trail_owner_account_id}" != "${owner_account_id}" ]]; then
  echo "EXISTING_TRAIL_OWNER_PROFILE must target the account in the trail ARN (${trail_owner_account_id})." >&2
  exit 1
fi

if [[ "${is_organization_trail}" != "True" || "${is_multi_region_trail}" != "True" ]]; then
  echo "Existing trail must be an organization trail with multi-Region logging enabled." >&2
  exit 1
fi

if [[ "${APPLY}" == "false" ]]; then
  echo "Read-only validation complete. Run $0 --apply only after approving the source log group and delivery-role update." >&2
  exit 0
fi

log_group_arn="arn:aws:logs:${SOURCE_REGION}:${owner_account_id}:log-group:${SOURCE_GROUP}:*"
log_stream_arn="arn:aws:logs:${SOURCE_REGION}:${owner_account_id}:log-group:${SOURCE_GROUP}:log-stream:*"
role_arn="arn:aws:iam::${owner_account_id}:role/${ROLE_NAME}"

if ! aws logs describe-log-groups \
  --profile "${EXISTING_TRAIL_OWNER_PROFILE}" \
  --region "${SOURCE_REGION}" \
  --log-group-name-prefix "${SOURCE_GROUP}" \
  --query "logGroups[?logGroupName=='${SOURCE_GROUP}'] | length(@)" \
  --output text | grep -qx '1'; then
  aws logs create-log-group \
    --profile "${EXISTING_TRAIL_OWNER_PROFILE}" \
    --region "${SOURCE_REGION}" \
    --log-group-name "${SOURCE_GROUP}"
fi

aws logs put-retention-policy \
  --profile "${EXISTING_TRAIL_OWNER_PROFILE}" \
  --region "${SOURCE_REGION}" \
  --log-group-name "${SOURCE_GROUP}" \
  --retention-in-days "${RETENTION_DAYS}"

trust_policy="$(mktemp)"
role_policy="$(mktemp)"
trap 'rm -f "${trust_policy}" "${role_policy}"' EXIT

cat > "${trust_policy}" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "cloudtrail.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
JSON

python3 - "${log_stream_arn}" "${role_policy}" <<'PY'
import json
import sys

policy = {
    "Version": "2012-10-17",
    "Statement": [{
        "Effect": "Allow",
        "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
        "Resource": sys.argv[1],
    }],
}
with open(sys.argv[2], "w") as destination:
    json.dump(policy, destination)
PY

if ! aws iam get-role \
  --profile "${EXISTING_TRAIL_OWNER_PROFILE}" \
  --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  aws iam create-role \
    --profile "${EXISTING_TRAIL_OWNER_PROFILE}" \
    --role-name "${ROLE_NAME}" \
    --assume-role-policy-document "file://${trust_policy}" \
    --tags Key=Application,Value=TEAM Key=Purpose,Value=ExistingTrailDelivery >/dev/null
fi

aws iam put-role-policy \
  --profile "${EXISTING_TRAIL_OWNER_PROFILE}" \
  --role-name "${ROLE_NAME}" \
  --policy-name DeliverExistingTrailToTeamSourceLogGroup \
  --policy-document "file://${role_policy}"

aws cloudtrail update-trail \
  --profile "${EXISTING_TRAIL_OWNER_PROFILE}" \
  --region "${SOURCE_REGION}" \
  --name "${EXISTING_TRAIL_NAME}" \
  --cloud-watch-logs-log-group-arn "${log_group_arn}" \
  --cloud-watch-logs-role-arn "${role_arn}"

aws cloudtrail start-logging \
  --profile "${EXISTING_TRAIL_OWNER_PROFILE}" \
  --region "${SOURCE_REGION}" \
  --name "${EXISTING_TRAIL_NAME}"

echo "Existing trail CloudWatch Logs delivery configured: ${SOURCE_GROUP} in ${SOURCE_REGION}."
