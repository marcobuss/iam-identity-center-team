import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

const CACHE_SECONDS = 5 * 24 * 60 * 60;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUDITABLE_STATUSES = new Set(["in progress", "ended", "revoked"]);
const REUSABLE_QUERY_STATUSES = new Set([
  "QUEUED",
  "STARTING",
  "RUNNING",
  "COMPLETE",
]);

class PublicError extends Error {
  /**
   * Create an error whose message is safe to return through AppSync.
   * @param {string} code
   */
  constructor(code) {
    super(code);
    this.name = "PublicError";
    this.code = code;
  }
}

/**
 * Convert a Cognito claim into an array of string values.
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
 * Determine whether an AppSync identity can inspect a canonical TEAM request.
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
 * Validate and derive the server-owned CloudWatch query window.
 * @param {Record<string, unknown>} request
 * @param {Date} now
 * @returns {{startTime: string, endTime: string}}
 */
export function deriveQueryWindow(request, now) {
  if (!AUDITABLE_STATUSES.has(String(request.status))) {
    throw new PublicError("REQUEST_NOT_AUDITABLE");
  }

  const start = new Date(String(request.startTime ?? ""));
  if (Number.isNaN(start.getTime())) {
    throw new PublicError("REQUEST_NOT_READY");
  }

  const end = request.status === "in progress"
    ? now
    : new Date(String(request.endTime ?? ""));
  if (Number.isNaN(end.getTime()) || end.getTime() < start.getTime()) {
    throw new PublicError("REQUEST_NOT_READY");
  }

  return { startTime: start.toISOString(), endTime: end.toISOString() };
}

/**
 * Return the subset of session state that is safe for a browser.
 * @param {Record<string, unknown>} session
 * @returns {Record<string, unknown>}
 */
export function publicQueryState(session) {
  return {
    requestId: session.id,
    status: session.status,
    errorCode: session.errorCode ?? null,
    expireAt: session.expireAt ?? null,
  };
}

/**
 * Create the AppSync Lambda handler with injectable I/O and time.
 * @param {{documentClient: {send: Function}, now?: () => Date, requestsTableName: string, sessionsTableName: string}} dependencies
 * @returns {(event: Record<string, any>) => Promise<Record<string, unknown>>}
 */
export function createHandler({
  documentClient,
  now = () => new Date(),
  requestsTableName,
  sessionsTableName,
}) {
  return async (event) => {
    const requestId = event?.arguments?.requestId;
    if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
      throw new PublicError("INVALID_REQUEST");
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

    for (const field of ["accountId", "role", "username", "owner"]) {
      if (typeof request[field] !== "string" || request[field] === "") {
        throw new PublicError("REQUEST_NOT_READY");
      }
    }

    const currentTime = now();
    const window = deriveQueryWindow(request, currentTime);
    const existingResult = await documentClient.send(new GetCommand({
      TableName: sessionsTableName,
      Key: { id: requestId },
      ConsistentRead: true,
    }));
    const existing = existingResult.Item;
    const refreshRequested = event?.info?.fieldName === "refreshSessionActivityQuery";

    if (refreshRequested && request.status !== "in progress") {
      throw new PublicError("REFRESH_NOT_ALLOWED");
    }

    const nowEpoch = Math.floor(currentTime.getTime() / 1000);
    const isUnexpired = existing && Number(existing.expireAt ?? 0) > nowEpoch;
    const endedWindowMatches = request.status === "in progress"
      || existing?.endTime === window.endTime;
    if (!refreshRequested && isUnexpired && endedWindowMatches
      && REUSABLE_QUERY_STATUSES.has(String(existing.status))) {
      return publicQueryState(existing);
    }

    const generation = Number(existing?.generation ?? 0) + 1;
    const item = {
      id: requestId,
      owner: request.owner,
      approver_ids: Array.isArray(request.approver_ids) ? request.approver_ids : [],
      startTime: window.startTime,
      endTime: window.endTime,
      username: request.username,
      accountId: request.accountId,
      role: request.role,
      status: "QUEUED",
      generation,
      requestedAt: currentTime.toISOString(),
      expireAt: nowEpoch + CACHE_SECONDS,
      createdAt: existing?.createdAt ?? currentTime.toISOString(),
      updatedAt: currentTime.toISOString(),
      __typename: "sessions",
    };

    const putInput = {
      TableName: sessionsTableName,
      Item: item,
      ConditionExpression: existing
        ? "generation = :expectedGeneration"
        : "attribute_not_exists(id)",
      ExpressionAttributeValues: existing
        ? { ":expectedGeneration": Number(existing.generation ?? 0) }
        : undefined,
    };

    try {
      await documentClient.send(new PutCommand(putInput));
      return publicQueryState(item);
    } catch (error) {
      if (error?.name !== "ConditionalCheckFailedException") {
        throw error;
      }

      const concurrentResult = await documentClient.send(new GetCommand({
        TableName: sessionsTableName,
        Key: { id: requestId },
        ConsistentRead: true,
      }));
      if (!concurrentResult.Item) {
        throw new PublicError("QUERY_STATE_CONFLICT");
      }
      return publicQueryState(concurrentResult.Item);
    }
  };
}

const region = process.env.REGION;
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

export const handler = createHandler({
  documentClient,
  requestsTableName: process.env.REQUESTS_TABLE_NAME,
  sessionsTableName: process.env.SESSIONS_TABLE_NAME,
});
