import type { JobListQuery, JobTimelineCursor } from "../types.js";
import { MAX_JOB_QUERY_PAGE_SIZE } from "../types.js";
import {
  validateJobListQuery,
  validateJobTimelineCursor,
  validatePageLimit,
  type ValidatedJobListQuery,
} from "./filter-cursor.js";
import { QueueModule } from "./module-context.js";

/** Owns shared operator-query validation and receives the matching database reads. */
export class OperatorReadsModule extends QueueModule {
  validateJobListQuery(query: JobListQuery): ValidatedJobListQuery {
    return validateJobListQuery(query);
  }

  validateJobTimelineQuery(
    jobId: string,
    limit: number | undefined,
    cursor: JobTimelineCursor | undefined,
  ): { limit: number; cursor: JobTimelineCursor | undefined } {
    return {
      limit: validatePageLimit(limit, 100, MAX_JOB_QUERY_PAGE_SIZE, "getJobTimeline limit"),
      cursor: validateJobTimelineCursor(jobId, cursor),
    };
  }
}
