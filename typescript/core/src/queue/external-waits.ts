export const MAX_EXTERNAL_WAIT_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_EXTERNAL_WAIT_LIST_SIZE = 1_000;

export interface ExternalWaitOptions {
  /** Fail the job if the boundary remains unanswered for this many milliseconds. */
  timeoutMs?: number;
}

export interface ExternalWaitListOptions {
  /** Maximum actionable waits returned in creation order. */
  limit?: number;
  /** Exact continuation returned by a previous external-wait page. */
  cursor?: ExternalWaitCursor;
}

export interface ExternalWaitCursor {
  /** Exact PostgreSQL UTC timestamp text. Treat as opaque continuation state. */
  createdAt: string;
  jobId: string;
  name: string;
}

export interface ExternalWaitRecord {
  jobId: string;
  queue: string;
  jobType: string;
  name: string;
  attempt: number;
  createdAt: Date;
  deadlineAt: Date;
}

export type ExternalWaitRow = {
  job_id: string;
  queue_name: string;
  job_type: string;
  wait_name: string;
  attempt: number;
  created_at: Date | string;
  deadline_at: Date | string;
  cursor_created_at: string;
};

export function validateExternalWaitListOptions(options: ExternalWaitListOptions): {
  limit: number;
  cursor: ExternalWaitCursor | undefined;
} {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("External wait list options must be an object");
  }
  const fields = Object.keys(options);
  const unknownField = fields.find((field) => field !== "limit" && field !== "cursor");
  if (unknownField !== undefined) {
    throw new TypeError(`External wait list options contain unknown field: ${unknownField}`);
  }
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EXTERNAL_WAIT_LIST_SIZE) {
    throw new RangeError(
      `External wait list limit must be an integer between 1 and ${MAX_EXTERNAL_WAIT_LIST_SIZE}`,
    );
  }
  const cursor = options.cursor;
  if (cursor !== undefined) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      throw new TypeError("External wait list cursor must be an object");
    }
    const cursorFields = Object.keys(cursor);
    const unknownCursorField = cursorFields.find(
      (field) => field !== "createdAt" && field !== "jobId" && field !== "name",
    );
    if (unknownCursorField !== undefined) {
      throw new TypeError(
        `External wait list cursor contains unknown field: ${unknownCursorField}`,
      );
    }
    for (const [field, value] of Object.entries(cursor)) {
      if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`External wait list cursor ${field} must be a non-empty string`);
      }
    }
    if (cursorFields.length !== 3) {
      throw new TypeError("External wait list cursor requires createdAt, jobId, and name");
    }
  }
  return { limit, cursor };
}

export function externalWaitRecord(row: ExternalWaitRow): ExternalWaitRecord {
  return {
    jobId: row.job_id,
    queue: row.queue_name,
    jobType: row.job_type,
    name: row.wait_name,
    attempt: Number(row.attempt),
    createdAt: new Date(row.created_at),
    deadlineAt: new Date(row.deadline_at),
  };
}

export function externalWaitCursor(row: ExternalWaitRow): ExternalWaitCursor {
  return { createdAt: row.cursor_created_at, jobId: row.job_id, name: row.wait_name };
}

export function validateExternalWaitOptions(options: ExternalWaitOptions): number | null {
  const timeoutMs = options.timeoutMs;
  if (timeoutMs === undefined) return null;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_EXTERNAL_WAIT_TIMEOUT_MS
  ) {
    throw new RangeError(
      `External wait timeoutMs must be an integer between 1 and ${MAX_EXTERNAL_WAIT_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}
