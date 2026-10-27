import {
  CloudWatchLogsClient,
  GetQueryResultsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 1000;
const QUERY_LIMIT = 100000;
const START_STALL_TIMEOUT_MS = 2 * 60 * 1000;
const ALLOWED_FIELDS = new Set(["eventID", "eventName", "eventSource", "eventTime"]);
const TERMINAL_STATUSES = new Set(["COMPLETE", "FAILED", "CANCELLED", "TIMEOUT", "UNKNOWN"]);

class PublicError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = "PublicError";
    this.code = code;
  }
}

/**
 * Normalize a Cognito list claim.
 * @param {unknown} value
 * @returns {string[]}
 */
export function claimValues(value) {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value !== "string" || value.trim() === "") {
    return [];
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
}

/**
 * Determine whether the current identity can inspect the request.
 * @param {Record<string, unknown> | undefined} identity
 * @param {Record<string, unknown>} request
 * @returns {boolean}
 */
export function canAuditRequest(identity, request) {
  if (!identity || typeof identity.username !== "string") {
    return false;
  }
  const username = identity.username.toLowerCase();
  const claims = identity.claims && typeof identity.claims === "object"
    ? identity.claims
    : {};
  const requestUsername = String(request.username ?? "").toLowerCase();
  const owner = String(request.owner ?? "").toLowerCase();
  const subject = String(claims.sub ?? "").toLowerCase();
  if ((requestUsername !== "" && username === requestUsername)
    || owner === username
    || (subject !== "" && owner === `${subject}::${username}`)) {
    return true;
  }

  if (claimValues(claims["cognito:groups"]).includes("Auditors")) {
    return true;
  }

  const userId = String(claims.userId ?? "").toLowerCase();
  const approverIds = Array.isArray(request.approver_ids)
    ? request.approver_ids.map((value) => String(value).toLowerCase())
    : [];
  return userId !== "" && approverIds.includes(userId);
}

/**
 * Convert one CloudWatch result row to the public four-field shape.
 * @param {Array<{field?: string, value?: string}>} row
 * @returns {Record<string, string>}
 */
export function mapResultRow(row) {
  const event = {};
  for (const resultField of row ?? []) {
    if (ALLOWED_FIELDS.has(resultField.field)) {
      event[resultField.field] = resultField.value ?? "";
    }
  }
  return event;
}

/**
 * Map a CloudWatch query status to the public TEAM status.
 * @param {string | undefined} status
 * @returns {string}
 */
export function mapQueryStatus(status) {
  const mapping = {
    Scheduled: "RUNNING",
    Running: "RUNNING",
    Complete: "COMPLETE",
    Failed: "FAILED",
    Cancelled: "CANCELLED",
    Timeout: "TIMEOUT",
    Unknown: "UNKNOWN",
  };
  return mapping[status] ?? "UNKNOWN";
}

/**
 * Map a terminal status to a safe client error code.
 * @param {string} status
 * @returns {string | null}
 */
function errorCodeForStatus(status) {
  const mapping = {
    FAILED: "QUERY_FAILED",
    CANCELLED: "QUERY_CANCELLED",
    TIMEOUT: "QUERY_TIMEOUT",
    UNKNOWN: "QUERY_STATUS_UNKNOWN",
  };
  return mapping[status] ?? null;
}

/**
 * Create the authorized AppSync result handler with injectable clients.
 * @param {{documentClient: {send: Function}, logsClient: {send: Function}, requestsTableName: string, sessionsTableName: string, now?: () => Date}} dependencies
 * @returns {(event: Record<string, any>) => Promise<Record<string, unknown>>}
 */
export function createHandler({
  documentClient,
  logsClient,
  requestsTableName,
  sessionsTableName,
  now = () => new Date(),
}) {
  return async (event) => {
    const requestId = event?.arguments?.requestId;
    const nextToken = event?.arguments?.nextToken;
    if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
      throw new PublicError("INVALID_REQUEST");
    }
    if (nextToken != null && (typeof nextToken !== "string" || nextToken.length > 1024)) {
      throw new PublicError("INVALID_PAGE_TOKEN");
    }

    const requestResult = await documentClient.send(new GetCommand({
      TableName: requestsTableName,
      Key: { id: requestId },
      ConsistentRead: true,
    }));
    const request = requestResult.Item;
    if (!request || !canAuditRequest(event.identity, request)) {
      throw new PublicError("NOT_AUTHORIZED");
    }

    const sessionResult = await documentClient.send(new GetCommand({
      TableName: sessionsTableName,
      Key: { id: requestId },
      ConsistentRead: true,
    }));
    const session = sessionResult.Item;
    if (!session) {
      return pageResponse(requestId, "UNKNOWN", [], null, "QUERY_NOT_FOUND", false);
    }

    if (["QUEUED", "STARTING"].includes(session.status)) {
      const requestedAt = new Date(String(session.requestedAt ?? "")).getTime();
      const isStalled = Number.isFinite(requestedAt)
        && now().getTime() - requestedAt > START_STALL_TIMEOUT_MS;
      if (isStalled) {
        await markStalledState({ documentClient, sessionsTableName, session });
        return pageResponse(requestId, "FAILED", [], null, "QUERY_START_STALLED", false);
      }
      return pageResponse(requestId, session.status, [], null, null, false);
    }
    if (TERMINAL_STATUSES.has(session.status) && session.status !== "COMPLETE") {
      return pageResponse(
        requestId,
        session.status,
        [],
        null,
        session.errorCode ?? errorCodeForStatus(session.status),
        false,
      );
    }
    if (typeof session.queryId !== "string" || session.queryId === "") {
      return pageResponse(requestId, "FAILED", [], null, "INVALID_QUERY_STATE", false);
    }

    let queryResult;
    try {
      queryResult = await logsClient.send(new GetQueryResultsCommand({
        queryId: session.queryId,
        maxItems: PAGE_SIZE,
        nextToken: nextToken ?? undefined,
      }));
    } catch {
      return pageResponse(
        requestId,
        session.status,
        [],
        null,
        nextToken ? "INVALID_PAGE_TOKEN" : "QUERY_RESULTS_UNAVAILABLE",
        false,
      );
    }

    const status = mapQueryStatus(queryResult.status);
    const events = status === "COMPLETE"
      ? (queryResult.results ?? []).map(mapResultRow)
      : [];
    const potentiallyTruncated = Number(queryResult.statistics?.resultCount ?? 0) >= QUERY_LIMIT;

    if (TERMINAL_STATUSES.has(status) && status !== session.status) {
      try {
        await updateTerminalState({
          documentClient,
          sessionsTableName,
          session,
          status,
          errorCode: errorCodeForStatus(status),
          now: now(),
        });
      } catch {
        process.stderr.write(`${JSON.stringify({
          level: "ERROR",
          operation: "audit_query_state_persist_failed",
          errorCode: "QUERY_STATE_UPDATE_FAILED",
        })}\n`);
      }
    }

    return pageResponse(
      requestId,
      status,
      events,
      queryResult.nextToken ?? null,
      errorCodeForStatus(status),
      potentiallyTruncated,
    );
  };
}

/**
 * Construct the stable GraphQL page response.
 * @returns {Record<string, unknown>}
 */
function pageResponse(requestId, status, events, nextToken, errorCode, potentiallyTruncated) {
  return { requestId, status, events, nextToken, errorCode, potentiallyTruncated };
}

/**
 * Convert a stalled pre-query state to a retryable failure.
 * @param {Record<string, any>} input
 */
async function markStalledState({ documentClient, sessionsTableName, session }) {
  try {
    await documentClient.send(new UpdateCommand({
      TableName: sessionsTableName,
      Key: { id: session.id },
      UpdateExpression: "SET #status = :failed, errorCode = :errorCode",
      ConditionExpression: "generation = :generation AND #status = :currentStatus",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":failed": "FAILED",
        ":errorCode": "QUERY_START_STALLED",
        ":generation": session.generation,
        ":currentStatus": session.status,
      },
    }));
  } catch (error) {
    if (error?.name !== "ConditionalCheckFailedException") {
      throw error;
    }
  }
}

/**
 * Persist terminal status without allowing a stale query generation to win.
 * @param {Record<string, any>} input
 */
async function updateTerminalState({
  documentClient,
  sessionsTableName,
  session,
  status,
  errorCode,
  now,
}) {
  try {
    await documentClient.send(new UpdateCommand({
      TableName: sessionsTableName,
      Key: { id: session.id },
      UpdateExpression: "SET #status = :status, errorCode = :errorCode, queryCompletedAt = :completedAt",
      ConditionExpression: "generation = :generation AND queryId = :queryId",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": status,
        ":errorCode": errorCode,
        ":completedAt": now.toISOString(),
        ":generation": session.generation,
        ":queryId": session.queryId,
      },
    }));
  } catch (error) {
    if (error?.name !== "ConditionalCheckFailedException") {
      throw error;
    }
  }
}

const region = process.env.AUDIT_REGION;
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.REGION }));
const logsClient = new CloudWatchLogsClient({ region });

export const handler = createHandler({
  documentClient,
  logsClient,
  requestsTableName: process.env.REQUESTS_TABLE_NAME,
  sessionsTableName: process.env.SESSIONS_TABLE_NAME,
});
