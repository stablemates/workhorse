import type {
  TaskListCursor,
  TaskListQuery,
  TaskPayloadProjection,
  TaskState,
  TaskTimelineCursor,
} from "../types.js";
import {
  DEFAULT_TASK_QUERY_PAYLOAD_BYTES,
  MAX_TASK_QUERY_PAGE_SIZE,
  MAX_TASK_QUERY_PAYLOAD_BYTES,
  MAX_TASK_QUERY_REDACT_KEYS,
} from "../types.js";

const TASK_LIST_FIELDS = new Set([
  "queue",
  "type",
  "states",
  "createdAfter",
  "createdBefore",
  "limit",
  "cursor",
  "payload",
]);
const TASK_LIST_CURSOR_FIELDS = new Set(["createdAt", "taskId", "signature"]);
const PAYLOAD_PROJECTION_FIELDS = new Set(["include", "maxBytes", "redactKeys"]);
const TASK_STATES = new Set<TaskState>([
  "blocked",
  "scheduled",
  "ready",
  "active",
  "succeeded",
  "failed",
  "canceled",
]);

export interface ValidatedTaskListQuery {
  readonly limit: number;
  readonly cursor: TaskListCursor | undefined;
  readonly payloadProjection: Required<TaskPayloadProjection>;
}

function validateFiniteDate(value: Date | undefined, field: string): void {
  if (value !== undefined && (!(value instanceof Date) || !Number.isFinite(value.getTime()))) {
    throw new TypeError(`${field} must be a finite Date`);
  }
}

function validateKnownFields(
  value: object,
  allowedFields: ReadonlySet<string>,
  label: string,
): void {
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) throw new TypeError(`${label} contains unknown field: ${field}`);
  }
}

function validateRequiredStrings(
  fields: readonly (readonly [field: string, value: unknown])[],
  label: string,
): void {
  for (const [field, fieldValue] of fields) {
    if (typeof fieldValue !== "string" || fieldValue.length === 0) {
      throw new TypeError(`${label} ${field} must be a non-empty string`);
    }
  }
}

export function validatePageLimit(
  value: number | undefined,
  defaultValue: number,
  maximum: number,
  label: string,
): number {
  const limit = value ?? defaultValue;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new RangeError(`${label} must be an integer between 1 and ${maximum}`);
  }
  return limit;
}

export function validateTaskListQuery(query: TaskListQuery): ValidatedTaskListQuery {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    throw new TypeError("listTasks query must be an object");
  }
  validateKnownFields(query, TASK_LIST_FIELDS, "listTasks query");

  const limit = validatePageLimit(query.limit, 100, MAX_TASK_QUERY_PAGE_SIZE, "listTasks limit");
  validateFiniteDate(query.createdAfter, "listTasks createdAfter");
  validateFiniteDate(query.createdBefore, "listTasks createdBefore");
  if (
    query.createdAfter !== undefined &&
    query.createdBefore !== undefined &&
    query.createdAfter.getTime() >= query.createdBefore.getTime()
  ) {
    throw new RangeError("listTasks createdAfter must be earlier than createdBefore");
  }

  if (query.states !== undefined) {
    if (!Array.isArray(query.states) || query.states.length === 0) {
      throw new RangeError("listTasks states must be a non-empty array when supplied");
    }
    const uniqueStates = new Set<TaskState>();
    for (const state of query.states) {
      if (!TASK_STATES.has(state))
        throw new TypeError(`listTasks state is invalid: ${String(state)}`);
      if (uniqueStates.has(state)) {
        throw new RangeError(`listTasks states must be unique: ${state}`);
      }
      uniqueStates.add(state);
    }
  }

  const cursor = query.cursor;
  if (cursor !== undefined) {
    if (typeof cursor !== "object" || cursor === null) {
      throw new TypeError("listTasks cursor must be an object");
    }
    validateKnownFields(cursor, TASK_LIST_CURSOR_FIELDS, "listTasks cursor");
    validateRequiredStrings(
      [
        ["createdAt", cursor.createdAt],
        ["taskId", cursor.taskId],
        ["signature", cursor.signature],
      ],
      "listTasks cursor",
    );
  }

  if (
    query.payload !== undefined &&
    (typeof query.payload !== "object" || query.payload === null || Array.isArray(query.payload))
  ) {
    throw new TypeError("listTasks payload must be an object");
  }
  const projection = query.payload ?? {};
  validateKnownFields(projection, PAYLOAD_PROJECTION_FIELDS, "listTasks payload");
  if (projection.include !== undefined && typeof projection.include !== "boolean") {
    throw new TypeError("listTasks payload include must be a boolean");
  }
  if (
    projection.maxBytes !== undefined &&
    (!Number.isSafeInteger(projection.maxBytes) ||
      projection.maxBytes < 1 ||
      projection.maxBytes > MAX_TASK_QUERY_PAYLOAD_BYTES)
  ) {
    throw new RangeError(
      `listTasks payload maxBytes must be an integer between 1 and ${MAX_TASK_QUERY_PAYLOAD_BYTES}`,
    );
  }
  const redactKeys = projection.redactKeys ?? [];
  if (!Array.isArray(redactKeys)) {
    throw new TypeError("listTasks payload redactKeys must be an array");
  }
  if (redactKeys.length > MAX_TASK_QUERY_REDACT_KEYS) {
    throw new RangeError(
      `listTasks payload redactKeys must contain at most ${MAX_TASK_QUERY_REDACT_KEYS} keys`,
    );
  }
  const uniqueRedactKeys = new Set<string>();
  for (const key of redactKeys) {
    if (typeof key !== "string") {
      throw new TypeError("listTasks payload redactKeys must contain only strings");
    }
    const length = [...key].length;
    if (length < 1 || length > 200) {
      throw new RangeError("listTasks payload redactKeys must contain 1 to 200 characters");
    }
    if (uniqueRedactKeys.has(key)) {
      throw new RangeError(`listTasks payload redactKeys must be unique: ${key}`);
    }
    uniqueRedactKeys.add(key);
  }

  return {
    limit,
    cursor,
    payloadProjection: {
      include: projection.include ?? false,
      maxBytes: projection.maxBytes ?? DEFAULT_TASK_QUERY_PAYLOAD_BYTES,
      redactKeys,
    },
  };
}

export function validateTaskTimelineCursor(
  taskId: string,
  cursor: TaskTimelineCursor | undefined,
): TaskTimelineCursor | undefined {
  if (cursor === undefined) return undefined;
  if (typeof cursor !== "object" || cursor === null) {
    throw new TypeError("getTaskTimeline cursor must be an object");
  }
  validateRequiredStrings(
    [
      ["taskId", cursor.taskId],
      ["occurredAt", cursor.occurredAt],
      ["recordId", cursor.recordId],
    ],
    "getTaskTimeline cursor",
  );
  if (cursor.kind !== "event" && cursor.kind !== "attempt") {
    throw new TypeError("getTaskTimeline cursor kind must be event or attempt");
  }
  if (cursor.taskId !== taskId) {
    throw new RangeError("getTaskTimeline cursor taskId must match the requested taskId");
  }
  return cursor;
}
