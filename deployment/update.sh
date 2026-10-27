#!/usr/bin/env bash
# Updates only the namespaced CloudWatch TEAM deployment.
# Existing CloudTrail Lake deployments must remain on their existing release.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" != "--apply" ]]; then
  echo "Usage: $0 --apply" >&2
  echo "This command must not target an existing CloudTrail Lake stack." >&2
  exit 2
fi

exec "${SCRIPT_DIR}/deploy.sh" --apply
