# Copyright 2022 Amazon Web Services, Inc
# Licensed under the Apache License, Version 2.0.

IDC_LOGIN_URL=https://d-90676dxxxx.awsapps.com/start
REGION=us-east-1
ORG_MANAGEMENT_PROFILE=organization_management_profile
TEAM_ADMIN_GROUP="team_admin_group_name"
TEAM_AUDITOR_GROUP="team_auditor_group_name"
TAGS="project=iam-identity-center-team environment=pilot"
SECRET_NAME=TEAM-IDC-APP
CACHE_TTL=604800
TEAM_DEPLOYMENT_NAMESPACE=cloudwatch

# Management-account application deployments must reference an independently
# deployed audit stack in the same account and Region.
AUDIT_STACK_NAME=TEAM-CLOUDWATCH-AUDIT

# Uncomment only after configuring a separate pilot custom domain.
# UI_DOMAIN=pilot.example.com
