import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import type { Pool, PoolClient } from "pg";
import { installSchema } from "../src/schema.js";
import {
  summarizeLatencies,
  summarizeNumbers,
  type LatencySummary,
  type NumericSummary,
} from "./statistics.js";

/**
 * Measures what a delayed backlog costs `fast_claim_v1`. A delayed fast-tier task waits in `ready`
 * with a future `run_at`, and the ready index orders by priority before `run_at`. A claim therefore
 * passes over every delayed row whose priority is above the highest-priority due row, and over the
 * whole backlog when nothing is due.
 *
 * Four fast-tier queues share one table, so every series reads the same index. Two of them hold
 * the same rows in swapped priority bands: `above` puts the delayed backlog above the due work,
 * and its control `below` puts it underneath. `delayed-only` holds only the backlog, and its
 * control `empty` holds nothing. The series alternate claim by claim, and each round records the
 * host load average, because the host runs other work that a single run cannot separate out.
 */

export interface FastClaimBacklogOptions {
  /** Delayed rows per queue, one measured load for each value. */
  backlogs?: number[];
  /** Due rows in each of the `above` and `below` queues. */
  dueRows?: number;
  /** The `p_limit` every claim passes. */
  limit?: number;
  /** Alternating rounds per backlog size. */
  rounds?: number;
  /** Measured claims per series per round. */
  samplesPerRound?: number;
  /** Unmeasured claims per series before the first round of each backlog size. */
  warmupSamples?: number;
  /** Install the schema into a fresh `workhorse` schema before loading. */
  install?: boolean;
}

interface ResolvedOptions {
  backlogs: number[];
  dueRows: number;
  limit: number;
  rounds: number;
  samplesPerRound: number;
  warmupSamples: number;
  install: boolean;
}

const defaults: ResolvedOptions = {
  backlogs: [1_000, 10_000, 100_000],
  dueRows: 200,
  limit: 1,
  rounds: 5,
  samplesPerRound: 40,
  warmupSamples: 5,
  install: true,
};

const fastClaimBacklogSeries = ["above", "below", "delayed-only", "empty"] as const;
type Series = (typeof fastClaimBacklogSeries)[number];

const queuePrefix = "fast-claim-backlog-";

interface RoundResult {
  round: number;
  /** `os.loadavg()` one-minute value when the round started and when it ended. */
  loadAverage1m: { start: number; end: number };
  meanMs: Record<Series, number>;
  /** Mean claim time of each treatment divided by that of its control in the same round. */
  ratio: { aboveOverBelow: number; delayedOnlyOverEmpty: number };
}

interface CandidatePlan {
  /** Index entries the candidate scan returned before its limit was met. */
  indexRowsReturned: number;
  /** Rows the scan read and then discarded because they were not yet due. */
  rowsRemovedByFilter: number;
  sharedBuffersHit: number;
  sharedBuffersRead: number;
  /** PostgreSQL 18 reports how many index descents the scan made; a skip scan makes more than one. */
  indexSearches: number | null;
  executionMs: number;
}

interface BacklogResult {
  backlog: number;
  loadMs: number;
  claimedPerSeries: Record<Series, number>;
  latency: Record<Series, NumericSummary & LatencySummary>;
  rounds: RoundResult[];
  ratio: { aboveOverBelow: NumericSummary; delayedOnlyOverEmpty: NumericSummary };
  plans: Record<Exclude<Series, "empty">, CandidatePlan>;
}

export interface FastClaimBacklogReport {
  schemaVersion: number;
  serverVersion: string;
  options: ResolvedOptions;
  results: BacklogResult[];
}

function resolveOptions(options: FastClaimBacklogOptions = {}): ResolvedOptions {
  const resolved: ResolvedOptions = {
    ...defaults,
    ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
  };
  for (const name of ["dueRows", "limit", "rounds", "samplesPerRound"] as const) {
    const value = resolved[name];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  if (resolved.limit > 100) throw new RangeError("limit must be at most 100");
  if (!Number.isSafeInteger(resolved.warmupSamples) || resolved.warmupSamples < 0) {
    throw new RangeError("warmupSamples must be an integer of at least 0");
  }
  if (
    resolved.backlogs.length === 0 ||
    resolved.backlogs.some((value) => !Number.isSafeInteger(value) || value < 1)
  ) {
    throw new RangeError("backlogs must list positive safe integers");
  }
  // Each claim rolls back, so the due rows are never used up. A claim still needs a full batch of
  // them to measure the same work each time.
  if (resolved.dueRows < resolved.limit) throw new RangeError("dueRows must be at least limit");
  return resolved;
}

export async function runFastClaimBacklogBenchmark(
  pool: Pool,
  options: FastClaimBacklogOptions = {},
): Promise<FastClaimBacklogReport> {
  const resolved = resolveOptions(options);
  if (resolved.install) {
    await pool.query("DROP SCHEMA IF EXISTS workhorse CASCADE");
    await installSchema(pool);
  }
  for (const series of fastClaimBacklogSeries) {
    const queue = queuePrefix + series;
    await pool.query("DELETE FROM workhorse.task WHERE queue_name = $1", [queue]);
    await pool.query(
      `SELECT workhorse.set_queue_tier_v1($1, 'fast', 'fast-claim-backlog', 'benchmark')`,
      [queue],
    );
  }
  const results: BacklogResult[] = [];
  for (const backlog of resolved.backlogs) {
    const loadMs = await loadQueues(pool, resolved, backlog);
    results.push(await measureBacklog(pool, resolved, backlog, loadMs));
  }
  const schemaVersion = Number(
    (
      await pool.query<{ version: string }>(
        "SELECT max(version) AS version FROM workhorse.schema_version",
      )
    ).rows[0]!.version,
  );
  const serverVersion = (await pool.query<{ server_version: string }>("SHOW server_version"))
    .rows[0]!.server_version;
  return { schemaVersion, serverVersion, options: resolved, results };
}

/**
 * Loads each queue from nothing. `above` gets its backlog in priorities 51 to 100 and its due work
 * in 0 to 50. `below` swaps the bands, so its claim meets due work first. `delayed-only` spreads
 * its backlog over every priority. Due rows became runnable a minute ago; delayed rows run in a day.
 */
async function loadQueues(pool: Pool, options: ResolvedOptions, backlog: number): Promise<number> {
  for (const series of fastClaimBacklogSeries) {
    await pool.query("DELETE FROM workhorse.task WHERE queue_name = $1", [queuePrefix + series]);
  }
  await pool.query("VACUUM workhorse.task, workhorse.fast_task_runtime");
  const started = performance.now();
  const bands: { series: Series; rows: number; low: number; high: number; delayed: boolean }[] = [
    { series: "above", rows: backlog, low: 51, high: 100, delayed: true },
    { series: "above", rows: options.dueRows, low: 0, high: 50, delayed: false },
    { series: "below", rows: backlog, low: 0, high: 49, delayed: true },
    { series: "below", rows: options.dueRows, low: 50, high: 100, delayed: false },
    { series: "delayed-only", rows: backlog, low: 0, high: 100, delayed: true },
  ];
  for (const band of bands) {
    await pool.query(
      `WITH source AS (
         SELECT gen_random_uuid() AS id, $3::integer + (row % ($4::integer - $3::integer + 1)) AS priority,
                CASE WHEN $5 THEN now() + interval '1 day' ELSE now() - interval '1 minute' END
                  + row * interval '1 millisecond' AS run_at
           FROM generate_series(1, $2::integer) row
       ), identity AS (
         INSERT INTO workhorse.task(id, queue_name, task_type, payload, max_attempts, priority)
         SELECT id, $1, 'backlog.work', '{}'::jsonb, 3, priority FROM source
         RETURNING id
       )
       INSERT INTO workhorse.fast_task_runtime(
         task_id, queue_name, task_type, state, priority, run_at, sequence, payload,
         result_max_bytes, redact, max_attempts, enqueued_at
       )
       SELECT source.id, $1, 'backlog.work', 'ready', source.priority, source.run_at,
              nextval('workhorse.ready_sequence_seq'), '{}'::jsonb, 1048576, false, 3, now()
         FROM source JOIN identity ON identity.id = source.id`,
      [queuePrefix + band.series, band.rows, band.low, band.high, band.delayed],
    );
  }
  await pool.query("VACUUM ANALYZE workhorse.task, workhorse.fast_task_runtime");
  return performance.now() - started;
}

async function measureBacklog(
  pool: Pool,
  options: ResolvedOptions,
  backlog: number,
  loadMs: number,
): Promise<BacklogResult> {
  const client = await pool.connect();
  const samples = Object.fromEntries(
    fastClaimBacklogSeries.map((series) => [series, [] as number[]]),
  ) as Record<Series, number[]>;
  const claimed = Object.fromEntries(fastClaimBacklogSeries.map((series) => [series, 0])) as Record<
    Series,
    number
  >;
  const rounds: RoundResult[] = [];
  try {
    for (let sample = 0; sample < options.warmupSamples; sample += 1) {
      for (const series of fastClaimBacklogSeries) await claim(client, options, series);
    }
    for (let round = 1; round <= options.rounds; round += 1) {
      const start = loadavg()[0]!;
      const roundSamples = Object.fromEntries(
        fastClaimBacklogSeries.map((series) => [series, [] as number[]]),
      ) as Record<Series, number[]>;
      for (let sample = 0; sample < options.samplesPerRound; sample += 1) {
        // Reverse the order every other sample, so no series always runs right after another.
        const order =
          sample % 2 === 0 ? fastClaimBacklogSeries : fastClaimBacklogSeries.toReversed();
        for (const series of order) {
          const measured = await claim(client, options, series);
          roundSamples[series].push(measured.elapsedMs);
          claimed[series] += measured.claimed;
        }
      }
      const meanMs = Object.fromEntries(
        fastClaimBacklogSeries.map((series) => [series, mean(roundSamples[series])]),
      ) as Record<Series, number>;
      for (const series of fastClaimBacklogSeries) samples[series].push(...roundSamples[series]);
      rounds.push({
        round,
        loadAverage1m: { start, end: loadavg()[0]! },
        meanMs,
        ratio: {
          aboveOverBelow: meanMs.above / meanMs.below,
          delayedOnlyOverEmpty: meanMs["delayed-only"] / meanMs.empty,
        },
      });
    }
    const plans = {
      above: await explainCandidates(client, options, "above"),
      below: await explainCandidates(client, options, "below"),
      "delayed-only": await explainCandidates(client, options, "delayed-only"),
    };
    const expected = options.rounds * options.samplesPerRound * options.limit;
    if (claimed.above !== expected || claimed.below !== expected) {
      throw new Error("a claim on a queue with due work did not fill its batch");
    }
    if (claimed["delayed-only"] !== 0 || claimed.empty !== 0) {
      throw new Error("a claim on a queue with no due work claimed a task");
    }
    return {
      backlog,
      loadMs,
      claimedPerSeries: claimed,
      latency: Object.fromEntries(
        fastClaimBacklogSeries.map((series) => [
          series,
          { ...summarizeNumbers(samples[series]), ...summarizeLatencies(samples[series]) },
        ]),
      ) as Record<Series, NumericSummary & LatencySummary>,
      rounds,
      ratio: {
        aboveOverBelow: summarizeNumbers(rounds.map((round) => round.ratio.aboveOverBelow)),
        delayedOnlyOverEmpty: summarizeNumbers(
          rounds.map((round) => round.ratio.delayedOnlyOverEmpty),
        ),
      },
      plans,
    };
  } finally {
    client.release();
  }
}

/** Claims through the public entry point, inside a transaction that rolls back. */
async function claim(
  client: PoolClient,
  options: ResolvedOptions,
  series: Series,
): Promise<{ elapsedMs: number; claimed: number }> {
  await client.query("BEGIN");
  try {
    const started = performance.now();
    const result = await client.query(
      "SELECT task_id FROM workhorse.claim_many_v1($1, 'fast-claim-backlog', $2, 30000)",
      [queuePrefix + series, options.limit],
    );
    return { elapsedMs: performance.now() - started, claimed: result.rowCount ?? 0 };
  } finally {
    await client.query("ROLLBACK");
  }
}

/**
 * Explains the candidate query `fast_claim_v1` runs, under the generic plan the function forces,
 * so the report shows how many index entries a claim reads to find its batch.
 */
async function explainCandidates(
  client: PoolClient,
  options: ResolvedOptions,
  series: Series,
): Promise<CandidatePlan> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL plan_cache_mode = force_generic_plan");
    await client.query(
      `PREPARE fast_claim_candidates(text, timestamptz, integer) AS
       SELECT candidate.task_id FROM workhorse.fast_task_runtime candidate
        WHERE candidate.state = 'ready' AND candidate.queue_name = $1
          AND candidate.run_at <= $2
          AND (candidate.deadline_at IS NULL OR candidate.deadline_at > $2)
        ORDER BY candidate.priority DESC, candidate.run_at, candidate.sequence
        LIMIT $3
        FOR UPDATE SKIP LOCKED`,
    );
    // A utility statement takes no bind parameters, so the arguments are inlined as literals.
    const explained = await client.query<{
      "QUERY PLAN": { Plan: PlanNode; "Execution Time": number }[];
    }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       EXECUTE fast_claim_candidates(${client.escapeLiteral(queuePrefix + series)}, clock_timestamp(), ${options.limit})`,
    );
    const explanation = explained.rows[0]!["QUERY PLAN"][0]!;
    const scan = findScan(explanation.Plan);
    if (!scan) throw new Error("the candidate plan has no scan of fast_task_runtime");
    return {
      indexRowsReturned: Number(scan["Actual Rows"] ?? 0),
      rowsRemovedByFilter: Number(scan["Rows Removed by Filter"] ?? 0),
      sharedBuffersHit: Number(explanation.Plan["Shared Hit Blocks"] ?? 0),
      sharedBuffersRead: Number(explanation.Plan["Shared Read Blocks"] ?? 0),
      indexSearches: scan["Index Searches"] === undefined ? null : Number(scan["Index Searches"]),
      executionMs: explanation["Execution Time"],
    };
  } finally {
    await client.query("ROLLBACK");
    await client.query("DEALLOCATE ALL");
  }
}

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };

function findScan(node: PlanNode): PlanNode | undefined {
  if (node["Relation Name"] === "fast_task_runtime") return node;
  for (const child of node.Plans ?? []) {
    const found = findScan(child);
    if (found) return found;
  }
  return undefined;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
