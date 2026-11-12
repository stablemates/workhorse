import type { PoolClient, QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DashboardEventDetail, DashboardEventsPage } from "../../dashboard-server/src/wire.js";
import { createDatabaseTestHarness } from "./support/db.js";

// dashboard_event_detail_v1 finds a history record by its identity. No index holds the identity
// of a record that the dashboard views derive for a fast-tier task, so a read with the identity
// alone reads each fast-tier row. With the task of the record, the read seeks that task (SM-2029).
const database = createDatabaseTestHarness(import.meta.url, { max: 2 });

const storedError = { name: "Error", message: "boom" };

async function value<T>(sql: string, input: object): Promise<T> {
  const result = await database.pool.query<{ result: T } & QueryResultRow>(sql, [
    JSON.stringify(input),
  ]);
  return result.rows[0]!.result;
}

const events = (input: object) =>
  value<DashboardEventsPage>("SELECT workhorse.dashboard_events_v1($1::jsonb) AS result", input);
const eventDetail = (input: object) =>
  value<DashboardEventDetail | null>(
    "SELECT workhorse.dashboard_event_detail_v1($1::jsonb) AS result",
    input,
  );

type Row = DashboardEventsPage["events"][number];
type SampledRow = Pick<Row, "id" | "kind" | "recordId" | "taskId">;

let fastTask: string;
let fullTask: string;
let otherTask: string;

/** Fast-tier outcomes of other tasks, so that a read of each fast-tier row reads more rows. */
async function addOutcomes(count: number): Promise<void> {
  await database.pool.query(
    `WITH filler AS (
       INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts)
       SELECT 'detail-seek-filler', 'detail.filler', '{}'::jsonb, 1 FROM generate_series(1, $1)
       RETURNING id
     )
     INSERT INTO workhorse.fast_task_outcome(
       task_id, queue_name, task_type, state, attempt, result, fence_token, worker_id,
       claimed_at, enqueued_at
     )
     SELECT id, 'detail-seek-filler', 'detail.filler', 'succeeded', 1, '{}'::jsonb, 1, 'w',
            clock_timestamp(), clock_timestamp()
       FROM filler`,
    [count],
  );
  await database.pool.query("VACUUM (ANALYZE) workhorse.task, workhorse.fast_task_outcome");
}

/** The rows of the feed for one task: each event and each attempt. */
async function recordsOf(taskId: string): Promise<Row[]> {
  return (await events({ taskId, pageSize: 100 })).events;
}

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: PlanNode[];
};

function nodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodes)];
}

/**
 * The lookup of the installed function that names the task, with its variables as parameters.
 * `INTO` goes away, so EXPLAIN can run the statement as the function does.
 */
async function installedLookup(kind: "event" | "attempt"): Promise<string> {
  const source = await database.pool.query<{ source: string }>(
    `SELECT prosrc AS source FROM pg_proc
      WHERE oid = 'workhorse.dashboard_event_detail_v1(jsonb)'::regprocedure`,
  );
  const alias = kind === "event" ? "event" : "history";
  const view = kind === "event" ? "dashboard_task_event_v1" : "dashboard_attempt_history_v1";
  const statements = source.rows[0]!.source.split(";");
  const lookup = statements.find(
    (statement) =>
      statement.includes(`FROM workhorse.${view} ${alias}\n`) &&
      statement.includes(`AND ${alias}.task_id = v_task_id`),
  );
  if (lookup === undefined) throw new Error(`found no ${kind} lookup that names the task`);
  return lookup
    .slice(lookup.indexOf("SELECT"))
    .replace(/INTO v_\w+/, "")
    .replaceAll("v_record_id", "$1::uuid")
    .replaceAll("v_task_id", "$2::uuid");
}

/**
 * The rows that each scan of the lookup reads: the rows it returns and the rows its filter
 * removes, for each loop. The plan cache mode makes PostgreSQL plan with the values or without.
 */
async function lookupRowsRead(
  client: PoolClient,
  row: SampledRow,
  mode: "force_custom_plan" | "force_generic_plan",
): Promise<{ found: number; read: number; fastSeqScans: number }> {
  const statement = await installedLookup(row.kind);
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL plan_cache_mode = ${mode}`);
    await client.query(`PREPARE detail_lookup(uuid, uuid) AS ${statement}`);
    const plan = await client.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE detail_lookup(${client.escapeLiteral(
        row.recordId,
      )}, ${client.escapeLiteral(row.taskId)})`,
    );
    const all = nodes(plan.rows[0]!["QUERY PLAN"][0]!.Plan);
    const scans = all.filter((node) => node["Relation Name"] !== undefined);
    return {
      found: plan.rows[0]!["QUERY PLAN"][0]!.Plan["Actual Rows"],
      read: scans.reduce(
        (sum, node) =>
          sum +
          (node["Actual Rows"] +
            (node["Rows Removed by Filter"] ?? 0) +
            (node["Rows Removed by Index Recheck"] ?? 0)) *
            node["Actual Loops"],
        0,
      ),
      fastSeqScans: scans.filter(
        (node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "fast_task_outcome",
      ).length,
    };
  } finally {
    await client.query("ROLLBACK");
    // A prepared statement outlives the transaction.
    await client.query("DEALLOCATE ALL");
  }
}

/**
 * What one call of the installed function reads: the rows and index entries of each relation of
 * the schema, from the statistics of the transaction.
 */
async function callRowsRead(
  client: PoolClient,
  input: object,
  mode: "force_custom_plan" | "force_generic_plan",
): Promise<{ detail: DashboardEventDetail | null; read: number }> {
  const readSoFar = `SELECT sum(pg_stat_get_xact_tuples_returned(relation.oid))::bigint AS read
                       FROM pg_class relation
                      WHERE relation.relnamespace = 'workhorse'::regnamespace
                        AND relation.relkind IN ('r', 'i')`;
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL plan_cache_mode = ${mode}`);
    const before = await client.query<{ read: string }>(readSoFar);
    const result = await client.query<{ result: DashboardEventDetail | null }>(
      "SELECT workhorse.dashboard_event_detail_v1($1::jsonb) AS result",
      [JSON.stringify(input)],
    );
    const after = await client.query<{ read: string }>(readSoFar);
    return {
      detail: result.rows[0]!.result,
      read: Number(after.rows[0]!.read) - Number(before.rows[0]!.read),
    };
  } finally {
    await client.query("ROLLBACK");
  }
}

beforeAll(async () => {
  await database.setup();
  const pool = database.pool;
  // A fast-tier queue that records no attempts and no claims, so each history record of its
  // tasks is derived. The task fails one time and then fails for good, so it has a retried
  // attempt in its errors list and a final attempt on its outcome row.
  await pool.query("SELECT workhorse.set_queue_tier_v1('detail-seek', 'fast', 'test', 'seed')");
  const enqueued = await pool.query<{ task_id: string }>(
    `SELECT task_id FROM workhorse.enqueue_many_v1(
       '[{"queue":"detail-seek","type":"detail.fast","payload":{},"maxAttempts":2},
         {"queue":"detail-seek","type":"detail.other","payload":{}}]'::jsonb)`,
  );
  [fastTask, otherTask] = enqueued.rows.map((row) => row.task_id) as [string, string];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const claims = await pool.query<{ task_id: string; fence_token: string }>(
      "SELECT task_id, fence_token FROM workhorse.fast_claim_v1('detail-seek', 'w', 2, 30000, false)",
    );
    for (const claim of claims.rows) {
      if (claim.task_id === fastTask) {
        await pool.query("SELECT workhorse.fast_fail_v1($1, 'w', $2, $3::jsonb, 0)", [
          claim.task_id,
          claim.fence_token,
          JSON.stringify(storedError),
        ]);
      } else {
        await pool.query("SELECT workhorse.fast_complete_v1($1, 'w', $2, '{}'::jsonb)", [
          claim.task_id,
          claim.fence_token,
        ]);
      }
    }
  }

  // A full-tier task, whose events and attempts are recorded rows with version 7 identities.
  const full = await pool.query<{ task_id: string }>(
    `SELECT task_id FROM workhorse.enqueue_many_v1(
       '[{"queue":"detail-seek-full","type":"detail.full","payload":{},"maxAttempts":1}]'::jsonb)`,
  );
  fullTask = full.rows[0]!.task_id;
  const claim = await pool.query<{ fence_token: string }>(
    "SELECT fence_token FROM workhorse.claim_v1('detail-seek-full', 'w', 30000)",
  );
  await pool.query("SELECT workhorse.fail_v1($1, 'w', $2, $3::jsonb, 0)", [
    fullTask,
    claim.rows[0]!.fence_token,
    JSON.stringify(storedError),
  ]);
});
afterAll(async () => database.teardown());

describe("event detail with the task of the record", () => {
  it("returns the same document as a read without the task, for each record of the feed", async () => {
    const records = [...(await recordsOf(fastTask)), ...(await recordsOf(fullTask))];
    expect(new Set(records.map((row) => `${row.taskId === fastTask}:${row.kind}`))).toEqual(
      new Set(["true:event", "true:attempt", "false:event", "false:attempt"]),
    );
    for (const row of records) {
      const withoutTask = await eventDetail({ id: row.id });
      expect(withoutTask).toMatchObject({ id: row.id, recordId: row.recordId, taskId: row.taskId });
      expect(await eventDetail({ id: row.id, taskId: row.taskId })).toEqual(withoutTask);
      expect(await eventDetail({ id: row.id, taskId: null })).toEqual(withoutTask);
      // An empty key counts as no key, as in the other dashboard reads.
      expect(await eventDetail({ id: row.id, taskId: "" })).toEqual(withoutTask);
      expect(await eventDetail({ id: row.id, taskId: row.taskId.toUpperCase() })).toEqual(
        withoutTask,
      );
    }
  });

  it("finds no record when the task is another task or is not a UUID", async () => {
    for (const row of [...(await recordsOf(fastTask)), ...(await recordsOf(fullTask))]) {
      expect(await eventDetail({ id: row.id, taskId: otherTask })).toBeNull();
      expect(await eventDetail({ id: row.id, taskId: "not-a-task" })).toBeNull();
    }
  });

  it("reads rows that do not grow with fast_task_outcome, and a read without the task does", async () => {
    const records = [...(await recordsOf(fastTask)), ...(await recordsOf(fullTask))];
    const sample = (taskId: string, kind: Row["kind"]) =>
      records.find((row) => row.taskId === taskId && row.kind === kind)!;
    // A recorded identity that the retention pass removed, so no branch finds it.
    const missing = "019a7c1e-0000-7000-8000-0000000000ff";
    // A read without the task stops at the first branch that finds the record. The recorded rows
    // come first, so it reads each fast-tier row for a derived identity or a missing one.
    const samples: Array<{ row: SampledRow; found: boolean; scansWithoutTask: boolean }> = [
      { row: sample(fastTask, "event"), found: true, scansWithoutTask: true },
      { row: sample(fastTask, "attempt"), found: true, scansWithoutTask: true },
      { row: sample(fullTask, "event"), found: true, scansWithoutTask: false },
      { row: sample(fullTask, "attempt"), found: true, scansWithoutTask: false },
      {
        row: { id: `event:${missing}`, kind: "event", recordId: missing, taskId: fullTask },
        found: false,
        scansWithoutTask: true,
      },
    ];
    const client = await database.pool.connect();
    try {
      const measure = async () => {
        const result: Array<{ id: string; mode: string; lookup: number; call: number }> = [];
        const unbounded: number[] = [];
        for (const { row, found } of samples) {
          for (const mode of ["force_custom_plan", "force_generic_plan"] as const) {
            const lookup = await lookupRowsRead(client, row, mode);
            const call = await callRowsRead(client, { id: row.id, taskId: row.taskId }, mode);
            const withoutTask = await callRowsRead(client, { id: row.id }, mode);
            expect({
              id: row.id,
              mode,
              found: lookup.found,
              fastSeqScans: lookup.fastSeqScans,
            }).toEqual({ id: row.id, mode, found: found ? 1 : 0, fastSeqScans: 0 });
            expect(call.detail).toEqual(withoutTask.detail);
            result.push({ id: row.id, mode, lookup: lookup.read, call: call.read });
            unbounded.push(withoutTask.read);
          }
        }
        return { result, unbounded };
      };

      await addOutcomes(2_000);
      const small = await measure();
      await addOutcomes(6_000);
      const large = await measure();

      // The same rows at 2,000 and at 8,000 other fast-tier outcomes, for each identity and mode.
      expect(large.result).toEqual(small.result);
      for (const read of large.result) expect(read.call).toBeLessThan(100);
      // Without the task, a derived or missing identity reads each fast-tier row.
      const scanning = samples.flatMap(({ scansWithoutTask }) => [
        scansWithoutTask,
        scansWithoutTask,
      ]);
      expect(
        small.unbounded.filter((_, index) => scanning[index]).every((read) => read > 2_000),
      ).toBe(true);
      expect(
        large.unbounded.filter((_, index) => scanning[index]).every((read) => read > 8_000),
      ).toBe(true);
    } finally {
      client.release();
    }
  });
});
