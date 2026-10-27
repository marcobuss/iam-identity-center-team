import assert from "node:assert/strict";
import test from "node:test";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  buildQuery,
  createHandler,
  createSessionUpdater,
  escapeRegex,
  queryLiteral,
  sessionFromRecord,
  toEpochSeconds,
} from "./index.js";

function streamRecord(overrides = {}, sequenceNumber = "1") {
  return {
    eventID: `event-${sequenceNumber}`,
    dynamodb: {
      SequenceNumber: sequenceNumber,
      NewImage: marshall({
        id: "11111111-1111-4111-8111-111111111111",
        status: "QUEUED",
        generation: 1,
        startTime: "2026-05-01T10:00:00.000Z",
        endTime: "2026-05-01T11:00:00.000Z",
        username: "idc_User@example.com",
        accountId: "111122223333",
        role: "AdministratorAccess",
        ...overrides,
      }),
    },
  };
}

test("queryLiteral escapes quotes and line breaks", () => {
  assert.equal(queryLiteral('a"b\nc'), '"a\\"b\\nc"');
});

test("escapeRegex protects permission-set names in anchored role expressions", () => {
  assert.equal(escapeRegex("Admin.Read+Write"), "Admin\\.Read\\+Write");
});

test("buildQuery uses exact canonical management-event filters", () => {
  const query = buildQuery({
    accountId: "111122223333",
    role: "AdministratorAccess",
    username: "idc_User@example.com",
  });
  assert.match(query, /eventCategory = "Management"/);
  assert.match(query, /recipientAccountId = "111122223333"/);
  assert.match(query, /tolower\(sessionName\) = "user@example\.com"/);
  assert.match(query, /\^AWSReservedSSO_AdministratorAccess_\[A-Fa-f0-9\]\{16\}\$/);
  assert.match(query, /limit 100000/);
});

test("buildQuery rejects malformed canonical fields", () => {
  assert.throws(() => buildQuery({
    accountId: "not-an-account",
    role: "AdministratorAccess",
    username: "idc_user@example.com",
  }), /INVALID_ACCOUNT_ID/);
  assert.throws(() => buildQuery({
    accountId: "111122223333",
    role: "role' OR true",
    username: "idc_user@example.com",
  }), /INVALID_ROLE_NAME/);
});

test("toEpochSeconds parses UTC timestamps and rejects malformed values", () => {
  assert.equal(toEpochSeconds("2026-05-01T10:00:00.000Z"), 1777629600);
  assert.throws(() => toEpochSeconds("not-a-date"), /INVALID_QUERY_WINDOW/);
});

test("sessionFromRecord accepts only QUEUED records", () => {
  assert.equal(sessionFromRecord(streamRecord()).status, "QUEUED");
  assert.equal(sessionFromRecord(streamRecord({ status: "RUNNING" })), null);
});

test("handler processes every stream record and starts one query per item", async () => {
  const sent = [];
  const updates = [];
  const handler = createHandler({
    logsClient: {
      async send(command) {
        sent.push(command.input);
        return { queryId: `query-${sent.length}` };
      },
    },
    async updateSession(input, condition) {
      updates.push({ input, condition });
    },
    auditLogGroupArn: "arn:aws:logs:us-east-1:111122223333:log-group:/aws/team/cloudtrail-management",
  });

  const result = await handler({ Records: [streamRecord({}, "1"), streamRecord({ generation: 2 }, "2")] });
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.equal(sent.length, 2);
  assert.equal(updates.filter(({ input }) => input.status === "STARTING").length, 2);
  assert.equal(updates.filter(({ input }) => input.status === "RUNNING").length, 2);
  assert.equal(sent[0].limit, 100000);
  assert.equal(sent[0].queryLanguage, "CWLI");
});

test("handler reports only records whose state cannot be updated", async () => {
  const handler = createHandler({
    logsClient: { async send() { return { queryId: "query-id" }; } },
    async updateSession() { throw new Error("unavailable"); },
    auditLogGroupArn: "arn:aws:logs:us-east-1:111122223333:log-group:/aws/team/cloudtrail-management",
  });

  const result = await handler({ Records: [streamRecord({}, "7")] });
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: "7" }] });
});

test("session updater writes conditionally and publishes only safe state", async () => {
  const commands = [];
  const published = [];
  const updateSession = createSessionUpdater({
    documentClient: {
      async send(command) {
        assert.ok(command instanceof UpdateCommand);
        commands.push(command.input);
        return {
          Attributes: {
            status: "RUNNING",
            errorCode: null,
            expireAt: 1778061600,
          },
        };
      },
    },
    async publishState(state) { published.push(state); },
    sessionsTableName: "sessions",
    now: () => new Date("2026-05-01T12:00:00.000Z"),
  });

  await updateSession(
    { id: "request-id", status: "RUNNING", queryId: "private-query-id" },
    { status: { eq: "STARTING" }, generation: { eq: 2 } },
  );

  assert.match(commands[0].ConditionExpression, /expectedStatus/);
  assert.match(commands[0].ConditionExpression, /expectedGeneration/);
  assert.deepEqual(published, [{
    requestId: "request-id",
    status: "RUNNING",
    errorCode: null,
    expireAt: 1778061600,
  }]);
  assert.equal(JSON.stringify(published).includes("private-query-id"), false);
});

test("subscription publication failure does not roll back committed query state", async () => {
  const updateSession = createSessionUpdater({
    documentClient: {
      async send() {
        return { Attributes: { status: "STARTING", expireAt: 1778061600 } };
      },
    },
    async publishState() { throw new Error("subscription unavailable"); },
    sessionsTableName: "sessions",
  });

  await assert.doesNotReject(updateSession(
    { id: "request-id", status: "STARTING" },
    { status: { eq: "QUEUED" }, generation: { eq: 1 } },
  ));
});

test("handler records an invalid canonical query window as a terminal failure", async () => {
  const updates = [];
  let queryCalls = 0;
  const handler = createHandler({
    logsClient: { async send() { queryCalls += 1; return { queryId: "unused" }; } },
    async updateSession(input) { updates.push(input); },
    auditLogGroupArn: "arn:aws:logs:us-east-1:111122223333:log-group:/aws/team/cloudtrail-management",
  });

  const result = await handler({ Records: [streamRecord({ endTime: "invalid" }, "9")] });
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.equal(queryCalls, 0);
  assert.equal(updates.at(-1).status, "FAILED");
  assert.equal(updates.at(-1).errorCode, "INVALID_QUERY_WINDOW");
});
