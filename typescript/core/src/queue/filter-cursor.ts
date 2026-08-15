import type {
  JobListCursor,
  JobListQuery,
  JobPayloadProjection,
  JobState,
  JobTimelineCursor,
} from "../types.js";
import {
  DEFAULT_JOB_QUERY_PAYLOAD_BYTES,
  MAX_JOB_QUERY_PAGE_SIZE,
  MAX_JOB_QUERY_PAYLOAD_BYTES,
  MAX_JOB_QUERY_REDACT_KEYS,
} from "../types.js";

const JOB_LIST_FIELDS = new Set([
  "queue",
  "type",
  "states",
  "createdAfter",
  "createdBefore",
  "limit",
  "cursor",
  "payload",
]);
const JOB_LIST_CURSOR_FIELDS = new Set(["createdAt", "jobId", "signature"]);
const PAYLOAD_PROJECTION_FIELDS = new Set(["include", "maxBytes", "redactKeys"]);
const JOB_STATES = new Set<JobState>([
  "blocked",
  "scheduled",
  "ready",
  "active",
  "succeeded",
  "failed",
  "canceled",
]);

export interface ValidatedJobListQuery {
  readonly limit: number;
  readonly cursor: JobListCursor | undefined;
  readonly payloadProjection: Required<JobPayloadProjection>;
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

export function validateJobListQuery(query: JobListQuery): ValidatedJobListQuery {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    throw new TypeError("listJobs query must be an object");
  }
  validateKnownFields(query, JOB_LIST_FIELDS, "listJobs query");

  const limit = validatePageLimit(query.limit, 100, MAX_JOB_QUERY_PAGE_SIZE, "listJobs limit");
  validateFiniteDate(query.createdAfter, "listJobs createdAfter");
  validateFiniteDate(query.createdBefore, "listJobs createdBefore");
  if (
    query.createdAfter !== undefined &&
    query.createdBefore !== undefined &&
    query.createdAfter.getTime() >= query.createdBefore.getTime()
  ) {
    throw new RangeError("listJobs createdAfter must be earlier than createdBefore");
  }

  if (query.states !== undefined) {
    if (!Array.isArray(query.states) || query.states.length === 0) {
      throw new RangeError("listJobs states must be a non-empty array when supplied");
    }
    const uniqueStates = new Set<JobState>();
    for (const state of query.states) {
      if (!JOB_STATES.has(state))
        throw new TypeError(`listJobs state is invalid: ${String(state)}`);
      if (uniqueStates.has(state)) {
        throw new RangeError(`listJobs states must be unique: ${state}`);
      }
      uniqueStates.add(state);
    }
  }

  const cursor = query.cursor;
  if (cursor !== undefined) {
    if (typeof cursor !== "object" || cursor === null) {
      throw new TypeError("listJobs cursor must be an object");
    }
    validateKnownFields(cursor, JOB_LIST_CURSOR_FIELDS, "listJobs cursor");
    validateRequiredStrings(
      [
        ["createdAt", cursor.createdAt],
        ["jobId", cursor.jobId],
        ["signature", cursor.signature],
      ],
      "listJobs cursor",
    );
  }

  if (
    query.payload !== undefined &&
    (typeof query.payload !== "object" || query.payload === null || Array.isArray(query.payload))
  ) {
    throw new TypeError("listJobs payload must be an object");
  }
  const projection = query.payload ?? {};
  validateKnownFields(projection, PAYLOAD_PROJECTION_FIELDS, "listJobs payload");
  if (projection.include !== undefined && typeof projection.include !== "boolean") {
    throw new TypeError("listJobs payload include must be a boolean");
  }
  if (
    projection.maxBytes !== undefined &&
    (!Number.isSafeInteger(projection.maxBytes) ||
      projection.maxBytes < 1 ||
      projection.maxBytes > MAX_JOB_QUERY_PAYLOAD_BYTES)
  ) {
    throw new RangeError(
      `listJobs payload maxBytes must be an integer between 1 and ${MAX_JOB_QUERY_PAYLOAD_BYTES}`,
    );
  }
  const redactKeys = projection.redactKeys ?? [];
  if (!Array.isArray(redactKeys)) {
    throw new TypeError("listJobs payload redactKeys must be an array");
  }
  if (redactKeys.length > MAX_JOB_QUERY_REDACT_KEYS) {
    throw new RangeError(
      `listJobs payload redactKeys must contain at most ${MAX_JOB_QUERY_REDACT_KEYS} keys`,
    );
  }
  const uniqueRedactKeys = new Set<string>();
  for (const key of redactKeys) {
    if (typeof key !== "string") {
      throw new TypeError("listJobs payload redactKeys must contain only strings");
    }
    const length = [...key].length;
    if (length < 1 || length > 200) {
      throw new RangeError("listJobs payload redactKeys must contain 1 to 200 characters");
    }
    if (uniqueRedactKeys.has(key)) {
      throw new RangeError(`listJobs payload redactKeys must be unique: ${key}`);
    }
    uniqueRedactKeys.add(key);
  }

  return {
    limit,
    cursor,
    payloadProjection: {
      include: projection.include ?? false,
      maxBytes: projection.maxBytes ?? DEFAULT_JOB_QUERY_PAYLOAD_BYTES,
      redactKeys,
    },
  };
}

export function validateJobTimelineCursor(
  jobId: string,
  cursor: JobTimelineCursor | undefined,
): JobTimelineCursor | undefined {
  if (cursor === undefined) return undefined;
  if (typeof cursor !== "object" || cursor === null) {
    throw new TypeError("getJobTimeline cursor must be an object");
  }
  validateRequiredStrings(
    [
      ["jobId", cursor.jobId],
      ["occurredAt", cursor.occurredAt],
      ["recordId", cursor.recordId],
    ],
    "getJobTimeline cursor",
  );
  if (cursor.kind !== "event" && cursor.kind !== "attempt") {
    throw new TypeError("getJobTimeline cursor kind must be event or attempt");
  }
  if (cursor.jobId !== jobId) {
    throw new RangeError("getJobTimeline cursor jobId must match the requested jobId");
  }
  return cursor;
}
