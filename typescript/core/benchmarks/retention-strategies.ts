import { cpus, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  captureRelationTelemetry,
  captureWalLsnDifference,
  captureWalLsnStart,
  vacuumAnalyzeRelation,
  type RelationTelemetry,
} from "./telemetry.js";
import {
  summarizeLatencies,
  summarizeNumbers,
  type LatencySummary,
  type NumericSummary,
} from "./statistics.js";

type RetentionStrategy = "partition-drop" | "row-delete-vacuum";

export interface RetentionStrategiesOptions {
  rowsPerCycle?: number[];
  cycles?: number;
  retainedCycles?: number;
  readyJobs?: number;
  claimSamples?: number;
  triggerRows?: number;
  triggerRepetitions?: number;
  payloadBytes?: number;
}

export interface ResolvedRetentionStrategiesOptions {
  rowsPerCycle: number[];
  cycles: number;
  retainedCycles: number;
  readyJobs: number;
  claimSamples: number;
  triggerRows: number;
  triggerRepetitions: number;
  payloadBytes: number;
}

interface HistoryStorageSnapshot {
  totalBytes: number;
  liveTuples: number;
  deadTuples: number;
  relationCount: number;
  vacuumCount: number;
  autovacuumCount: number;
  lastVacuum: Date | null;
  lastAutovacuum: Date | null;
}

interface RetentionCycleMeasurement {
  cycle: number;
  insertedRows: number;
  retiredRows: number;
  insertMs: number;
  retentionMs: number | null;
  vacuumMs: number | null;
  walBytes: number;
  retentionWalBytes: number | null;
  beforeVacuum: HistoryStorageSnapshot;
  afterVacuum: HistoryStorageSnapshot;
  claimBefore: LatencySummary;
  claimDuring: LatencySummary;
  claimAfter: LatencySummary;
}

interface TriggerCostMeasurement {
  rowsPerRepetition: number;
  repetitions: number;
  triggeredInsertMs: NumericSummary;
  plainInsertMs: NumericSummary;
  triggeredToPlainRatio: number | null;
}

interface RetentionStrategyMeasurement {
  strategy: RetentionStrategy;
  rowsPerCycle: number;
  triggerCost: TriggerCostMeasurement;
  cycles: RetentionCycleMeasurement[];
  retainedCycles: RetentionCycleMeasurement[];
  retentionMs: NumericSummary;
  retentionWalBytes: NumericSummary;
  vacuumMs: NumericSummary;
  claimDuringP95Ms: NumericSummary;
  finalStorage: HistoryStorageSnapshot;
}

interface RetentionScaleComparison {
  rowsPerCycle: number;
  partitionRetentionMs: number | null;
  rowRetentionAndVacuumMs: number | null;
  rowToPartitionRetentionRatio: number | null;
  /** Median because PostgreSQL WAL LSNs are cluster-wide and include unrelated database writes. */
  partitionRetentionWalBytesMedian: number | null;
  /** Median because PostgreSQL WAL LSNs are cluster-wide and include unrelated database writes. */
  rowRetentionWalBytesMedian: number | null;
  rowToPartitionWalRatio: number | null;
  partitionFinalBytes: number;
  rowFinalBytes: number;
  rowToPartitionStorageRatio: number | null;
  partitionClaimDuringP95Ms: number | null;
  rowClaimDuringP95Ms: number | null;
}

export interface RetentionStrategiesReport {
  generatedAt: string;
  environment: {
    node: string;
    platform: string;
    platformRelease: string;
    cpu: string;
    postgres: string;
  };
  options: ResolvedRetentionStrategiesOptions;
  executionOrder: Array<{ rowsPerCycle: number; strategies: RetentionStrategy[] }>;
  measurements: RetentionStrategyMeasurement[];
  comparisons: RetentionScaleComparison[];
}

const defaults: ResolvedRetentionStrategiesOptions = {
  rowsPerCycle: [10, 50, 100, 250, 500, 1_000, 10_000, 50_000],
  cycles: 7,
  retainedCycles: 2,
  readyJobs: 500,
  claimSamples: 40,
  triggerRows: 2_000,
  triggerRepetitions: 5,
  payloadBytes: 128,
};

const retainedHistoryTables = ["job_event", "attempt_history"] as const;
const triggerProbeTables = ["history_triggered", "history_plain"] as const;
type HistoryTable = (typeof retainedHistoryTables)[number] | (typeof triggerProbeTables)[number];

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

export function resolveRetentionStrategiesOptions(
  options: RetentionStrategiesOptions = {},
): ResolvedRetentionStrategiesOptions {
  const resolved: ResolvedRetentionStrategiesOptions = {
    rowsPerCycle: options.rowsPerCycle ?? defaults.rowsPerCycle,
    cycles: options.cycles ?? defaults.cycles,
    retainedCycles: options.retainedCycles ?? defaults.retainedCycles,
    readyJobs: options.readyJobs ?? defaults.readyJobs,
    claimSamples: options.claimSamples ?? defaults.claimSamples,
    triggerRows: options.triggerRows ?? defaults.triggerRows,
    triggerRepetitions: options.triggerRepetitions ?? defaults.triggerRepetitions,
    payloadBytes: options.payloadBytes ?? defaults.payloadBytes,
  };

  if (resolved.rowsPerCycle.length === 0) {
    throw new RangeError("rowsPerCycle must contain at least one scale");
  }
  for (const [index, value] of resolved.rowsPerCycle.entries()) {
    positiveInteger(`rowsPerCycle[${index}]`, value);
  }
  for (const key of [
    "cycles",
    "retainedCycles",
    "readyJobs",
    "claimSamples",
    "triggerRows",
    "triggerRepetitions",
    "payloadBytes",
  ] as const) {
    positiveInteger(key, resolved[key]);
  }
  if (resolved.cycles <= resolved.retainedCycles) {
    throw new RangeError("cycles must exceed retainedCycles so retention is measured");
  }
  return resolved;
}

function schemaName(strategy: RetentionStrategy): string {
  return strategy === "partition-drop" ? "retention_partition_bench" : "retention_row_bench";
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function setupSchema(pool: Pool, strategy: RetentionStrategy): Promise<string> {
  const schema = schemaName(strategy);
  const qualifiedSchema = quoteIdentifier(schema);
  await pool.query(`DROP SCHEMA IF EXISTS ${qualifiedSchema} CASCADE`);
  await pool.query(`CREATE SCHEMA ${qualifiedSchema}`);
  await pool.query(`
    CREATE TABLE ${qualifiedSchema}.job (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      state text NOT NULL DEFAULT 'ready',
      ready_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      priority integer NOT NULL DEFAULT 0
    );
    CREATE INDEX job_ready_idx ON ${qualifiedSchema}.job (priority DESC, ready_at, id)
      WHERE state = 'ready';
    CREATE TABLE ${qualifiedSchema}.history_job (
      id bigint PRIMARY KEY,
      history_through_at timestamptz
    );
    CREATE OR REPLACE FUNCTION ${qualifiedSchema}.lock_history_job()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM 1 FROM ${qualifiedSchema}.history_job WHERE id = NEW.job_id FOR KEY SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'history references missing benchmark job %', NEW.job_id;
      END IF;
      UPDATE ${qualifiedSchema}.history_job
         SET history_through_at = GREATEST(history_through_at, NEW.occurred_at)
       WHERE id = NEW.job_id
         AND history_through_at < NEW.occurred_at;
      RETURN NEW;
    END;
    $$;
  `);

  const historyDefinition = `(
    id bigint GENERATED ALWAYS AS IDENTITY,
    job_id bigint NOT NULL,
    generation integer NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    payload text NOT NULL
  )`;
  if (strategy === "partition-drop") {
    await pool.query(`
      CREATE TABLE ${qualifiedSchema}.job_event ${historyDefinition} PARTITION BY RANGE (generation);
      CREATE TABLE ${qualifiedSchema}.attempt_history ${historyDefinition} PARTITION BY RANGE (generation);
      CREATE TABLE ${qualifiedSchema}.history_triggered ${historyDefinition}
        PARTITION BY RANGE (generation);
      CREATE TABLE ${qualifiedSchema}.history_plain ${historyDefinition}
        PARTITION BY RANGE (generation);
    `);
  } else {
    await pool.query(`
      CREATE TABLE ${qualifiedSchema}.job_event ${historyDefinition};
      CREATE INDEX job_event_generation_idx ON ${qualifiedSchema}.job_event (generation);
      CREATE TABLE ${qualifiedSchema}.attempt_history ${historyDefinition};
      CREATE INDEX attempt_history_generation_idx ON ${qualifiedSchema}.attempt_history (generation);
      CREATE TABLE ${qualifiedSchema}.history_triggered ${historyDefinition};
      CREATE INDEX history_triggered_generation_idx
        ON ${qualifiedSchema}.history_triggered (generation);
      CREATE TABLE ${qualifiedSchema}.history_plain ${historyDefinition};
      CREATE INDEX history_plain_generation_idx ON ${qualifiedSchema}.history_plain (generation);
    `);
  }
  await pool.query(`
    CREATE TRIGGER job_event_job_exists
      BEFORE INSERT ON ${qualifiedSchema}.job_event
      FOR EACH ROW EXECUTE FUNCTION ${qualifiedSchema}.lock_history_job();
    CREATE TRIGGER attempt_history_job_exists
      BEFORE INSERT ON ${qualifiedSchema}.attempt_history
      FOR EACH ROW EXECUTE FUNCTION ${qualifiedSchema}.lock_history_job();
    CREATE TRIGGER history_triggered_job_exists
      BEFORE INSERT ON ${qualifiedSchema}.history_triggered
      FOR EACH ROW EXECUTE FUNCTION ${qualifiedSchema}.lock_history_job();
  `);
  return schema;
}

async function createGeneration(
  pool: Pool,
  schema: string,
  strategy: RetentionStrategy,
  generation: number,
  includePlain = false,
): Promise<void> {
  if (strategy !== "partition-drop") return;
  const qualifiedSchema = quoteIdentifier(schema);
  const tables: readonly HistoryTable[] = includePlain ? triggerProbeTables : retainedHistoryTables;
  for (const table of tables) {
    const partition = quoteIdentifier(`${table}_g${generation}`);
    await pool.query(
      `CREATE TABLE ${qualifiedSchema}.${partition}
         PARTITION OF ${qualifiedSchema}.${quoteIdentifier(table)}
         FOR VALUES FROM (${generation}) TO (${generation + 1})`,
    );
  }
}

async function seedReadyJobs(pool: Pool, schema: string, count: number): Promise<void> {
  const qualifiedSchema = quoteIdentifier(schema);
  await pool.query(
    `INSERT INTO ${qualifiedSchema}.job(priority)
     SELECT series % 4 FROM generate_series(1, $1) AS series`,
    [count],
  );
}

async function seedHistoryJobs(pool: Pool, schema: string, count: number): Promise<void> {
  await pool.query(
    `INSERT INTO ${quoteIdentifier(schema)}.history_job(id)
     SELECT series FROM generate_series(1, $1) AS series`,
    [count],
  );
}

async function insertHistory(
  pool: Pool,
  schema: string,
  table: HistoryTable,
  generation: number,
  rows: number,
  payloadBytes: number,
): Promise<number> {
  const started = performance.now();
  await pool.query(
    `INSERT INTO ${quoteIdentifier(schema)}.${quoteIdentifier(table)}
       (job_id, generation, occurred_at, payload)
     SELECT series, $1, clock_timestamp(), repeat('x', $3)
       FROM generate_series(1, $2) AS series`,
    [generation, rows, payloadBytes],
  );
  return performance.now() - started;
}

async function measureTriggerCost(
  pool: Pool,
  schema: string,
  strategy: RetentionStrategy,
  options: ResolvedRetentionStrategiesOptions,
): Promise<TriggerCostMeasurement> {
  await seedHistoryJobs(pool, schema, Math.max(options.triggerRows, ...options.rowsPerCycle));
  const triggeredSamples: number[] = [];
  const plainSamples: number[] = [];
  for (let repetition = 0; repetition < options.triggerRepetitions; repetition += 1) {
    const generation = -(repetition + 1);
    await createGeneration(pool, schema, strategy, generation, true);
    const order =
      repetition % 2 === 0
        ? (["history_triggered", "history_plain"] as const)
        : (["history_plain", "history_triggered"] as const);
    for (const table of order) {
      const duration = await insertHistory(
        pool,
        schema,
        table,
        generation,
        options.triggerRows,
        options.payloadBytes,
      );
      (table === "history_triggered" ? triggeredSamples : plainSamples).push(duration);
    }
  }
  const triggeredInsertMs = summarizeNumbers(triggeredSamples);
  const plainInsertMs = summarizeNumbers(plainSamples);
  const triggeredToPlainRatio =
    triggeredInsertMs.mean === null || plainInsertMs.mean === null || plainInsertMs.mean === 0
      ? null
      : triggeredInsertMs.mean / plainInsertMs.mean;
  await pool.query(
    `TRUNCATE ${quoteIdentifier(schema)}.history_triggered, ${quoteIdentifier(schema)}.history_plain`,
  );
  return {
    rowsPerRepetition: options.triggerRows,
    repetitions: options.triggerRepetitions,
    triggeredInsertMs,
    plainInsertMs,
    triggeredToPlainRatio,
  };
}

async function claimOnce(pool: Pool, schema: string): Promise<number> {
  const client = await pool.connect();
  const started = performance.now();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ id: string }>(`
      SELECT id FROM ${quoteIdentifier(schema)}.job
       WHERE state = 'ready' AND ready_at <= clock_timestamp()
       ORDER BY priority DESC, ready_at, id
       LIMIT 1 FOR UPDATE SKIP LOCKED
    `);
    if (result.rows[0]?.id === undefined) {
      throw new Error(`${schema} claim probe found no ready job`);
    }
    await client.query("ROLLBACK");
    return performance.now() - started;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function claimSamples(pool: Pool, schema: string, count: number): Promise<number[]> {
  const samples: number[] = [];
  for (let sample = 0; sample < count; sample += 1) {
    samples.push(await claimOnce(pool, schema));
  }
  return samples;
}

/** Launch one cohort with cleanup so pool wait and lock delay remain part of each observation. */
async function concurrentClaimSamples(
  pool: Pool,
  schema: string,
  count: number,
): Promise<number[]> {
  return Promise.all(Array.from({ length: count }, () => claimOnce(pool, schema)));
}

function latestDate(left: Date | null, right: Date | null): Date | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

function historyStorage(relations: RelationTelemetry[]): HistoryStorageSnapshot {
  const historyRelations = relations.filter((relation) =>
    retainedHistoryTables.some(
      (table) => relation.relation === table || relation.relation.startsWith(`${table}_g`),
    ),
  );
  return historyRelations.reduce<HistoryStorageSnapshot>(
    (total, relation) => ({
      totalBytes: total.totalBytes + relation.totalBytes,
      liveTuples: total.liveTuples + relation.liveTuples,
      deadTuples: total.deadTuples + relation.deadTuples,
      relationCount: total.relationCount + 1,
      vacuumCount: total.vacuumCount + relation.vacuumCount,
      autovacuumCount: total.autovacuumCount + relation.autovacuumCount,
      lastVacuum: latestDate(total.lastVacuum, relation.lastVacuum),
      lastAutovacuum: latestDate(total.lastAutovacuum, relation.lastAutovacuum),
    }),
    {
      totalBytes: 0,
      liveTuples: 0,
      deadTuples: 0,
      relationCount: 0,
      vacuumCount: 0,
      autovacuumCount: 0,
      lastVacuum: null,
      lastAutovacuum: null,
    },
  );
}

async function storageSnapshot(pool: Pool, schema: string): Promise<HistoryStorageSnapshot> {
  return historyStorage(await captureRelationTelemetry(pool, schema));
}

async function countGeneration(pool: Pool, schema: string, generation: number): Promise<number> {
  const counts = await Promise.all(
    retainedHistoryTables.map(async (table) => {
      const result = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}
          WHERE generation = $1`,
        [generation],
      );
      return Number(result.rows[0]?.count ?? 0);
    }),
  );
  return counts.reduce((total, count) => total + count, 0);
}

async function retainGeneration(
  client: PoolClient,
  schema: string,
  strategy: RetentionStrategy,
  generation: number,
): Promise<number> {
  const started = performance.now();
  if (strategy === "partition-drop") {
    await client.query(
      `DROP TABLE ${retainedHistoryTables
        .map((table) => `${quoteIdentifier(schema)}.${quoteIdentifier(`${table}_g${generation}`)}`)
        .join(", ")}`,
    );
    return performance.now() - started;
  }
  for (const table of retainedHistoryTables) {
    await client.query(
      `DELETE FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} WHERE generation = $1`,
      [generation],
    );
  }
  return performance.now() - started;
}

async function runRetentionOperation(
  client: PoolClient,
  schema: string,
  strategy: RetentionStrategy,
  generation: number,
): Promise<{ retentionMs: number; vacuumMs: number | null; beforeVacuum: HistoryStorageSnapshot }> {
  const retentionMs = await retainGeneration(client, schema, strategy, generation);
  const beforeVacuum = historyStorage(await captureRelationTelemetry(client, schema));
  let vacuumMs: number | null = null;
  if (strategy === "row-delete-vacuum") {
    vacuumMs = 0;
    for (const table of retainedHistoryTables) {
      const vacuum = await vacuumAnalyzeRelation(client, schema, table);
      vacuumMs += vacuum.durationMs;
    }
  }
  return { retentionMs, vacuumMs, beforeVacuum };
}

async function runStrategy(
  pool: Pool,
  strategy: RetentionStrategy,
  rowsPerCycle: number,
  options: ResolvedRetentionStrategiesOptions,
): Promise<RetentionStrategyMeasurement> {
  const schema = await setupSchema(pool, strategy);
  const triggerCost = await measureTriggerCost(pool, schema, strategy, options);
  // Remove trigger-probe partitions and heap pages before the sustained workload starts.
  await setupSchema(pool, strategy);
  await seedHistoryJobs(pool, schema, Math.max(...options.rowsPerCycle));
  await seedReadyJobs(pool, schema, options.readyJobs);
  const cycles: RetentionCycleMeasurement[] = [];

  for (let cycle = 0; cycle < options.cycles; cycle += 1) {
    await createGeneration(pool, schema, strategy, cycle);
    const cycleWal = await captureWalLsnStart(pool);
    let insertMs = 0;
    for (const table of retainedHistoryTables) {
      insertMs += await insertHistory(
        pool,
        schema,
        table,
        cycle,
        rowsPerCycle,
        options.payloadBytes,
      );
    }
    const claimBefore = summarizeLatencies(await claimSamples(pool, schema, options.claimSamples));
    const expiredGeneration = cycle - options.retainedCycles;
    let retiredRows = 0;
    let retentionMs: number | null = null;
    let vacuumMs: number | null = null;
    let retentionWalBytes: number | null = null;
    let beforeVacuum = await storageSnapshot(pool, schema);
    let claimDuringSamples: number[] = [];

    if (expiredGeneration >= 0) {
      retiredRows = await countGeneration(pool, schema, expiredGeneration);
      const retentionWal = await captureWalLsnStart(pool);
      const cleanupClient = await pool.connect();
      try {
        const cleanup = runRetentionOperation(cleanupClient, schema, strategy, expiredGeneration);
        const claims = concurrentClaimSamples(pool, schema, options.claimSamples);
        const [retained, concurrentSamples] = await Promise.all([cleanup, claims]);
        claimDuringSamples = concurrentSamples;
        retentionMs = retained.retentionMs;
        vacuumMs = retained.vacuumMs;
        beforeVacuum = retained.beforeVacuum;
      } finally {
        cleanupClient.release();
      }
      retentionWalBytes = (await captureWalLsnDifference(pool, retentionWal)).bytes;
    } else {
      claimDuringSamples = await claimSamples(pool, schema, options.claimSamples);
    }
    const afterVacuum = await storageSnapshot(pool, schema);
    const claimAfter = summarizeLatencies(await claimSamples(pool, schema, options.claimSamples));
    const walBytes = (await captureWalLsnDifference(pool, cycleWal)).bytes;
    cycles.push({
      cycle,
      insertedRows: rowsPerCycle * retainedHistoryTables.length,
      retiredRows,
      insertMs,
      retentionMs,
      vacuumMs,
      walBytes,
      retentionWalBytes,
      beforeVacuum,
      afterVacuum,
      claimBefore,
      claimDuring: summarizeLatencies(claimDuringSamples),
      claimAfter,
    });
  }

  const retainedCycles = cycles.filter((cycle) => cycle.retentionMs !== null);
  return {
    strategy,
    rowsPerCycle,
    triggerCost,
    cycles,
    retainedCycles,
    retentionMs: summarizeNumbers(retainedCycles.map((cycle) => cycle.retentionMs ?? Number.NaN)),
    retentionWalBytes: summarizeNumbers(
      retainedCycles.map((cycle) => cycle.retentionWalBytes ?? Number.NaN),
    ),
    vacuumMs: summarizeNumbers(retainedCycles.map((cycle) => cycle.vacuumMs ?? Number.NaN)),
    claimDuringP95Ms: summarizeNumbers(
      retainedCycles.map((cycle) => cycle.claimDuring.p95 ?? Number.NaN),
    ),
    finalStorage: await storageSnapshot(pool, schema),
  };
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  return numerator === null || denominator === null || denominator === 0
    ? null
    : numerator / denominator;
}

function median(values: Array<number | null>): number | null {
  const finite = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  if (finite.length === 0) return null;
  finite.sort((left, right) => left - right);
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 0
    ? ((finite[middle - 1] ?? 0) + (finite[middle] ?? 0)) / 2
    : (finite[middle] ?? null);
}

function comparisons(
  measurements: RetentionStrategyMeasurement[],
  rowsPerCycle: number[],
): RetentionScaleComparison[] {
  return rowsPerCycle.map((rows) => {
    const partition = measurements.find(
      (measurement) =>
        measurement.rowsPerCycle === rows && measurement.strategy === "partition-drop",
    );
    const row = measurements.find(
      (measurement) =>
        measurement.rowsPerCycle === rows && measurement.strategy === "row-delete-vacuum",
    );
    if (!partition || !row) throw new Error(`missing retention comparison at ${rows} rows`);
    const partitionRetentionMs = partition.retentionMs.mean;
    const rowRetentionAndVacuumMs =
      row.retentionMs.mean === null ? null : row.retentionMs.mean + (row.vacuumMs.mean ?? 0);
    const partitionRetentionWalBytesMedian = median(
      partition.retainedCycles.map((cycle) => cycle.retentionWalBytes),
    );
    const rowRetentionWalBytesMedian = median(
      row.retainedCycles.map((cycle) => cycle.retentionWalBytes),
    );
    return {
      rowsPerCycle: rows,
      partitionRetentionMs,
      rowRetentionAndVacuumMs,
      rowToPartitionRetentionRatio: ratio(rowRetentionAndVacuumMs, partitionRetentionMs),
      partitionRetentionWalBytesMedian,
      rowRetentionWalBytesMedian,
      rowToPartitionWalRatio: ratio(rowRetentionWalBytesMedian, partitionRetentionWalBytesMedian),
      partitionFinalBytes: partition.finalStorage.totalBytes,
      rowFinalBytes: row.finalStorage.totalBytes,
      rowToPartitionStorageRatio: ratio(
        row.finalStorage.totalBytes,
        partition.finalStorage.totalBytes,
      ),
      partitionClaimDuringP95Ms: partition.claimDuringP95Ms.mean,
      rowClaimDuringP95Ms: row.claimDuringP95Ms.mean,
    };
  });
}

async function postgresVersion(pool: Pool): Promise<string> {
  const result = await pool.query<QueryResultRow & { version: string }>("SELECT version()");
  return result.rows[0]?.version ?? "unknown";
}

export async function runRetentionStrategiesBenchmark(
  pool: Pool,
  input: RetentionStrategiesOptions = {},
): Promise<RetentionStrategiesReport> {
  const options = resolveRetentionStrategiesOptions(input);
  const measurements: RetentionStrategyMeasurement[] = [];
  const executionOrder: RetentionStrategiesReport["executionOrder"] = [];
  for (const [index, rowsPerCycle] of options.rowsPerCycle.entries()) {
    const strategies: RetentionStrategy[] =
      index % 2 === 0
        ? ["partition-drop", "row-delete-vacuum"]
        : ["row-delete-vacuum", "partition-drop"];
    executionOrder.push({ rowsPerCycle, strategies });
    for (const strategy of strategies) {
      measurements.push(await runStrategy(pool, strategy, rowsPerCycle, options));
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: platform(),
      platformRelease: release(),
      cpu: cpus()[0]?.model ?? "unknown",
      postgres: await postgresVersion(pool),
    },
    options,
    executionOrder,
    measurements,
    comparisons: comparisons(measurements, options.rowsPerCycle),
  };
}
