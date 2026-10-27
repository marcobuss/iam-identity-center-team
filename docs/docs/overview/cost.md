---
layout: default
title: Cost considerations
nav_order: 5
parent: Solution overview
---

# Cost considerations

TEAM uses serverless AWS services whose cost depends on organization size, request volume, event volume, retention, and query frequency. Use the [AWS Pricing Calculator](https://calculator.aws) with measurements from a representative pilot.

## AWS services pricing

- [AWS Amplify](https://aws.amazon.com/amplify/pricing/)
- [AWS AppSync](https://aws.amazon.com/appsync/pricing/)
- [Amazon DynamoDB](https://aws.amazon.com/dynamodb/pricing)
- [AWS Lambda](https://aws.amazon.com/lambda/pricing)
- [AWS Step Functions](https://aws.amazon.com/step-functions/pricing)
- [Amazon Cognito](https://aws.amazon.com/cognito/pricing)
- [Amazon CloudWatch](https://aws.amazon.com/cloudwatch/pricing/)
- [AWS CloudTrail](https://aws.amazon.com/cloudtrail/pricing/)
- [AWS IAM Identity Center](https://aws.amazon.com/iam/identity-center/) (no additional charge)
- [AWS Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/)

## Managing audit cost

CloudWatch telemetry rules deliver CloudTrail management events to managed source log groups in each configured account and Region. A centralization rule copies matching events to the TEAM account, where the application runs CloudWatch Logs Insights queries.

Relevant cost dimensions include:

- CloudTrail event ingestion into source CloudWatch log groups.
- One day of source-account storage by default.
- Seven days of centralized storage by default.
- Centralization copies.
- Data scanned by each Logs Insights query.
- Lambda, AppSync, and DynamoDB operations used by the asynchronous query workflow.

TEAM collects read and write management events and excludes data, network, and Insights events in the default audit stack. Expanding to data events can significantly increase event volume and must be evaluated separately.

To control cost:

- Configure only Regions that contain workloads TEAM must audit.
- Keep query windows bounded to the canonical TEAM request.
- Reuse one completed query per request for five days.
- Use active-session refresh only when newer events are required.
- Adjust source and central retention according to organizational audit requirements.
- Monitor CloudWatch Logs Insights bytes scanned and query concurrency during the pilot.
