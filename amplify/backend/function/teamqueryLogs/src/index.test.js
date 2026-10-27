import assert from "node:assert/strict";
import test from "node:test";
import { GetQueryResultsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  canAuditRequest,
  createHandler,
  mapQueryStatus,
  mapResultRow,
} from "./index.js";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST = {
  id: REQUEST_ID,
  owner: "idc_requester@example.com",
  username: "idc_requester@example.com",
  approver_ids: ["approver-user-id"],
};
const SESSION = {
  id: REQUEST_ID,
  status: "RUNNING",
  queryId: "query-id",
  generation: 1,
};

function event(username = REQUEST.owner, claims = {}, nextToken = null) {
  return {
    arguments: { requestId: REQUEST_ID, nextToken },
    identity: { username, claims },
  };
}

function clients({ queryResponse, request = REQUEST, session = SESSION } = {}) {
  const updates = [];
  const calls = [];
  return {
    updates,
    calls,
    documentClient: {
      async send(command) {
        if (command instanceof GetCommand) {
          return command.input.TableName === "requests" ? { Item: request } : { Item: session };
        }
        if (command instanceof UpdateCommand) {
          updates.push(command.input);
          return {};
        }
        throw new Error(`Unexpected command ${command.constructor.name}`);
      },
    },
    logsClient: {
      async send(command) {
        assert.ok(command instanceof GetQueryResultsCommand);
        calls.push(command.input);
        return queryResponse ?? { status: "Running", results: [] };
      },
    },
  };
}

function handlerFor(testClients) {
  return createHandler({
    ...testClients,
    requestsTableName: "requests",
    sessionsTableName: "sessions",
    now: () => new Date("2026-05-01T12:00:00.000Z"),
  });
}

test("authorization permits requester, assigned approver, and Auditor", () => {
  assert.equal(canAuditRequest(event().identity, REQUEST), true);
  assert.equal(canAuditRequest(event("idc_approver@example.com", {
    userId: "APPROVER-USER-ID",
  }).identity, REQUEST), true);
  assert.equal(canAuditRequest(event("idc_auditor@example.com", {
    "cognito:groups": ["Auditors"],
  }).identity, REQUEST), true);
});

test("mapResultRow allowlists the four public fields", () => {
  assert.deepEqual(mapResultRow([
    { field: "eventID", value: "event-1" },
    { field: "eventName", value: "ListBuckets" },
    { field: "sourceIPAddress", value: "192.0.2.1" },
    { field: "@ptr", value: "internal" },
  ]), { eventID: "event-1", eventName: "ListBuckets" });
});

test("mapQueryStatus maps all CloudWatch terminal values", () => {
  assert.equal(mapQueryStatus("Scheduled"), "RUNNING");
  assert.equal(mapQueryStatus("Complete"), "COMPLETE");
  assert.equal(mapQueryStatus("Failed"), "FAILED");
  assert.equal(mapQueryStatus("Cancelled"), "CANCELLED");
  assert.equal(mapQueryStatus("Timeout"), "TIMEOUT");
  assert.equal(mapQueryStatus("unexpected"), "UNKNOWN");
});

test("handler returns no partial events while query is running", async () => {
  const testClients = clients({
    queryResponse: {
      status: "Running",
      results: [[{ field: "eventID", value: "partial" }]],
    },
  });
  const result = await handlerFor(testClients)(event());
  assert.equal(result.status, "RUNNING");
  assert.deepEqual(result.events, []);
  assert.equal(testClients.calls[0].maxItems, 1000);
});

test("handler returns a complete page and native continuation token", async () => {
  const testClients = clients({
    queryResponse: {
      status: "Complete",
      results: [[
        { field: "eventID", value: "event-1" },
        { field: "eventName", value: "ListBuckets" },
        { field: "eventSource", value: "s3.amazonaws.com" },
        { field: "eventTime", value: "2026-05-01T10:30:00Z" },
      ]],
      nextToken: "next-page",
      statistics: { resultCount: 1 },
    },
  });
  const result = await handlerFor(testClients)(event());
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.events.length, 1);
  assert.equal(result.nextToken, "next-page");
  assert.equal(result.potentiallyTruncated, false);
  assert.equal(testClients.updates.length, 1);
});

test("handler passes a supplied continuation token only with the server query ID", async () => {
  const testClients = clients({ queryResponse: { status: "Complete", results: [] } });
  await handlerFor(testClients)(event(REQUEST.owner, {}, "page-token"));
  assert.deepEqual(testClients.calls[0], {
    queryId: "query-id",
    maxItems: 1000,
    nextToken: "page-token",
  });
});

test("handler flags results at the CloudWatch query maximum", async () => {
  const testClients = clients({
    queryResponse: {
      status: "Complete",
      results: [],
      statistics: { resultCount: 100000 },
    },
  });
  const result = await handlerFor(testClients)(event());
  assert.equal(result.potentiallyTruncated, true);
});

test("handler denies an unrelated authenticated user before querying CloudWatch", async () => {
  const testClients = clients();
  await assert.rejects(
    handlerFor(testClients)(event("idc_other@example.com", { userId: "other" })),
    /NOT_AUTHORIZED/,
  );
  assert.equal(testClients.calls.length, 0);
});

test("handler distinguishes a failed query from an empty result", async () => {
  const testClients = clients({ session: { ...SESSION, status: "FAILED", errorCode: "QUERY_START_FAILED" } });
  const result = await handlerFor(testClients)(event());
  assert.equal(result.status, "FAILED");
  assert.equal(result.errorCode, "QUERY_START_FAILED");
  assert.deepEqual(result.events, []);
});

test("handler converts a stalled pre-query state into a retryable failure", async () => {
  const testClients = clients({
    session: {
      ...SESSION,
      status: "STARTING",
      queryId: undefined,
      requestedAt: "2026-05-01T11:50:00.000Z",
    },
  });
  const result = await handlerFor(testClients)(event());
  assert.equal(result.status, "FAILED");
  assert.equal(result.errorCode, "QUERY_START_STALLED");
  assert.equal(testClients.updates.length, 1);
});
