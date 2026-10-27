import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  canAuditRequest,
  claimValues,
  createHandler,
  deriveQueryWindow,
} from "./index.js";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-05-01T12:00:00.000Z");

function request(overrides = {}) {
  return {
    id: REQUEST_ID,
    owner: "idc_requester@example.com",
    username: "idc_requester@example.com",
    accountId: "111122223333",
    role: "AdministratorAccess",
    startTime: "2026-05-01T10:00:00.000Z",
    endTime: "2026-05-01T11:00:00.000Z",
    status: "ended",
    approver_ids: ["approver-user-id"],
    ...overrides,
  };
}

function identity(username, claims = {}) {
  return { username, claims };
}

function mockDocumentClient({ requestItem = request(), sessionItem } = {}) {
  const puts = [];
  return {
    puts,
    async send(command) {
      if (command instanceof GetCommand) {
        return command.input.TableName === "requests"
          ? { Item: requestItem }
          : { Item: sessionItem };
      }
      if (command instanceof PutCommand) {
        puts.push(command.input);
        return {};
      }
      throw new Error(`Unexpected command ${command.constructor.name}`);
    },
  };
}

function event(userIdentity, fieldName = "startSessionActivityQuery") {
  return {
    arguments: { requestId: REQUEST_ID },
    identity: userIdentity,
    info: { fieldName },
  };
}

test("claimValues supports Cognito arrays and serialized lists", () => {
  assert.deepEqual(claimValues(["Auditors"]), ["Auditors"]);
  assert.deepEqual(claimValues('["Auditors","Admin"]'), ["Auditors", "Admin"]);
  assert.deepEqual(claimValues("Auditors,Admin"), ["Auditors", "Admin"]);
});

test("canAuditRequest authorizes requester, assigned approver, and Auditor", () => {
  const canonicalRequest = request();
  assert.equal(canAuditRequest(identity(canonicalRequest.owner), canonicalRequest), true);
  assert.equal(canAuditRequest(identity("idc_approver@example.com", {
    userId: "APPROVER-USER-ID",
  }), canonicalRequest), true);
  assert.equal(canAuditRequest(identity("idc_auditor@example.com", {
    "cognito:groups": ["Auditors"],
  }), canonicalRequest), true);
});

test("canAuditRequest denies an unrelated authenticated user", () => {
  assert.equal(canAuditRequest(identity("idc_other@example.com", {
    userId: "other-user-id",
    "cognito:groups": ["Admin"],
  }), request()), false);
});

test("deriveQueryWindow uses current UTC time for an active request", () => {
  assert.deepEqual(
    deriveQueryWindow(request({ status: "in progress", endTime: undefined }), NOW),
    {
      startTime: "2026-05-01T10:00:00.000Z",
      endTime: "2026-05-01T12:00:00.000Z",
    },
  );
});

test("deriveQueryWindow stops an ended request at its canonical endTime", () => {
  assert.deepEqual(deriveQueryWindow(request(), NOW), {
    startTime: "2026-05-01T10:00:00.000Z",
    endTime: "2026-05-01T11:00:00.000Z",
  });
});

test("handler queues only canonical request criteria", async () => {
  const documentClient = mockDocumentClient();
  const handler = createHandler({
    documentClient,
    now: () => NOW,
    requestsTableName: "requests",
    sessionsTableName: "sessions",
  });

  const result = await handler(event(identity("idc_requester@example.com")));
  assert.equal(result.status, "QUEUED");
  assert.equal(documentClient.puts.length, 1);
  assert.deepEqual(
    {
      accountId: documentClient.puts[0].Item.accountId,
      role: documentClient.puts[0].Item.role,
      username: documentClient.puts[0].Item.username,
      endTime: documentClient.puts[0].Item.endTime,
    },
    {
      accountId: "111122223333",
      role: "AdministratorAccess",
      username: "idc_requester@example.com",
      endTime: "2026-05-01T11:00:00.000Z",
    },
  );
});

test("handler reuses an unexpired completed ended query", async () => {
  const sessionItem = {
    id: REQUEST_ID,
    status: "COMPLETE",
    endTime: "2026-05-01T11:00:00.000Z",
    expireAt: Math.floor(NOW.getTime() / 1000) + 60,
    generation: 3,
  };
  const documentClient = mockDocumentClient({ sessionItem });
  const handler = createHandler({
    documentClient,
    now: () => NOW,
    requestsTableName: "requests",
    sessionsTableName: "sessions",
  });

  const result = await handler(event(identity("idc_requester@example.com")));
  assert.equal(result.status, "COMPLETE");
  assert.equal(documentClient.puts.length, 0);
});

test("handler refreshes an active query with a new generation", async () => {
  const activeRequest = request({ status: "in progress", endTime: undefined });
  const sessionItem = {
    id: REQUEST_ID,
    status: "COMPLETE",
    expireAt: Math.floor(NOW.getTime() / 1000) + 60,
    generation: 3,
    createdAt: "2026-05-01T10:00:00.000Z",
  };
  const documentClient = mockDocumentClient({ requestItem: activeRequest, sessionItem });
  const handler = createHandler({
    documentClient,
    now: () => NOW,
    requestsTableName: "requests",
    sessionsTableName: "sessions",
  });

  const result = await handler(event(
    identity("idc_requester@example.com"),
    "refreshSessionActivityQuery",
  ));
  assert.equal(result.status, "QUEUED");
  assert.equal(documentClient.puts[0].Item.generation, 4);
});

test("handler fails closed for an unrelated user", async () => {
  const handler = createHandler({
    documentClient: mockDocumentClient(),
    now: () => NOW,
    requestsTableName: "requests",
    sessionsTableName: "sessions",
  });

  await assert.rejects(
    handler(event(identity("idc_other@example.com"))),
    /NOT_AUTHORIZED/,
  );
});
