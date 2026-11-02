const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const template = fs.readFileSync(
  path.join(__dirname, "organization-trail-template.yml"),
  "utf8"
);

test("management trail is multi-Region and centralization-compatible", () => {
  assert.match(template, /Type: AWS::CloudTrail::Trail/);
  assert.match(template, /IsMultiRegionTrail: true/);
  assert.match(template, /IsOrganizationTrail: true/);
  assert.match(template, /LogGroupName: !Ref SourceLogGroupName/);
  assert.match(template, /Default: TEAM\/CloudTrailManagementEvents/);
});

test("management trail storage and delivery are private and scoped", () => {
  assert.match(template, /BlockPublicAcls: true/);
  assert.match(template, /BlockPublicPolicy: true/);
  assert.match(template, /RestrictPublicBuckets: true/);
  assert.match(template, /VersioningConfiguration:/);
  assert.match(template, /SSEAlgorithm: AES256/);
  assert.match(template, /logs:CreateLogStream/);
  assert.match(template, /logs:PutLogEvents/);
  assert.match(template, /DeletionProtectionEnabled: true/);
});
