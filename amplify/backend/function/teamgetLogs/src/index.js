import crypto from "@aws-crypto/sha256-js";
import {
  CloudWatchLogsClient,
  StartQueryCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { HttpRequest } from "@aws-sdk/protocol-http";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import fetch, { Request } from "node-fetch";

const { Sha256 } = crypto;
const ACCOUNT_ID_PATTERN = /^[0-9]{12}$/;
const ROLE_NAME_PATTERN = /^[\w+=,.@-]{1,64}$/;
const QUERY_LIMIT = 100000;

/**
 * Write one structured operational log without audit criteria or event content.
 * @param {string} level
 * @param {string} operation
 * @param {Record<string, unknown>} details
 */
function writeLog(level, operation, details = {}) {
  process.stdout.write(`${JSON.stringify({ level, operation, ...details })}\n`);
}

/**
 * Convert a trusted value to a Logs Insights string literal.
 * @param {string} value
 * @returns {string}
 */
export function queryLiteral(value) {
  return JSON.stringify(value);
}

/**
 * Escape a validated permission-set name for a Logs Insights regular expression.
 * @param {string} value
 * @returns {string}
 */
export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the fixed TEAM management-event query from server-owned state.
 * @param {{accountId: string, role: string, username: string}} session
 * @returns {string}
 */
export function buildQuery(session) {
  if (!ACCOUNT_ID_PATTERN.test(session.accountId)) {
    throw new Error("INVALID_ACCOUNT_ID");
  }
  if (!ROLE_NAME_PATTERN.test(session.role)) {
    throw new Error("INVALID_ROLE_NAME");
  }
  if (typeof session.username !== "string" || session.username.length > 256) {
    throw new Error("INVALID_USERNAME");
  }

  const username = session.username.replace(/^idc_/i, "").toLowerCase();
  if (username === "" || /[\r\n]/.test(username)) {
    throw new Error("INVALID_USERNAME");
  }

  const permissionSetRolePattern = `^AWSReservedSSO_${escapeRegex(session.role)}_[A-Fa-f0-9]{16}$`;
  return [
    "parse userIdentity.principalId \"*:*\" as issuerPrincipalId, sessionName",
    `| filter eventCategory = ${queryLiteral("Management")}`,
    `| filter recipientAccountId = ${queryLiteral(session.accountId)}`,
    `| filter tolower(sessionName) = ${queryLiteral(username)}`,
    `| filter userIdentity.sessionContext.sessionIssuer.userName like /${permissionSetRolePattern}/`,
    "| sort eventTime asc",
    "| fields eventID, eventName, eventSource, eventTime",
    `| limit ${QUERY_LIMIT}`,
  ].join("\n");
}

/**
 * Validate an ISO timestamp and return epoch seconds.
 * @param {string} value
 * @returns {number}
 */
export function toEpochSeconds(value) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    throw new Error("INVALID_QUERY_WINDOW");
  }
  return Math.floor(timestamp / 1000);
}

/**
 * Create the signed AppSync state publisher used only for subscription hints.
 * @param {{endpoint: string, region: string, fetchImpl?: typeof fetch}} config
 * @returns {(state: Record<string, unknown>) => Promise<void>}
 */
export function createStatePublisher({ endpoint, region, fetchImpl = fetch }) {
  const mutation = `
    mutation PublishSessionActivityState($result: AuditQueryStateInput!) {
      publishSessionActivityState(result: $result) {
        requestId
        status
        errorCode
        expireAt
      }
    }
  `;

  return async (state) => {
    const endpointUrl = new URL(endpoint);
    const signer = new SignatureV4({
      credentials: defaultProvider(),
      region,
      service: "appsync",
      sha256: Sha256,
    });
    const unsignedRequest = new HttpRequest({
      method: "POST",
      headers: { "Content-Type": "application/json", host: endpointUrl.host },
      hostname: endpointUrl.host,
      body: JSON.stringify({ query: mutation, variables: { result: state } }),
      path: endpointUrl.pathname,
    });
    const signedRequest = await signer.sign(unsignedRequest);
    const response = await fetchImpl(new Request(endpointUrl, signedRequest));
    const body = await response.json();
    if (!response.ok || body.errors) {
      throw new Error("SESSION_STATE_PUBLISH_FAILED");
    }
  };
}

/**
 * Create a conditional DynamoDB state updater that publishes safe state changes.
 * @param {{documentClient: {send: Function}, publishState: Function, sessionsTableName: string, now?: () => Date}} config
 * @returns {(input: Record<string, unknown>, condition?: Record<string, unknown>) => Promise<void>}
 */
export function createSessionUpdater({
  documentClient,
  publishState,
  sessionsTableName,
  now = () => new Date(),
}) {
  return async (input, condition = {}) => {
    const fieldNames = Object.keys(input).filter((field) => field !== "id");
    const expressionNames = { "#status": "status" };
    const expressionValues = { ":updatedAt": now().toISOString() };
    const assignments = ["updatedAt = :updatedAt"];

    for (const field of fieldNames) {
      const nameKey = field === "status" ? "#status" : `#${field}`;
      const valueKey = `:${field}`;
      expressionNames[nameKey] = field;
      expressionValues[valueKey] = input[field];
      assignments.push(`${nameKey} = ${valueKey}`);
    }

    const conditions = [];
    if (condition.status?.eq != null) {
      expressionValues[":expectedStatus"] = condition.status.eq;
      conditions.push("#status = :expectedStatus");
    }
    if (condition.generation?.eq != null) {
      expressionNames["#generation"] = "generation";
      expressionValues[":expectedGeneration"] = condition.generation.eq;
      conditions.push("#generation = :expectedGeneration");
    }

    let updated;
    try {
      const response = await documentClient.send(new UpdateCommand({
        TableName: sessionsTableName,
        Key: { id: input.id },
        UpdateExpression: `SET ${assignments.join(", ")}`,
        ConditionExpression: conditions.length > 0 ? conditions.join(" AND ") : undefined,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
        ReturnValues: "ALL_NEW",
      }));
      updated = response.Attributes;
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") {
        error.isConditionalFailure = true;
      }
      throw error;
    }

    try {
      await publishState({
        requestId: input.id,
        status: updated?.status ?? input.status,
        errorCode: updated?.errorCode ?? null,
        expireAt: updated?.expireAt ?? null,
      });
    } catch {
      writeLog("ERROR", "audit_query_state_publish_failed", {
        errorCode: "QUERY_STATE_PUBLISH_FAILED",
      });
    }
  };
}

/**
 * Convert a DynamoDB stream record into server-owned query state.
 * @param {Record<string, any>} record
 * @returns {Record<string, any> | null}
 */
export function sessionFromRecord(record) {
  const image = record?.dynamodb?.NewImage;
  if (!image) {
    return null;
  }
  const session = unmarshall(image);
  return session.status === "QUEUED" ? session : null;
}

/**
 * Create the DynamoDB stream handler with injectable side effects.
 * @param {{logsClient: {send: Function}, updateSession: Function, auditLogGroupArn: string}} dependencies
 * @returns {(event: {Records?: Array<Record<string, any>>}) => Promise<{batchItemFailures: Array<{itemIdentifier: string}>}>}
 */
export function createHandler({ logsClient, updateSession, auditLogGroupArn }) {
  const processRecord = async (record) => {
    const session = sessionFromRecord(record);
    if (!session) {
      return;
    }

    const condition = {
      status: { eq: "QUEUED" },
      generation: { eq: session.generation },
    };
    try {
      await updateSession({ id: session.id, status: "STARTING", errorCode: null }, condition);
    } catch (error) {
      if (error.isConditionalFailure) {
        return;
      }
      throw error;
    }

    let startTime;
    let endTime;
    try {
      startTime = toEpochSeconds(session.startTime);
      endTime = toEpochSeconds(session.endTime);
      if (endTime < startTime) {
        throw new Error("INVALID_QUERY_WINDOW");
      }
    } catch {
      await updateSession({ id: session.id, status: "FAILED", errorCode: "INVALID_QUERY_WINDOW" }, {
        status: { eq: "STARTING" },
        generation: { eq: session.generation },
      });
      return;
    }

    try {
      const response = await logsClient.send(new StartQueryCommand({
        logGroupIdentifiers: [auditLogGroupArn],
        startTime,
        endTime,
        queryLanguage: "CWLI",
        queryString: buildQuery(session),
        limit: QUERY_LIMIT,
      }));
      if (!response.queryId) {
        throw new Error("MISSING_QUERY_ID");
      }
      await updateSession({
        id: session.id,
        status: "RUNNING",
        errorCode: null,
        queryId: response.queryId,
        queryStartedAt: new Date().toISOString(),
      }, {
        status: { eq: "STARTING" },
        generation: { eq: session.generation },
      });
      writeLog("INFO", "audit_query_started");
    } catch (error) {
      try {
        await updateSession({
          id: session.id,
          status: "FAILED",
          errorCode: "QUERY_START_FAILED",
        }, {
          status: { eq: "STARTING" },
          generation: { eq: session.generation },
        });
      } catch {
        throw error;
      }
      writeLog("ERROR", "audit_query_start_failed", { errorCode: "QUERY_START_FAILED" });
    }
  };

  return async (event) => {
    const failures = [];
    for (const record of event.Records ?? []) {
      try {
        await processRecord(record);
      } catch {
        failures.push({
          itemIdentifier: record?.dynamodb?.SequenceNumber ?? record?.eventID ?? "unknown",
        });
      }
    }
    return { batchItemFailures: failures };
  };
}

const region = process.env.AUDIT_REGION;
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({
  region: process.env.REGION,
}));
const logsClient = new CloudWatchLogsClient({ region });
const publishState = createStatePublisher({
  endpoint: process.env.API_TEAM_GRAPHQLAPIENDPOINTOUTPUT,
  region: process.env.REGION,
});
const updateSession = createSessionUpdater({
  documentClient,
  publishState,
  sessionsTableName: process.env.SESSIONS_TABLE_NAME,
});

export const handler = createHandler({
  logsClient,
  updateSession,
  auditLogGroupArn: process.env.AUDIT_LOG_GROUP_ARN,
});
