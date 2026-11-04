const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const script = fs.readFileSync(
  path.join(__dirname, "configure-existing-trail.sh"),
  "utf8"
);

test("existing trail configuration requires an explicit apply flag", () => {
  assert.match(script, /AUDIT_SOURCE_MODE must be existing-trail/);
  assert.match(script, /Run \$0 --apply only after approving/);
  assert.match(script, /if \[\[ "\$\{APPLY\}" == "false" \]\]/);
});

test("existing trail configuration preserves customer trail ownership settings", () => {
  assert.match(script, /cloud-watch-logs-log-group-arn/);
  assert.match(script, /cloud-watch-logs-role-arn/);
  assert.doesNotMatch(script, /--s3-bucket-name/);
  assert.doesNotMatch(script, /--event-selectors/);
});

test("existing trail configuration scopes the delivery role to its source group", () => {
  assert.match(script, /logs:CreateLogStream/);
  assert.match(script, /logs:PutLogEvents/);
  assert.match(script, /EXISTING_TRAIL_SOURCE_LOG_GROUP_NAME cannot use the reserved aws\/ prefix/);
});
