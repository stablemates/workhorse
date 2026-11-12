import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseTestHarness } from "./support/db.js";

// When an active lease leaves the active state, notify_concurrency_capacity_v1 counts the active
// leases of the admission shard that the lease counted against. A lease counts in the shard
// COALESCE(admission_shard, 0) % shards. The count reads four parts that an index on
// (queue_name, admission_shard) serves (SM-1991). These tests hold the decision of the trigger to
// that modulo rule for each stored value, and the count to the rows of one shard.

const database = createDatabaseTestHarness(import.meta.url);
const shardIndex = "workhorse.task_runtime_active_queue_shard_idx";

type Lease = { taskId: string; queueName: string; admissionShard: number | null };

async function insertLeases(leases: readonly Lease[]): Promise<void> {
  const taskIds = leases.map((lease) => lease.taskId);
  const queueNames = leases.map((lease) => lease.queueName);
  const shards = leases.map((lease) => lease.admissionShard);
  await database.pool.query(
    `INSERT INTO workhorse.task(id, queue_name, task_type, payload, max_attempts)
     SELECT lease.task_id, lease.queue_name, 'capacity.shard', '{}'::jsonb, 3
       FROM unnest($1::uuid[], $2::text[]) AS lease(task_id, queue_name)`,
    [taskIds, queueNames],
  );
  await database.pool.query(
    `INSERT INTO workhorse.task_runtime(
       task_id, queue_name, state, run_at, current_attempt, fence_token, worker_id, acquired_at,
       heartbeat_at, expires_at, attempt_started_at, admission_shard
     )
     SELECT lease.task_id, lease.queue_name, 'active', clock_timestamp(), 1, 1, 'shard-worker',
            clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour',
            clock_timestamp(), lease.admission_shard
       FROM unnest($1::uuid[], $2::text[], $3::smallint[])
              AS lease(task_id, queue_name, admission_shard)`,
    [taskIds, queueNames, shards],
  );
}

/**
 * Gives each queue a concurrency limit and a rate burst. The queue then has `shards` admission
 * shards, because admission_shard_count_v1 takes the least of 8, max_active, and the burst.
 */
async function setPolicies(
  policies: ReadonlyArray<{ queueName: string; maxActive: number; shards: number }>,
): Promise<void> {
  const queueNames = policies.map((policy) => policy.queueName);
  await database.pool.query(
    `INSERT INTO workhorse.concurrency_policy(queue_name, namespace, max_active)
     SELECT policy.queue_name, 'capacity-shard', policy.max_active
       FROM unnest($1::text[], $2::integer[]) AS policy(queue_name, max_active)`,
    [queueNames, policies.map((policy) => policy.maxActive)],
  );
  await database.pool.query(
    `INSERT INTO workhorse.rate_limit_policy(
       queue_name, namespace, rate_limit, rate_interval_ms, rate_burst
     )
     SELECT policy.queue_name, 'capacity-shard', 1, 1000, policy.rate_burst
       FROM unnest($1::text[], $2::integer[]) AS policy(queue_name, rate_burst)`,
    [queueNames, policies.map((policy) => policy.shards)],
  );
}

/** The queues that the releases in `release` notify, read after the commit. */
async function notifiedQueues(release: (client: PoolClient) => Promise<void>): Promise<string[]> {
  const listener = await database.pool.connect();
  const releaser = await database.pool.connect();
  const sentinel = `sentinel-${randomUUID()}`;
  const notified: string[] = [];
  const reached = new Promise<void>((resolve) => {
    listener.on("notification", (message) => {
      if (message.payload === sentinel) resolve();
      else notified.push(message.payload ?? "");
    });
  });
  try {
    await listener.query("LISTEN workhorse_tasks");
    await releaser.query("BEGIN");
    await release(releaser);
    await releaser.query("COMMIT");
    // PostgreSQL delivers notifications in commit order, so the sentinel of a later transaction
    // arrives after each notification of the release.
    await releaser.query("SELECT pg_notify('workhorse_tasks', $1)", [sentinel]);
    await reached;
    return notified;
  } finally {
    await releaser.query("ROLLBACK").catch(() => undefined);
    await listener.query("UNLISTEN workhorse_tasks");
    listener.release();
    releaser.release();
  }
}

/** The shard of a stored value by the rule of ADR 0082, with the truncated modulo of PostgreSQL. */
function shardOf(stored: number | null, shards: number): number {
  return (stored ?? 0) % shards;
}

/** admission_share_v1 for a shard number, which is negative for a negative stored value. */
function shareOf(total: number, shards: number, shard: number): number {
  return Math.trunc(total / shards) + (shard < total % shards ? 1 : 0);
}

// Stored values that a claim writes (0 to 7), values from a larger shard count, null, and values
// that only a direct write can store.
const storedValues: ReadonlyArray<number | null> = [
  null,
  -32_768,
  ...Array.from({ length: 42 }, (_, index) => index - 17),
  32_767,
];

type EquivalenceCase = { queueName: string; shards: number; released: Lease; partner: Lease };

function equivalenceCases(prefix: string): EquivalenceCase[] {
  const cases: EquivalenceCase[] = [];
  for (let shards = 1; shards <= 8; shards += 1) {
    storedValues.forEach((stored, index) => {
      const next = storedValues[(index + 1) % storedValues.length]!;
      const base = stored ?? 0;
      const sameShard = base + shards <= 32_767 ? base + shards : base - shards;
      for (const [label, partner] of [
        ["next", next],
        ["same", sameShard],
      ] as const) {
        const queueName = `${prefix}-${String(shards)}-${String(index)}-${label}`;
        cases.push({
          queueName,
          shards,
          released: { taskId: randomUUID(), queueName, admissionShard: stored },
          partner: { taskId: randomUUID(), queueName, admissionShard: partner },
        });
      }
    });
  }
  return cases;
}

/** The decision of the trigger before SM-1991: the modulo filter, the share, and the queue limit. */
function notifiesByModulo(entry: EquivalenceCase): boolean {
  const maxActive = 2 * entry.shards;
  const shard = shardOf(entry.released.admissionShard, entry.shards);
  const inShard = [entry.released, entry.partner].filter(
    (lease) => shardOf(lease.admissionShard, entry.shards) === shard,
  ).length;
  return inShard >= shareOf(maxActive, entry.shards, shard) || 2 >= maxActive;
}

/** The queues that the trigger notified and the queues that the modulo rule names, sorted. */
async function moduloDecisions(
  prefix: string,
): Promise<{ notified: string[]; expected: string[]; bothSides: boolean }> {
  const cases = equivalenceCases(prefix);
  await setPolicies(
    cases.map((entry) => ({
      queueName: entry.queueName,
      maxActive: 2 * entry.shards,
      shards: entry.shards,
    })),
  );
  await insertLeases(cases.flatMap((entry) => [entry.released, entry.partner]));
  await database.pool.query("ANALYZE workhorse.task_runtime");

  const notified = await notifiedQueues(async (client) => {
    await client.query("DELETE FROM workhorse.task WHERE id = ANY($1::uuid[])", [
      cases.map((entry) => entry.released.taskId),
    ]);
  });

  const expected = cases.filter(notifiesByModulo).map((entry) => entry.queueName);
  // Each shard count from 2 has cases on both sides of the decision.
  const bothSides = [2, 3, 4, 5, 6, 7, 8].every((shards) => {
    const ofCount = cases.filter((entry) => entry.shards === shards);
    return ofCount.some(notifiesByModulo) && !ofCount.every(notifiesByModulo);
  });
  return {
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
    notified: [...notified].sort(),
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
    expected: [...expected].sort(),
    bothSides,
  };
}

type ReadCost = { shardIndexTuples: number; shardIndexScans: number; runtimeSeqScans: number };

const readCost = `SELECT pg_stat_get_xact_tuples_returned('${shardIndex}'::regclass)::integer
                           AS "shardIndexTuples",
                         pg_stat_get_xact_numscans('${shardIndex}'::regclass)::integer
                           AS "shardIndexScans",
                         pg_stat_get_xact_numscans('workhorse.task_runtime'::regclass)::integer
                           AS "runtimeSeqScans"`;

/** What one release of `taskId` reads, in a transaction that it rolls back. */
async function releaseCost(
  client: PoolClient,
  taskId: string,
  planCacheMode: "force_custom_plan" | "force_generic_plan",
): Promise<ReadCost> {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL plan_cache_mode = ${planCacheMode}`);
    const before = (await client.query<ReadCost>(readCost)).rows[0]!;
    await client.query("DELETE FROM workhorse.task WHERE id = $1", [taskId]);
    const after = (await client.query<ReadCost>(readCost)).rows[0]!;
    return {
      shardIndexTuples: after.shardIndexTuples - before.shardIndexTuples,
      shardIndexScans: after.shardIndexScans - before.shardIndexScans,
      runtimeSeqScans: after.runtimeSeqScans - before.runtimeSeqScans,
    };
  } finally {
    await client.query("ROLLBACK");
  }
}

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Shared Hit Blocks": number;
  "Shared Read Blocks": number;
  Plans?: PlanNode[];
};

function nodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodes)];
}

/** The shard count of the installed trigger, with its variables as statement parameters. */
async function installedShardCount(): Promise<string> {
  const source = await database.pool.query<{ source: string }>(
    `SELECT prosrc AS source FROM pg_proc
      WHERE oid = 'workhorse.notify_concurrency_capacity_v1()'::regprocedure`,
  );
  const match =
    /SELECT count\(\*\) FROM \(\s*(SELECT 1 FROM workhorse\.task_runtime active[\s\S]*?LIMIT v_share)\s*\) capped/.exec(
      source.rows[0]!.source,
    );
  if (match === null) throw new Error("found no shard count in notify_concurrency_capacity_v1");
  return match[1]!
    .replaceAll("OLD.queue_name", "$1")
    .replaceAll("v_members", "($2::smallint[])")
    .replaceAll("v_shards", "$4::integer")
    .replaceAll("v_shard", "$3::integer")
    .replaceAll("v_share", "$5::integer");
}

describe("capacity release shard count", () => {
  beforeAll(async () => database.setup());
  beforeEach(async () => database.reset());
  afterAll(async () => database.teardown());

  it("notifies for each stored shard value as the modulo rule decides, for 1 to 8 shards", async () => {
    const decisions = await moduloDecisions("shard-equal");

    expect(decisions.bothSides).toBe(true);
    expect(decisions.notified).toEqual(decisions.expected);
  });

  it("gives the same decisions when the shard index does not exist", async () => {
    // A database where the index build of migration 0102 failed or did not run yet.
    await database.pool.query(`DROP INDEX ${shardIndex}`);
    try {
      const decisions = await moduloDecisions("shard-no-index");

      expect(decisions.bothSides).toBe(true);
      expect(decisions.notified).toEqual(decisions.expected);
    } finally {
      await database.pool.query(
        `CREATE INDEX IF NOT EXISTS task_runtime_active_queue_shard_idx
           ON workhorse.task_runtime (queue_name, admission_shard) WHERE state = 'active'`,
      );
    }
  });

  it.each([100, 400])(
    "reads only the share of one full shard of %i leases, with a custom or a generic plan",
    async (share) => {
      // Seven shards of `share` leases each, and shard 3 holds twice its share. A count that read
      // the whole queue would read nine times the share.
      // Another queue holds 3,000 leases, as a table with many queues does, and shard 3 is written
      // last, so a scan of the table in physical order reads each other lease before shard 3.
      const queueName = `shard-cost-${String(share)}`;
      await setPolicies([{ queueName, maxActive: 8 * share, shards: 8 }]);
      await insertLeases(
        Array.from({ length: 3_000 }, (_, index): Lease => ({
          taskId: randomUUID(),
          queueName: "shard-cost-other",
          admissionShard: index % 8,
        })),
      );
      const others = Array.from({ length: 7 * share }, (_, index): Lease => ({
        taskId: randomUUID(),
        queueName,
        admissionShard: [0, 1, 2, 4, 5, 6, 7][index % 7]!,
      }));
      const leases = Array.from({ length: 2 * share }, (): Lease => ({
        taskId: randomUUID(),
        queueName,
        admissionShard: 3,
      }));
      await insertLeases(others);
      await insertLeases(leases);
      await database.pool.query("VACUUM (ANALYZE) workhorse.task_runtime");

      const client = await database.pool.connect();
      try {
        for (const mode of ["force_custom_plan", "force_generic_plan"] as const) {
          // PL/pgSQL keeps a plan for each statement, and the mode applies at each execution.
          for (let release = 0; release < 6; release += 1) {
            const cost = await releaseCost(client, leases[release]!.taskId, mode);
            // An index scan stops at the share. PostgreSQL can also choose a bitmap scan for a
            // small table, which reads each entry of the shard. Neither reads another shard.
            expect({ mode, runtimeSeqScans: cost.runtimeSeqScans }).toEqual({
              mode,
              runtimeSeqScans: 0,
            });
            expect(cost.shardIndexScans).toBeGreaterThanOrEqual(1);
            expect(cost.shardIndexTuples).toBeGreaterThanOrEqual(share);
            expect(cost.shardIndexTuples).toBeLessThanOrEqual(2 * share);
          }
        }
      } finally {
        client.release();
      }
    },
  );

  it("notifies and counts nothing while an open claim holds the shard lock", async () => {
    // An open claim holds its shard lock until it commits, and its leases are not visible yet.
    const queueName = "shard-busy";
    await setPolicies([{ queueName, maxActive: 800, shards: 8 }]);
    const leases = Array.from({ length: 16 }, (_, index): Lease => ({
      taskId: randomUUID(),
      queueName,
      admissionShard: index % 8,
    }));
    await insertLeases(leases);
    const holder = await database.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `workhorse:admission-shard:${queueName}:3`,
      ]);
      let cost: ReadCost | undefined;
      const notified = await notifiedQueues(async (client) => {
        const before = (await client.query<ReadCost>(readCost)).rows[0]!;
        await client.query("DELETE FROM workhorse.task WHERE id = $1", [leases[3]!.taskId]);
        const after = (await client.query<ReadCost>(readCost)).rows[0]!;
        cost = {
          shardIndexTuples: after.shardIndexTuples - before.shardIndexTuples,
          shardIndexScans: after.shardIndexScans - before.shardIndexScans,
          runtimeSeqScans: after.runtimeSeqScans - before.runtimeSeqScans,
        };
      });

      // Two of the 800 starts are active, so only the busy lock makes this release notify.
      expect(notified).toEqual([queueName]);
      expect(cost).toEqual({ shardIndexTuples: 0, shardIndexScans: 0, runtimeSeqScans: 0 });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  it("reads each part of the shard count through the index, and the outer parts with one probe", async () => {
    // Shard 3 is below its share, so each part runs. A database that only Workhorse writes stores
    // no value below 0 or above 7. The queue has 4,000 leases, so its index entries fill many more
    // leaf pages than one probe reads.
    const queueName = "shard-parts";
    await insertLeases(
      Array.from({ length: 2_000 }, (_, index): Lease => ({
        taskId: randomUUID(),
        queueName: "shard-parts-other",
        admissionShard: index % 8,
      })),
    );
    const leases = Array.from({ length: 4_000 }, (_, index): Lease => ({
      taskId: randomUUID(),
      queueName,
      admissionShard: index % 8,
    }));
    await insertLeases(leases);
    await database.pool.query("VACUUM (ANALYZE) workhorse.task_runtime");
    const statement = await installedShardCount();

    const client = await database.pool.connect();
    try {
      await client.query(`PREPARE shard_count(text, smallint[], integer, integer, integer) AS
        ${statement}`);
      for (const mode of ["force_custom_plan", "force_generic_plan"] as const) {
        await client.query(`SET plan_cache_mode = ${mode}`);
        for (const [shard, members] of [
          [0, [0]],
          [3, [3]],
        ] as const) {
          const explained = await client.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
            // EXPLAIN takes no bind parameters, so the values are literals.
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
               EXECUTE shard_count('${queueName}', '{${members.join(",")}}', ${String(shard)}, 8, 5000)`,
          );
          // A generic plan keeps the part for one shard behind a filter on $4, and never runs it
          // for eight shards. Only the nodes that ran count.
          const plan = nodes(explained.rows[0]!["QUERY PLAN"][0]!.Plan).filter(
            (node) => node["Actual Loops"] > 0,
          );
          // Each part reads through the shard index: an index scan, an index-only scan, or a
          // bitmap scan over it. None reads the table in physical order.
          expect(plan.filter((node) => node["Node Type"] === "Seq Scan")).toEqual([]);
          const indexReads = plan.filter((node) => node["Index Name"] !== undefined);
          expect(new Set(indexReads.map((node) => node["Index Name"]))).toEqual(
            new Set(["task_runtime_active_queue_shard_idx"]),
          );
          // The parts together find the 500 leases of the shard and nothing else.
          const found = indexReads.reduce(
            (sum, node) => sum + node["Actual Rows"] * node["Actual Loops"],
            0,
          );
          expect({ mode, shard, found }).toEqual({ mode, shard, found: 500 });
          // The two outer parts each descend the index once and find nothing.
          const outer = indexReads.filter((node) =>
            /admission_shard [<>] [07]\)/.test(node["Index Cond"] ?? ""),
          );
          expect(outer.map((node) => node["Actual Rows"])).toEqual([0, 0]);
          for (const probe of outer) {
            expect(probe["Shared Hit Blocks"] + probe["Shared Read Blocks"]).toBeLessThanOrEqual(6);
          }
        }
      }
    } finally {
      await client.query("DEALLOCATE ALL");
      await client.query("RESET plan_cache_mode");
      client.release();
    }
  });
});
