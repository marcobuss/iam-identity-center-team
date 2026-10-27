---
layout: default
title: Deployment
nav_order: 3
parent: Solution deployment
---

# Deployment Process
{: .no_toc}

<details open markdown="block">
  <summary>Table of contents</summary>
  {: .text-delta }
- TOC
{:toc}
</details>

---

## Deployment model

This release is for fresh CloudWatch-backed installations. Do not deploy it over an existing TEAM stack that owns a CloudTrail Lake event data store. During a pilot, leave the existing deployment untouched and create a namespaced TEAM application with a separate Amplify URL and IAM Identity Center SAML application.

Deployment has three independently controlled stages:

1. Management-account bootstrap for CloudWatch trusted access and delegated administration.
2. Independent audit-stack deployment in the TEAM delegated-administrator account.
3. Namespaced Amplify application deployment in the TEAM account.

No script deletes, disables, or imports an existing CloudTrail Lake event data store.

## Clone the repository

```sh
git clone https://github.com/aws-samples/iam-identity-center-team.git
cd iam-identity-center-team/deployment
cp -n parameters-template.sh parameters.sh
```

`deployment/parameters.sh` is ignored by Git and must not contain credentials. It contains profile names and deployment settings only.

## Configure parameters

Required application values:

- `IDC_LOGIN_URL` — IAM Identity Center portal URL.
- `REGION` — TEAM and central audit Region. This must match the IAM Identity Center Region.
- `TEAM_ACCOUNT` — Dedicated TEAM delegated-administrator account.
- `ORG_MANAGEMENT_PROFILE` — Local AWS CLI profile for the Organizations management account.
- `TEAM_ACCOUNT_PROFILE` — Local AWS CLI profile for the TEAM account.
- `TEAM_ADMIN_GROUP` — IAM Identity Center group used for TEAM administrators.
- `TEAM_AUDITOR_GROUP` — IAM Identity Center group used for TEAM auditors.
- `TEAM_DEPLOYMENT_NAMESPACE` — Unique suffix for the parallel stack, repository, branch, Amplify app, and backend environment. The default is `cloudwatch`.

Required audit-stack values:

- `ORGANIZATION_ID` — AWS Organizations ID.
- `AUDIT_SOURCE_REGIONS` — Comma-separated Regions to collect and centralize.

Optional values:

- `AUDIT_SOURCE_RETENTION_DAYS` — Source log retention; default `1`.
- `AUDIT_CENTRAL_RETENTION_DAYS` — Central log retention; default `7`.
- `AUDIT_CENTRAL_KMS_KEY_ARN` — Existing KMS key for central-log encryption. Empty uses AWS-owned encryption.
- `AUDIT_STACK_NAME` — Independent audit stack name.
- `TAGS` — Space-separated CloudFormation tags in `key=value` form.
- `UI_DOMAIN` — Separate custom domain for the pilot application.
- `CACHE_TTL` — Organizational-unit account cache TTL; default `604800` seconds.
- `SECRET_NAME` — Secrets Manager secret for an external repository. The secret contains repository URL and token values.

## Inspect and apply management-account bootstrap

The bootstrap script is read-only unless `--apply` is provided:

```sh
./init.sh
```

Review the reported delegated-administrator and telemetry status. Applying the script changes organization-level configuration and requires explicit authorization:

```sh
./init.sh --apply
```

It configures Account Management, IAM Identity Center, and CloudWatch delegated administration. Before starting telemetry evaluation, it verifies the AWS Config service-linked role required by CloudWatch telemetry configuration. It then waits for the service to report `RUNNING`; do not deploy the audit stack while the status is `NOT_STARTED`, `STARTING`, or a failed state. The script does not change CloudTrail Lake delegated administration used by an older parallel deployment.

## Review and deploy the independent audit stack

Create an unexecuted CloudFormation change set:

```sh
./cloudwatch-audit/deploy.sh
```

Review the change set, source Regions, destination account, retention, and optional KMS configuration. Apply it only to the approved non-production target:

```sh
./cloudwatch-audit/deploy.sh --apply
```

The stack creates:

- An organization CloudTrail management-event telemetry rule.
- An organization CloudWatch Logs centralization rule.
- The private `/aws/team/cloudtrail-management` destination log group.
- `/team/audit/log-group-arn` in Systems Manager Parameter Store.
- `/team/audit/region` in Systems Manager Parameter Store.

The central log group has deletion protection and retain policies. The application stack does not own it.

CloudWatch telemetry discovery can take time. Wait until the telemetry and centralization rules report healthy before testing session activity.

## Deploy the namespaced application

`deploy.sh` requires an explicit apply flag:

```sh
./deploy.sh --apply
```

For the default `cloudwatch` namespace, the script creates distinct names such as:

- CloudFormation stack: `TEAM-IDC-APP-cloudwatch`
- CodeCommit repository: `team-idc-app-cloudwatch`
- Branch/backend environment: `cloudwatch`
- Amplify application: `TEAM-IDC-APP-cloudwatch`

The application template resolves the fixed SSM audit parameters during stack deployment and passes the resolved values into the Amplify build. Updating an SSM value does not update an already deployed Lambda until the application stack is updated.

If an external repository is configured, create and push the namespaced branch before deployment.

## Configure pilot access

Create a separate IAM Identity Center custom SAML application for the pilot Amplify URL. Assign only the approved pilot group. Do not redirect the existing Lake-based application during this stage.

Before admitting pilot users, verify that:

- Anonymous AppSync operations are denied.
- An unrelated authenticated user cannot start or retrieve another request's query.
- Only the requester, assigned approvers, and Auditors can inspect activity.

## Verify deployment

1. Confirm the audit stack and SSM parameters are healthy.
2. Confirm management events from every configured Region reach `/aws/team/cloudtrail-management`.
3. Open the namespaced Amplify URL through the pilot SAML application.
4. Run a controlled elevated-access request.
5. Verify running, complete, empty, and failed activity states.
6. Verify result paging and complete CSV download.
7. Confirm the old Lake-backed application remains unchanged and available.

## Updating this release

`update.sh` updates only the namespaced CloudWatch deployment:

```sh
./update.sh --apply
```

Never point it at an existing Lake-backed stack. In-place migration and historical data import are intentionally deferred to a later release.
