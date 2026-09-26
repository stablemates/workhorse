import type { Queryable } from "../../src/index.js";

/** A blocked row whose counters disagree with the dependency edges they summarize. */
export interface DependencyCounterDrift {
  readonly task_id: string;
  readonly pending_prerequisites: number;
  readonly pending_edges: number;
  readonly dependency_rejected: boolean;
  readonly rejected_edges: boolean;
}

/**
 * Reads every blocked row whose counters drifted from its edges.
 *
 * A blocked row counts its unreleased edges and records whether a resolved edge rejected it. The
 * table's own check covers every other state, so an empty answer means the invariant holds.
 */
export async function readDependencyCounterDrift(
  client: Queryable,
): Promise<DependencyCounterDrift[]> {
  const result = await client.query<DependencyCounterDrift>(
    `SELECT runtime.task_id, runtime.pending_prerequisites, edges.pending_edges,
            runtime.dependency_rejected, edges.rejected_edges
       FROM workhorse.task_runtime runtime
       CROSS JOIN LATERAL (
         SELECT (count(*) FILTER (WHERE dependency.released_at IS NULL))::integer AS pending_edges,
                coalesce(bool_or(dependency.resolution IN ('fail', 'cancel')), false)
                  AS rejected_edges
           FROM workhorse.task_dependency dependency
          WHERE dependency.dependent_task_id = runtime.task_id
       ) edges
      WHERE runtime.state = 'blocked'
        AND (runtime.pending_prerequisites <> edges.pending_edges
             OR runtime.dependency_rejected <> edges.rejected_edges)
      ORDER BY runtime.task_id`,
  );
  return result.rows;
}
