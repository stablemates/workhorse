import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseTestHarness } from "./support/db.js";

const database = createDatabaseTestHarness(import.meta.url);
/** Tasks seeded before the first measurement, and how many more the table then grows by. */
const seededTasks = 5_000;
const grownBy = 45_000;
const rareQueue = "pruning-rare";
const rareType = "pruning.rare";
const rareTag = "pruning:rare";
const procedures = ["dashboard_tasks_v1", "dashboard_tasks_cursor_v1"] as const;
const probes = {
  tag: { tags: [rareTag] },
  queue: { queue: rareQueue },
  "task type": { taskType: rareType },
} as const;

describe("dashboard task pruning", () => {
  beforeAll(async () => {
    await database.setup();
    // One task apart from the rest on each filterable column, so a request that names one of them
    // selects a single task however large the table grows around it.
    await seedTasks(1, rareQueue, rareType, rareTag);
    await seedTasks(seededTasks);
  });

  afterAll(async () => database.teardown());

  // Both listings read the joined task, runtime, and outcome projection and applied the tag,
  // queue, and task-type filters to the result, so a page for one task cost what every task in the
  // installation costs (SM-757). Each filter now sits where an index can answer it, which shows up
  // two ways: the same request over a table ten times larger reads about as much, and it reads far
  // less than a page that names no filter to prune on. Before the change one measured 5 times its
  // smaller self and the other read nearly the unfiltered page; both bounds below fail on it.
  it("keeps a filtered task page independent of how many tasks exist", async () => {
    const small = await measureProbes();
    await seedTasks(grownBy);
    const grown = await measureProbes();

    for (const procedure of procedures) {
      for (const name of Object.keys(probes)) {
        const probe = `${procedure} ${name}`;
        // Three times, not once, because a larger table deepens every index a request seeks and
        // because how much the returned page costs to enrich varies with what it holds.
        expect(
          grown[probe],
          `${probe} read ${small[probe]} blocks over ${seededTasks} tasks and ${grown[probe]} over ${
            seededTasks + grownBy
          }`,
        ).toBeLessThan(small[probe]! * 3);
        // Half the unfiltered page of the same procedure, which names no filter to prune on. The
        // bound is measured rather than named, so it holds whatever the seeded table costs here.
        const unfiltered = grown[`${procedure} unfiltered`]!;
        expect(
          grown[probe],
          `${probe} read ${grown[probe]} blocks of the ${unfiltered} an unfiltered page reads`,
        ).toBeLessThan(unfiltered / 2);
      }
    }
  });
});

/** The blocks each filtered request reads, per procedure, plus an unfiltered page as a control. */
async function measureProbes(): Promise<Record<string, number>> {
  const measured: Record<string, number> = {};
  for (const procedure of procedures) {
    for (const [name, input] of Object.entries(probes)) {
      const request = { ...input, pageSize: 25 };
      const tasks = await database.pool.query<{ total: number }>(
        `SELECT jsonb_array_length(workhorse.${procedure}($1::jsonb)->'tasks') AS total`,
        [JSON.stringify(request)],
      );
      expect(tasks.rows[0]!.total, `${procedure} found no task to prune to`).toBe(1);
      measured[`${procedure} ${name}`] = await blocksRead(procedure, request);
    }
    measured[`${procedure} unfiltered`] = await blocksRead(procedure, { pageSize: 25 });
  }
  return measured;
}

/**
 * How many shared blocks one call reads. A procedure plans its own body, so the plan of the call
 * reports the nested reads only as these totals, which is exactly what pruning changes.
 */
async function blocksRead(procedure: string, input: Record<string, unknown>): Promise<number> {
  const result = await database.pool.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT workhorse.${procedure}($1::jsonb)`,
    [JSON.stringify(input)],
  );
  const plan = (
    result.rows[0]?.["QUERY PLAN"] as
      | Array<{ Plan?: { "Shared Hit Blocks"?: number; "Shared Read Blocks"?: number } }>
      | undefined
  )?.[0]?.Plan;
  const blocks = (plan?.["Shared Hit Blocks"] ?? 0) + (plan?.["Shared Read Blocks"] ?? 0);
  expect(blocks).toBeGreaterThan(0);
  return blocks;
}

/**
 * Seeds ready tasks. Runtime rows only: these tasks exist to give the filters a table worth
 * pruning, and how much the returned page itself costs to enrich is bounded elsewhere.
 */
async function seedTasks(
  count: number,
  queue = "pruning-bulk",
  type = "pruning.bulk",
  tag = "pruning:bulk",
): Promise<void> {
  await database.pool.query(
    `WITH seeded AS (
       INSERT INTO workhorse.task(queue_name, task_type, payload, tags, max_attempts)
       SELECT $2, $3, '{}'::jsonb, ARRAY[$4], 1 FROM generate_series(1, $1)
       RETURNING id
     )
     INSERT INTO workhorse.task_runtime(
       task_id, queue_name, state, current_attempt, run_at, ready_at, sequence
     )
     SELECT id, $2, 'ready', 1, clock_timestamp(), clock_timestamp(),
            nextval('workhorse.ready_sequence_seq')
       FROM seeded`,
    [count, queue, type, tag],
  );
  await database.pool.query(`ANALYZE workhorse.task;
     ANALYZE workhorse.task_query;
     ANALYZE workhorse.task_runtime;`);
}
