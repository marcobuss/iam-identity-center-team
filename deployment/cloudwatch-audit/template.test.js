const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const template = fs.readFileSync(path.join(__dirname, "template.yml"), "utf8");

test("audit infrastructure has an independent retained destination", () => {
  assert.match(template, /CentralAuditLogGroup:/);
  assert.match(template, /LogGroupName: !Ref CentralLogGroupName/);
  assert.match(template, /CentralRetentionDays:[\s\S]*Default: 7/);
  assert.match(template, /DeletionPolicy: Retain/);
  assert.match(template, /UpdateReplacePolicy: Retain/);
  assert.match(template, /DeletionProtectionEnabled: true/);
});

test("audit stack publishes the fixed SSM contract", () => {
  assert.match(template, /Name: \/team\/audit\/log-group-arn/);
  assert.match(template, /Name: \/team\/audit\/region/);
});

test("telemetry rule captures only management events", () => {
  assert.match(template, /Type: AWS::ObservabilityAdmin::OrganizationTelemetryRule/);
  assert.match(template, /ResourceType: AWS::CloudTrail/);
  assert.match(template, /Field: eventCategory\s+Equals:\s+- Management/);
  assert.doesNotMatch(template, /eventCategory[\s\S]{0,100}- Data/);
  assert.doesNotMatch(template, /eventCategory[\s\S]{0,100}- NetworkActivity/);
});

test("centralization is created before ingestion and targets CloudTrail groups", () => {
  assert.match(template, /CloudTrailTelemetryRule:[\s\S]*DependsOn: CentralizationRule/);
  assert.match(template, /LogGroupSelectionCriteria: "LogGroupName LIKE 'aws\/cloudtrail\/%'"/);
  assert.match(template, /SourceRetentionDays:[\s\S]*Default: 1/);
});

test("customer-managed encryption remains optional", () => {
  assert.match(template, /CentralKmsKeyArn:[\s\S]*Default: ""/);
  assert.match(template, /UseCustomerManagedKmsKey/);
  assert.match(template, /EncryptionStrategy: CUSTOMER_MANAGED/);
  assert.match(template, /EncryptionStrategy: AWS_OWNED/);
});
