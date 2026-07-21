import { performance } from "node:perf_hooks";
import type { QueryResult } from "pg";
import type { Queryable } from "../src/types.js";

export type RelationKind =
  | "table"
  | "partitioned_table"
  | "materialized_view"
  | "index"
  | "partitioned_index"
  | "toast"
  | "other";

export interface WalLsnStart {
  lsn: string;
  capturedAt: Date;
}

export interface WalLsnDifference {
  startLsn: string;
  endLsn: string;
  bytes: number;
  capturedAt: Date;
}

export interface RelationTelemetry {
  schema: string;
  relation: string;
  kind: RelationKind;
  tableBytes: number;
  indexBytes: number;
  totalBytes: number;
  liveTuples: number;
  deadTuples: number;
  inserts: number;
  updates: number;
  hotUpdates: number;
  hotUpdateRatio: number | null;
  deletes: number;
  lastVacuum: Date | null;
  lastAutovacuum: Date | null;
  vacuumCount: number;
  autovacuumCount: number;
  analyzeCount: number;
  autoanalyzeCount: number;
}

export interface SchemaTotals {
  schema: string;
  relationCount: number;
  tableBytes: number;
  indexBytes: number;
  totalBytes: number;
  liveTuples: number;
  deadTuples: number;
  updates: number;
  hotUpdates: number;
  hotUpdateRatio: number | null;
  vacuumCount: number;
  autovacuumCount: number;
}

export interface ActivitySnapshot {
  capturedAt: Date;
  database: string;
  connections: number;
  activeConnections: number;
  idleInTransactionConnections: number;
  lockWaits: number;
  oldestTransaction: Date | null;
  oldestTransactionAgeMs: number | null;
}

export interface VacuumAnalyzeTiming {
  schema: string;
  relation: string;
  durationMs: number;
  startedAt: Date;
  finishedAt: Date;
}

export interface PgStatIoEntry {
  backendType: string;
  object: string;
  context: string;
  reads: number;
  readTimeMs: number;
  writes: number;
  writeTimeMs: number;
  writebacks: number;
  writebackTimeMs: number;
  extends: number;
  extendTimeMs: number;
  opBytes: number;
  hits: number;
  evictions: number;
  reuses: number;
  fsyncs: number;
  fsyncTimeMs: number;
  statsReset: Date | null;
}

export interface PgStatIoSnapshot {
  capturedAt: Date;
  entries: PgStatIoEntry[];
}

export interface PgStatIoDeltaEntry extends Omit<PgStatIoEntry, "statsReset"> {
  statsReset: Date | null;
}

export interface PgStatIoDelta {
  startCapturedAt: Date;
  endCapturedAt: Date;
  entries: PgStatIoDeltaEntry[];
}

type NumericString = string | number | null;

function numberFromPg(value: NumericString): number {
  if (value === null) return 0;
  return Number(value);
}

function dateFromPg(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function hotRatio(updates: number, hotUpdates: number): number | null {
  return updates === 0 ? null : hotUpdates / updates;
}

function quoteIdentifier(identifier: string): string {
  if (identifier.length === 0) throw new Error("identifier must not be empty");
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualifiedIdentifier(schema: string, relation: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(relation)}`;
}

function relationKind(kind: string): RelationKind {
  switch (kind) {
    case "r":
      return "table";
    case "p":
      return "partitioned_table";
    case "m":
      return "materialized_view";
    case "i":
      return "index";
    case "I":
      return "partitioned_index";
    case "t":
      return "toast";
    default:
      return "other";
  }
}

export async function captureWalLsnStart(db: Queryable): Promise<WalLsnStart> {
  const result = await db.query<{ lsn: string; captured_at: Date }>(
    "SELECT pg_current_wal_lsn()::text AS lsn, clock_timestamp() AS captured_at",
  );
  const row = result.rows[0];
  if (!row) throw new Error("failed to capture WAL LSN");
  return { lsn: row.lsn, capturedAt: dateFromPg(row.captured_at)! };
}

export async function captureWalLsnDifference(
  db: Queryable,
  start: WalLsnStart | string,
): Promise<WalLsnDifference> {
  const startLsn = typeof start === "string" ? start : start.lsn;
  const result = await db.query<{ end_lsn: string; bytes: string; captured_at: Date }>(
    `SELECT pg_current_wal_lsn()::text AS end_lsn,
            pg_wal_lsn_diff(pg_current_wal_lsn(), $1)::text AS bytes,
            clock_timestamp() AS captured_at`,
    [startLsn],
  );
  const row = result.rows[0];
  if (!row) throw new Error("failed to capture WAL LSN difference");
  return {
    startLsn,
    endLsn: row.end_lsn,
    bytes: Number(row.bytes),
    capturedAt: dateFromPg(row.captured_at)!,
  };
}

export async function captureRelationTelemetry(
  db: Queryable,
  schema: string,
): Promise<RelationTelemetry[]> {
  await db.query("SELECT pg_stat_force_next_flush()");
  const result = await db.query<{
    schema_name: string;
    relation_name: string;
    relkind: string;
    table_bytes: string;
    index_bytes: string;
    total_bytes: string;
    live_tuples: string;
    dead_tuples: string;
    inserts: string;
    updates: string;
    hot_updates: string;
    deletes: string;
    last_vacuum: Date | null;
    last_autovacuum: Date | null;
    vacuum_count: string;
    autovacuum_count: string;
    analyze_count: string;
    autoanalyze_count: string;
  }>(
    `SELECT n.nspname AS schema_name,
            c.relname AS relation_name,
            c.relkind,
            pg_table_size(c.oid)::text AS table_bytes,
            pg_indexes_size(c.oid)::text AS index_bytes,
            pg_total_relation_size(c.oid)::text AS total_bytes,
            COALESCE(s.n_live_tup, 0)::text AS live_tuples,
            COALESCE(s.n_dead_tup, 0)::text AS dead_tuples,
            COALESCE(s.n_tup_ins, 0)::text AS inserts,
            COALESCE(s.n_tup_upd, 0)::text AS updates,
            COALESCE(s.n_tup_hot_upd, 0)::text AS hot_updates,
            COALESCE(s.n_tup_del, 0)::text AS deletes,
            s.last_vacuum,
            s.last_autovacuum,
            COALESCE(s.vacuum_count, 0)::text AS vacuum_count,
            COALESCE(s.autovacuum_count, 0)::text AS autovacuum_count,
            COALESCE(s.analyze_count, 0)::text AS analyze_count,
            COALESCE(s.autoanalyze_count, 0)::text AS autoanalyze_count
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p', 'm')
      ORDER BY n.nspname, c.relname`,
    [schema],
  );

  return result.rows.map((row) => {
    const updates = numberFromPg(row.updates);
    const hotUpdates = numberFromPg(row.hot_updates);
    return {
      schema: row.schema_name,
      relation: row.relation_name,
      kind: relationKind(row.relkind),
      tableBytes: numberFromPg(row.table_bytes),
      indexBytes: numberFromPg(row.index_bytes),
      totalBytes: numberFromPg(row.total_bytes),
      liveTuples: numberFromPg(row.live_tuples),
      deadTuples: numberFromPg(row.dead_tuples),
      inserts: numberFromPg(row.inserts),
      updates,
      hotUpdates,
      hotUpdateRatio: hotRatio(updates, hotUpdates),
      deletes: numberFromPg(row.deletes),
      lastVacuum: dateFromPg(row.last_vacuum),
      lastAutovacuum: dateFromPg(row.last_autovacuum),
      vacuumCount: numberFromPg(row.vacuum_count),
      autovacuumCount: numberFromPg(row.autovacuum_count),
      analyzeCount: numberFromPg(row.analyze_count),
      autoanalyzeCount: numberFromPg(row.autoanalyze_count),
    };
  });
}

export async function captureSchemaTotals(db: Queryable, schema: string): Promise<SchemaTotals> {
  const relations = await captureRelationTelemetry(db, schema);
  const totals = relations.reduce(
    (accumulator, relation) => ({
      relationCount: accumulator.relationCount + 1,
      tableBytes: accumulator.tableBytes + relation.tableBytes,
      indexBytes: accumulator.indexBytes + relation.indexBytes,
      totalBytes: accumulator.totalBytes + relation.totalBytes,
      liveTuples: accumulator.liveTuples + relation.liveTuples,
      deadTuples: accumulator.deadTuples + relation.deadTuples,
      updates: accumulator.updates + relation.updates,
      hotUpdates: accumulator.hotUpdates + relation.hotUpdates,
      vacuumCount: accumulator.vacuumCount + relation.vacuumCount,
      autovacuumCount: accumulator.autovacuumCount + relation.autovacuumCount,
    }),
    {
      relationCount: 0,
      tableBytes: 0,
      indexBytes: 0,
      totalBytes: 0,
      liveTuples: 0,
      deadTuples: 0,
      updates: 0,
      hotUpdates: 0,
      vacuumCount: 0,
      autovacuumCount: 0,
    },
  );
  return { schema, ...totals, hotUpdateRatio: hotRatio(totals.updates, totals.hotUpdates) };
}

export async function captureActivitySnapshot(db: Queryable): Promise<ActivitySnapshot> {
  const result = await db.query<{
    captured_at: Date;
    database_name: string;
    connections: string;
    active_connections: string;
    idle_in_transaction_connections: string;
    lock_waits: string;
    oldest_transaction: Date | null;
    oldest_transaction_age_ms: string | null;
  }>(
    `WITH activity AS (
       SELECT * FROM pg_stat_activity WHERE datname = current_database()
     )
     SELECT clock_timestamp() AS captured_at,
            current_database() AS database_name,
            count(*)::text AS connections,
            count(*) FILTER (WHERE state = 'active')::text AS active_connections,
            count(*) FILTER (WHERE state = 'idle in transaction')::text AS idle_in_transaction_connections,
            count(*) FILTER (WHERE wait_event_type = 'Lock')::text AS lock_waits,
            min(xact_start) AS oldest_transaction,
            (extract(epoch FROM clock_timestamp() - min(xact_start)) * 1000)::text AS oldest_transaction_age_ms
       FROM activity`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("failed to capture activity snapshot");
  return {
    capturedAt: dateFromPg(row.captured_at)!,
    database: row.database_name,
    connections: numberFromPg(row.connections),
    activeConnections: numberFromPg(row.active_connections),
    idleInTransactionConnections: numberFromPg(row.idle_in_transaction_connections),
    lockWaits: numberFromPg(row.lock_waits),
    oldestTransaction: dateFromPg(row.oldest_transaction),
    oldestTransactionAgeMs:
      row.oldest_transaction_age_ms === null ? null : Number(row.oldest_transaction_age_ms),
  };
}

export async function explainAnalyzeBuffersJson(
  db: Queryable,
  sql: string,
  values: readonly unknown[] = [],
): Promise<unknown> {
  const result = (await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, [
    ...values,
  ])) as QueryResult<{
    "QUERY PLAN": unknown;
  }>;
  return result.rows[0]?.["QUERY PLAN"] ?? null;
}

export async function vacuumAnalyzeRelation(
  db: Queryable,
  schema: string,
  relation: string,
): Promise<VacuumAnalyzeTiming> {
  const startedAt = new Date();
  const started = performance.now();
  await db.query(`VACUUM (ANALYZE) ${qualifiedIdentifier(schema, relation)}`);
  const finishedAt = new Date();
  return {
    schema,
    relation,
    durationMs: performance.now() - started,
    startedAt,
    finishedAt,
  };
}

export async function capturePgStatIoSnapshot(db: Queryable): Promise<PgStatIoSnapshot | null> {
  const available = await db.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'pg_catalog' AND table_name = 'pg_stat_io'`,
  );
  if (available.rows.length === 0) return null;
  const columns = new Set(available.rows.map((row) => row.column_name));
  // PostgreSQL 18 replaced the single op_bytes column with per-operation byte counters.
  // Preserve one stable cross-version field by summing those counters when necessary.
  const operationBytesExpression = columns.has("op_bytes")
    ? "op_bytes"
    : "COALESCE(read_bytes, 0) + COALESCE(write_bytes, 0) + COALESCE(extend_bytes, 0)";

  try {
    const result = await db.query<{
      captured_at: Date;
      backend_type: string;
      object: string;
      context: string;
      reads: string;
      read_time: string;
      writes: string;
      write_time: string;
      writebacks: string;
      writeback_time: string;
      extends: string;
      extend_time: string;
      op_bytes: string;
      hits: string;
      evictions: string;
      reuses: string;
      fsyncs: string;
      fsync_time: string;
      stats_reset: Date | null;
    }>(
      `SELECT clock_timestamp() AS captured_at,
              backend_type,
              object,
              context,
              reads::text,
              read_time::text,
              writes::text,
              write_time::text,
              writebacks::text,
              writeback_time::text,
              extends::text,
              extend_time::text,
              (${operationBytesExpression})::text AS op_bytes,
              hits::text,
              evictions::text,
              reuses::text,
              fsyncs::text,
              fsync_time::text,
              stats_reset
         FROM pg_stat_io
        ORDER BY backend_type, object, context`,
    );
    const capturedAt = dateFromPg(result.rows[0]?.captured_at ?? new Date())!;
    return {
      capturedAt,
      entries: result.rows.map((row) => ({
        backendType: row.backend_type,
        object: row.object,
        context: row.context,
        reads: numberFromPg(row.reads),
        readTimeMs: numberFromPg(row.read_time),
        writes: numberFromPg(row.writes),
        writeTimeMs: numberFromPg(row.write_time),
        writebacks: numberFromPg(row.writebacks),
        writebackTimeMs: numberFromPg(row.writeback_time),
        extends: numberFromPg(row.extends),
        extendTimeMs: numberFromPg(row.extend_time),
        opBytes: numberFromPg(row.op_bytes),
        hits: numberFromPg(row.hits),
        evictions: numberFromPg(row.evictions),
        reuses: numberFromPg(row.reuses),
        fsyncs: numberFromPg(row.fsyncs),
        fsyncTimeMs: numberFromPg(row.fsync_time),
        statsReset: dateFromPg(row.stats_reset),
      })),
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "42P01" || error.code === "42703")
    )
      return null;
    throw error;
  }
}

export function diffPgStatIoSnapshots(
  start: PgStatIoSnapshot | null,
  end: PgStatIoSnapshot | null,
): PgStatIoDelta | null {
  if (start === null || end === null) return null;
  const startEntries = new Map(
    start.entries.map((entry) => [
      `${entry.backendType}\0${entry.object}\0${entry.context}`,
      entry,
    ]),
  );
  return {
    startCapturedAt: start.capturedAt,
    endCapturedAt: end.capturedAt,
    entries: end.entries.map((entry) => {
      const startEntry = startEntries.get(
        `${entry.backendType}\0${entry.object}\0${entry.context}`,
      );
      return {
        backendType: entry.backendType,
        object: entry.object,
        context: entry.context,
        reads: entry.reads - (startEntry?.reads ?? 0),
        readTimeMs: entry.readTimeMs - (startEntry?.readTimeMs ?? 0),
        writes: entry.writes - (startEntry?.writes ?? 0),
        writeTimeMs: entry.writeTimeMs - (startEntry?.writeTimeMs ?? 0),
        writebacks: entry.writebacks - (startEntry?.writebacks ?? 0),
        writebackTimeMs: entry.writebackTimeMs - (startEntry?.writebackTimeMs ?? 0),
        extends: entry.extends - (startEntry?.extends ?? 0),
        extendTimeMs: entry.extendTimeMs - (startEntry?.extendTimeMs ?? 0),
        opBytes: entry.opBytes - (startEntry?.opBytes ?? 0),
        hits: entry.hits - (startEntry?.hits ?? 0),
        evictions: entry.evictions - (startEntry?.evictions ?? 0),
        reuses: entry.reuses - (startEntry?.reuses ?? 0),
        fsyncs: entry.fsyncs - (startEntry?.fsyncs ?? 0),
        fsyncTimeMs: entry.fsyncTimeMs - (startEntry?.fsyncTimeMs ?? 0),
        statsReset: entry.statsReset,
      };
    }),
  };
}
