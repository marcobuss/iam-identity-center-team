const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const schema = fs.readFileSync(path.join(__dirname, "schema.graphql"), "utf8");
const subscriptionResolver = fs.readFileSync(
  path.join(__dirname, "resolvers/Subscription.onUpdateSessions.req.vtl"),
  "utf8",
);
const customResources = fs.readFileSync(
  path.join(__dirname, "stacks/CustomResources.json"),
  "utf8",
);

test("session query state has no generated browser CRUD surface", () => {
  assert.match(schema, /type sessions\s+@model\(subscriptions: null, queries: null, mutations: null\)/);
});

test("browser audit operations accept only request identity and page state", () => {
  assert.match(schema, /startSessionActivityQuery\(requestId: ID!\)/);
  assert.match(schema, /refreshSessionActivityQuery\(requestId: ID!\)/);
  assert.match(schema, /sessionActivity\(\s*requestId: ID!\s*nextToken: String\s*\)/);
  assert.doesNotMatch(schema, /sessionActivity\([^)]*queryId/);
});

test("internal state publication is IAM-only and subscription is request-scoped", () => {
  assert.match(schema, /publishSessionActivityState\(result: AuditQueryStateInput!\): AuditQueryState\s+@aws_iam/);
  assert.match(schema, /onUpdateSessions\(requestId: ID!\): AuditQueryState/);
  assert.match(subscriptionResolver, /contains\("Auditors"\)/);
  assert.match(customResources, /"FieldName": "publishSessionActivityState"/);
  assert.match(customResources, /IAM Authorization/);
  assert.match(customResources, /"Type": "NONE"/);
});
