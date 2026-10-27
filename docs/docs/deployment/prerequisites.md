---
layout: default
title: Prerequisites
nav_order: 2
parent: Solution deployment
---

# Prerequisites & setup

## Prerequisites

### AWS Organizations
- [AWS Organizations](https://aws.amazon.com/organizations/) managed multi account environment with [AWS IAM Identity Center](https://aws.amazon.com/iam/identity-center/) federated account access

  > TEAM cannot be used to perform the following tasks:
    - Grant temporary access to the management account
    - Manage permission sets provisioned in the management account

  Read the [security considerations]({% link docs/overview/security.md %}) section for more information.
  {: .note}

### Permission set
- Configure [Permission sets](https://docs.aws.amazon.com/singlesignon/latest/userguide/permissionsetsconcept.html) in IAM Identity center.    
  > You can either use a predefined permission set provided by Identity Center, or you can create your own permission sets using custom permissions in order to provide least-privilege access for particular operational tasks.
   {: .note}

### Dedicated TEAM account
- Dedicated AWS account for deploying TEAM Application. This account will also be configured as delegated admin for:
  - IAM Identity Center
  - CloudWatch telemetry administration
  - Account management

  [As per AWS best practice](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_best-practices_mgmt-acct.html#best-practices_mgmt-use), it is not recommended to deploy resources in the organization management account. Designate a dedicated account for deploying the TEAM solution. We recommend that you do not deploy any other workloads in this account, and carefully manage users with access to this account based on a need-to-do principle.
  {: .note}

### CloudWatch organization audit infrastructure
TEAM uses CloudTrail service-linked channels and Amazon CloudWatch Logs to collect and query management events generated during elevated-access requests.

Before deploying the application:

- Enable CloudWatch telemetry configuration for the organization from the Organizations management account.
- Register the dedicated TEAM account as the CloudWatch delegated administrator.
- Deploy `deployment/cloudwatch-audit/template.yml` independently in the TEAM account and Region.
- Include every workload Region that TEAM must audit.
- Verify that the stack publishes `/team/audit/log-group-arn` and `/team/audit/region` in Systems Manager Parameter Store.

The source log groups retain events for one day by default. The centralized TEAM log group retains events for seven days by default. These values are configurable when the independent audit stack is deployed. Collection starts when CloudWatch telemetry enablement and centralization become active; this fresh-install release does not import earlier events.

If `AUDIT_CENTRAL_KMS_KEY_ARN` is configured, the existing key policy must allow the CloudWatch Logs service to encrypt and decrypt this log group, scoped to the organization and CloudWatch Logs encryption context. The audit stack associates the key but does not weaken or replace its policy.

## AWS Secrets Manager
TEAM allows you to use external repositories for deploying the solution. 
Create a secret in AWS Secret Manager containting your repository url and Access token in Secrets manager as shown below 

![custom](../assets/images/secret-manager.png)

### TEAM groups
- Create groups within AWS IAM Identity center for **TEAM admins** and **TEAM auditors**. These groups can be created locally (In Identity center) or synchronised from an external identity provider following your organisation's group membership review and attestation process.

  Refer to the [solution overview]({% link docs/overview/workflow.md %}) for more information on TEAM personas and groups
  {: .note}

## Development environment setup
- Setup [awscli](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) and install [git-remote-codecommit](https://docs.aws.amazon.com/codecommit/latest/userguide/setting-up-git-remote-codecommit.html) on your local workstation

- Install [jq](https://github.com/stedolan/jq/wiki/Installation) on your local workstation

- Setup a [named profile](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-profiles.html) for AWS CLI with sufficient permissions for the **Organization management account**

- Setup a named profile for AWS CLI with sufficient permissions for the **AWS account where the TEAM Application will be deployed in**

  You can use AWS CloudShell instead of the first two steps of setting up awscli, git-remote-codecommit, and jq on a local workstation.
  {: .note}

### 🚀 You can now [Deploy the Application]({% link docs/deployment/deployment_process.md %}).
