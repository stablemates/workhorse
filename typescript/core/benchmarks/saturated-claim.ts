import { performance } from "node:perf_hooks";
import type { Pool, PoolClient } from "pg";
import { installSchema } from "../src/schema.js";
import { summarizeNumbers, type NumericSummary } from "./statistics.js";

/**
 * Measures what one `claim_v1` call writes on a queue whose keys are all at capacity. Such a claim
 * admits nothing, and every completion on the queue wakes every worker, so it repeats once per
 * worker per completion. The benchmark answers what that repetition costs the database: how many
 * ready rows the claim leaves locked while its transaction is open, and how many bytes of WAL it
 * writes.
 */

export interface SaturatedClaimOptions {
  /** Distinct concurrency keys, each holding `maxActivePerKey` active leases. */
  keys?: number;
  /** Ready rows per key, all blocked while the key is at capacity. */
  readyPerKey?: number;
  /** Per-key concurrency limit the queue policy carries. */
  maxActivePerKey?: number;
  /** Measured claims per series. */
  samples?: number;
  /** Unmeasured claims before each measured series. */
  warmupSamples?: number;
  /** Install the schema into a fresh `workhorse` schema before loading. */
  install?: boolean;
}

interface ResolvedOptions {
  keys: number;
  readyPerKey: number;
  maxActivePerKey: number;
  samples: number;
  warmupSamples: number;
  install: boolean;
}

const defaults: ResolvedOptions = {
  keys: 40,
  readyPerKey: 4,
  maxActivePerKey: 1,
  samples: 25,
  warmupSamples: 2,
  install: true,
};

const queueName = "saturated-claim";
const namespace = "saturated-claim-benchmark";
/** `claim_v1` inspects at most this many ready rows when a per-key limit can pass over a key. */
const admissionWindow = 100;

interface SaturatedClaimSeries {
  /** Claims that returned a task. */
  admittedClaims: number;
  /** Ready rows another session could not lock while the claim transaction stayed open. */
  rowLocks: NumericSummary;
  /** WAL records the claim's backend wrote, one per row lock among them. */
  walRecords: NumericSummary;
  /** WAL bytes the claim's backend wrote. */
  walBytes: NumericSummary;
  elapsedMs: NumericSummary;
}

export interface SaturatedClaimReport {
  schemaVersion: number;
  options: ResolvedOptions;
  load: { readyRows: number; activeRows: number; loadMs: number };
  /** Every key is at capacity, so the claim admits nothing. */
  saturated: SaturatedClaimSeries;
  /** One key has capacity behind the saturated head, so the claim admits its first ready row. */
  admitting: SaturatedClaimSeries;
}

function resolveOptions(options: SaturatedClaimOptions = {}): ResolvedOptions {
  const resolved: ResolvedOptions = {
    ...defaults,
    ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
  };
  for (const name of ["keys", "readyPerKey", "maxActivePerKey", "samples"] as const) {
    const value = resolved[name];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  if (!Number.isSafeInteger(resolved.warmupSamples) || resolved.warmupSamples < 0) {
    throw new RangeError("warmupSamples must be an integer of at least 0");
  }
  if (resolved.keys * resolved.readyPerKey < admissionWindow) {
    throw new RangeError(
      `keys * readyPerKey must fill the ${admissionWindow}-row admission window`,
    );
  }
  return resolved;
}

export async function runSaturatedClaimBenchmark(
  pool: Pool,
  options: SaturatedClaimOptions = {},
): Promise<SaturatedClaimReport> {
  const resolved = resolveOptions(options);
  const load = await loadQueue(pool, resolved);
  const saturated = await measure(pool, resolved, "saturated");
  // Release the last key whose ready rows still fall inside the window, so the claim admits one of
  // them only after passing over the rows of every key still at capacity.
  await pool.query(
    `DELETE FROM workhorse.task_runtime
      WHERE queue_name = $1 AND state = 'active' AND concurrency_key = $2`,
    [queueName, keyName(Math.floor(admissionWindow / resolved.readyPerKey) - 1)],
  );
  const admitting = await measure(pool, resolved, "admitting");
  const schemaVersion = await count(pool, "SELECT max(version) FROM workhorse.schema_version");
  return { schemaVersion, options: resolved, load, saturated, admitting };
}

function keyName(index: number): string {
  return `key-${String(index).padStart(6, "0")}`;
}

async function loadQueue(
  pool: Pool,
  options: ResolvedOptions,
): Promise<SaturatedClaimReport["load"]> {
  if (options.install) {
    await pool.query("DROP SCHEMA IF EXISTS workhorse CASCADE");
    await installSchema(pool);
  } else {
    // Measuring an already-installed schema still needs the queue to start from nothing.
    await pool.query("DELETE FROM workhorse.task WHERE queue_name = $1", [queueName]);
  }
  await pool.query(`SELECT * FROM workhorse.sync_concurrency_policies_v1($1, $2::jsonb, true)`, [
    namespace,
    JSON.stringify([
      { queue: queueName, maxActive: 1_000_000, maxActivePerKey: options.maxActivePerKey },
    ]),
  ]);
  const started = performance.now();
  await pool.query(
    `WITH source AS (
       SELECT key, slot, md5('active:' || key || ':' || slot)::uuid AS id
         FROM generate_series(0, $1::integer - 1) key, generate_series(1, $2::integer) slot
     ), identity AS (
       INSERT INTO workhorse.task(id, queue_name, task_type, concurrency_key, payload, max_attempts)
       SELECT id, $3, 'saturated.work', 'key-' || lpad(key::text, 6, '0'),
              jsonb_build_object('key', key, 'slot', slot), 3
         FROM source
       RETURNING id, concurrency_key
     )
     INSERT INTO workhorse.task_runtime(
       task_id, queue_name, concurrency_key, state, current_attempt, fence_token, run_at,
       worker_id, acquired_at, heartbeat_at, expires_at, attempt_started_at
     )
     SELECT id, $3, concurrency_key, 'active', 1, nextval('workhorse.fence_token_seq'),
            clock_timestamp(), 'bench-holder', clock_timestamp(), clock_timestamp(),
            clock_timestamp() + interval '1 hour', clock_timestamp()
       FROM identity`,
    [options.keys, options.maxActivePerKey, queueName],
  );
  await pool.query(
    `WITH source AS (
       SELECT key, slot, md5('ready:' || key || ':' || slot)::uuid AS id,
              (key::bigint * $2::integer + slot) AS sequence
         FROM generate_series(0, $1::integer - 1) key, generate_series(1, $2::integer) slot
     ), identity AS (
       INSERT INTO workhorse.task(id, queue_name, task_type, concurrency_key, payload, max_attempts)
       SELECT id, $3, 'saturated.work', 'key-' || lpad(key::text, 6, '0'),
              jsonb_build_object('key', key, 'slot', slot), 3
         FROM source
       RETURNING id, concurrency_key
     )
     INSERT INTO workhorse.task_runtime(
       task_id, queue_name, concurrency_key, state, current_attempt, run_at, ready_at, sequence
     )
     SELECT identity.id, $3, identity.concurrency_key, 'ready', 1, clock_timestamp(),
            clock_timestamp(), source.sequence
       FROM identity JOIN source ON source.id = identity.id`,
    [options.keys, options.readyPerKey, queueName],
  );
  await pool.query(`SELECT setval('workhorse.ready_sequence_seq', $1::bigint + 1)`, [
    options.keys * options.readyPerKey,
  ]);
  await pool.query("ANALYZE workhorse.task, workhorse.task_runtime");
  const loadMs = performance.now() - started;
  return {
    readyRows: await count(
      pool,
      "SELECT count(*) FROM workhorse.task_runtime WHERE state = 'ready'",
    ),
    activeRows: await count(
      pool,
      "SELECT count(*) FROM workhorse.task_runtime WHERE state = 'active'",
    ),
    loadMs,
  };
}

/**
 * Runs each claim in its own open transaction, so a second session can count the ready rows the
 * claim holds before the transaction ends. `EXPLAIN (ANALYZE, WAL)` attributes WAL to the backend
 * that ran the claim, which the WAL insert position does not: that position advances for the whole
 * cluster. Every transaction rolls back, which leaves the queue in the state the series started
 * from.
 */
async function measure(
  pool: Pool,
  options: ResolvedOptions,
  series: "saturated" | "admitting",
): Promise<SaturatedClaimSeries> {
  const readyRows = await count(
    pool,
    `SELECT count(*) FROM workhorse.task_runtime WHERE queue_name = $1 AND state = 'ready'`,
    [queueName],
  );
  const client = await pool.connect();
  const rowLocks: number[] = [];
  const walRecords: number[] = [];
  const walBytes: number[] = [];
  const elapsedMs: number[] = [];
  let admittedClaims = 0;
  try {
    for (let sample = 0; sample < options.warmupSamples + options.samples; sample += 1) {
      const measured = sample >= options.warmupSamples;
      await client.query("BEGIN");
      try {
        const started = performance.now();
        const claimed = await client.query("SELECT task_id FROM workhorse.claim_v1($1, $2, $3)", [
          queueName,
          `bench-claimer-${sample}`,
          30_000,
        ]);
        const elapsed = performance.now() - started;
        const unlocked = await count(
          pool,
          `SELECT count(*) FROM (
             SELECT 1 FROM workhorse.task_runtime runtime
              WHERE runtime.queue_name = $1 AND runtime.state = 'ready'
              FOR UPDATE SKIP LOCKED
           ) lockable`,
          [queueName],
        );
        if (measured) {
          admittedClaims += claimed.rowCount ?? 0;
          rowLocks.push(readyRows - unlocked);
          elapsedMs.push(elapsed);
        }
      } finally {
        await client.query("ROLLBACK");
      }
      // A second claim under EXPLAIN attributes WAL to this backend. Node instrumentation inflates
      // its own timing, so the latency above comes from the plain call.
      await client.query("BEGIN");
      try {
        const explained = await explainClaim(client, `bench-explainer-${sample}`);
        if (measured) {
          walRecords.push(explained.walRecords);
          walBytes.push(explained.walBytes);
        }
      } finally {
        await client.query("ROLLBACK");
      }
    }
  } finally {
    client.release();
  }
  if (series === "saturated" && admittedClaims > 0) {
    throw new Error("the saturated series admitted a task, so no key was at capacity");
  }
  if (series === "admitting" && admittedClaims !== options.samples) {
    throw new Error("the admitting series did not admit a task on every claim");
  }
  return {
    admittedClaims,
    rowLocks: summarizeNumbers(rowLocks),
    walRecords: summarizeNumbers(walRecords),
    walBytes: summarizeNumbers(walBytes),
    elapsedMs: summarizeNumbers(elapsedMs),
  };
}

interface ClaimMeasurement {
  walRecords: number;
  walBytes: number;
}

async function explainClaim(client: PoolClient, workerId: string): Promise<ClaimMeasurement> {
  type Explanation = { Plan: Record<string, number> };
  const explained = await client.query<{ "QUERY PLAN": Explanation[] }>(
    `EXPLAIN (ANALYZE, WAL, TIMING, FORMAT JSON)
     SELECT task_id FROM workhorse.claim_v1($1, $2, $3)`,
    [queueName, workerId, 30_000],
  );
  const explanation = explained.rows[0]!["QUERY PLAN"][0]!;
  const plan = explanation.Plan;
  return {
    walRecords: Number(plan["WAL Records"] ?? 0),
    walBytes: Number(plan["WAL Bytes"] ?? 0),
  };
}

async function count(pool: Pool, sql: string, parameters: unknown[] = []): Promise<number> {
  const result = await pool.query<Record<string, string>>(sql, parameters);
  return Number(Object.values(result.rows[0] ?? {})[0] ?? 0);
}
