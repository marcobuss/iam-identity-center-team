# Copyright 2022 Amazon Web Services, Inc
# Licensed under the Apache License, Version 2.0.

IDC_LOGIN_URL=https://d-90676dxxxx.awsapps.com/start
REGION=us-east-1
TEAM_ACCOUNT=123456789101
ORG_MANAGEMENT_PROFILE=organization_management_profile
TEAM_ACCOUNT_PROFILE=team_account_profile
TEAM_ADMIN_GROUP="team_admin_group_name"
TEAM_AUDITOR_GROUP="team_auditor_group_name"
TAGS="project=iam-identity-center-team environment=pilot"
SECRET_NAME=TEAM-IDC-APP
CACHE_TTL=604800

# Independent CloudWatch audit-stack settings.
ORGANIZATION_ID=o-example1234
AUDIT_SOURCE_REGIONS=us-east-1,us-west-2
AUDIT_SOURCE_RETENTION_DAYS=1
AUDIT_CENTRAL_RETENTION_DAYS=7
AUDIT_CENTRAL_KMS_KEY_ARN=
AUDIT_STACK_NAME=TEAM-CLOUDWATCH-AUDIT

# The parallel application uses unique stack, repository, branch, and backend names.
TEAM_DEPLOYMENT_NAMESPACE=cloudwatch

# Uncomment only after configuring a separate pilot custom domain.
# UI_DOMAIN=pilot.example.com
