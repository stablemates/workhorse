import { performance } from "node:perf_hooks";
import type { Pool } from "pg";
import { installSchema } from "../src/schema.js";
import { nearestRankPercentile, summarizeNumbers, type NumericSummary } from "./statistics.js";

/**
 * Measures how claim admission, the tag index, budgets, and operator reads behave when one queue
 * carries work for many tenants. The tenant is a task attribute: a `concurrency_key`, a
 * `tenant:<id>` tag, and in the budgeted profile a `budget_name`. The benchmark answers the
 * planning question ADR 0068 asks: does dispatch cost grow with the number of tenants, or only
 * with the bounded admission window and the ready depth?
 */

type TenantProfile = "keyed" | "budgeted";

export interface TenantCardinalityOptions {
  /** Ladder of distinct tenants to load, one fresh schema per rung and profile. */
  tenants?: readonly number[];
  /** Ready rows per tenant. */
  tasksPerTenant?: number;
  /** Tenants at the head of the queue whose key and budget are already at capacity. */
  saturatedTenants?: number;
  /** Per-key concurrency limit, and the per-tenant budget cap in the budgeted profile. */
  maxActivePerKey?: number;
  /** Measured `claim_v1` calls per rung. */
  claimSamples?: number;
  /** Measured read probes per rung. */
  readSamples?: number;
  /** Unmeasured calls before each measured series. */
  warmupSamples?: number;
  profiles?: readonly TenantProfile[];
}

interface ResolvedOptions {
  tenants: readonly number[];
  tasksPerTenant: number;
  saturatedTenants: number;
  maxActivePerKey: number;
  claimSamples: number;
  readSamples: number;
  warmupSamples: number;
  profiles: readonly TenantProfile[];
}

const defaults: ResolvedOptions = {
  tenants: [100, 1_000, 10_000, 100_000],
  tasksPerTenant: 2,
  saturatedTenants: 40,
  maxActivePerKey: 2,
  claimSamples: 25,
  readSamples: 10,
  warmupSamples: 2,
  profiles: ["keyed", "budgeted"],
};

const queueName = "tenant-work";
const namespace = "tenant-benchmark";
/** `claim_v1` inspects at most this many ready rows when a per-key limit can pass over a key. */
const admissionWindow = 100;
/** `sync_*_v1` accept at most this many definitions per call. */
const syncChunk = 10_000;

function resolveTenantCardinalityOptions(options: TenantCardinalityOptions = {}): ResolvedOptions {
  const resolved: ResolvedOptions = {
    ...defaults,
    ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
  };
  if (resolved.tenants.length === 0) throw new RangeError("tenants must list at least one rung");
  for (const rung of resolved.tenants) {
    if (!Number.isSafeInteger(rung) || rung < 1) {
      throw new RangeError("every tenants rung must be a positive safe integer");
    }
  }
  for (const name of [
    "tasksPerTenant",
    "saturatedTenants",
    "maxActivePerKey",
    "claimSamples",
    "readSamples",
    "warmupSamples",
  ] as const) {
    const value = resolved[name];
    const minimum = name === "warmupSamples" || name === "saturatedTenants" ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new RangeError(`${name} must be an integer of at least ${minimum}`);
    }
  }
  if (resolved.saturatedTenants * resolved.tasksPerTenant >= admissionWindow) {
    throw new RangeError(
      `saturatedTenants * tasksPerTenant must stay below the ${admissionWindow}-row admission window`,
    );
  }
  for (const profile of resolved.profiles) {
    if (profile !== "keyed" && profile !== "budgeted") {
      throw new RangeError(`unknown profile ${String(profile)}`);
    }
  }
  return resolved;
}

interface LatencySeries {
  summary: NumericSummary;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

interface PlanSummary {
  nodeTypes: string[];
  indexes: string[];
  planningTimeMs: number;
  executionTimeMs: number;
  sharedHitBlocks: number;
  sharedReadBlocks: number;
}

interface TenantRungReport {
  tenants: number;
  profile: TenantProfile;
  load: {
    readyRows: number;
    activeRows: number;
    budgetRows: number;
    keyBucketRows: number;
    loadMs: number;
    policySyncMs: number;
    budgetSyncMs: number;
  };
  claim: LatencySeries & {
    admittedClaims: number;
    firstAdmittedTenant: number | null;
    skippedRowsPerClaim: number;
    keyBucketRowsAfter: number;
  };
  reads: Record<string, LatencySeries>;
  plans: Record<string, PlanSummary>;
  relations: Record<string, { rows: number | null; bytes: number }>;
}

export interface TenantCardinalityReport {
  generatedAt: string;
  postgres: { version: string; sharedBuffers: string; workMem: string };
  options: ResolvedOptions;
  rungs: TenantRungReport[];
}

function series(values: readonly number[]): LatencySeries {
  return {
    summary: summarizeNumbers(values),
    p50Ms: nearestRankPercentile(values, 0.5),
    p95Ms: nearestRankPercentile(values, 0.95),
    p99Ms: nearestRankPercentile(values, 0.99),
  };
}

async function timed<T>(work: () => Promise<T>): Promise<{ result: T; elapsedMs: number }> {
  const started = performance.now();
  const result = await work();
  return { result, elapsedMs: performance.now() - started };
}

async function sampleSeries(
  pool: Pool,
  statement: string,
  parameters: unknown[],
  samples: number,
  warmup: number,
): Promise<LatencySeries> {
  for (let index = 0; index < warmup; index += 1) await pool.query(statement, parameters);
  const values: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    values.push((await timed(() => pool.query(statement, parameters))).elapsedMs);
  }
  return series(values);
}

function planRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("EXPLAIN returned an invalid plan object");
  }
  return value as Record<string, unknown>;
}

function walkPlan(plan: Record<string, unknown>, into: { nodeTypes: string[]; indexes: string[] }) {
  into.nodeTypes.push(String(plan["Node Type"] ?? "unknown"));
  const indexName = plan["Index Name"];
  if (typeof indexName === "string" && !into.indexes.includes(indexName)) {
    into.indexes.push(indexName);
  }
  const children = Array.isArray(plan.Plans) ? plan.Plans : [];
  for (const child of children) walkPlan(planRecord(child), into);
}

async function explain(pool: Pool, statement: string, parameters: unknown[]): Promise<PlanSummary> {
  const result = await pool.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`,
    parameters,
  );
  const raw = result.rows[0]?.["QUERY PLAN"];
  const document = Array.isArray(raw) ? planRecord(raw[0]) : planRecord(raw);
  const plan = planRecord(document.Plan);
  const walked = { nodeTypes: [] as string[], indexes: [] as string[] };
  walkPlan(plan, walked);
  return {
    nodeTypes: walked.nodeTypes,
    indexes: walked.indexes,
    planningTimeMs: Number(document["Planning Time"]),
    executionTimeMs: Number(document["Execution Time"]),
    sharedHitBlocks: Number(plan["Shared Hit Blocks"] ?? 0),
    sharedReadBlocks: Number(plan["Shared Read Blocks"] ?? 0),
  };
}

async function count(pool: Pool, statement: string, parameters: unknown[] = []): Promise<number> {
  const result = await pool.query<{ count: string }>(statement, parameters);
  return Number(result.rows[0]?.count ?? 0);
}

function tenantName(index: number): string {
  return `tenant-${index}`;
}

async function syncInChunks(
  pool: Pool,
  fn: string,
  definitions: readonly unknown[],
): Promise<number> {
  let elapsed = 0;
  for (let offset = 0; offset < definitions.length; offset += syncChunk) {
    const chunk = definitions.slice(offset, offset + syncChunk);
    elapsed += (
      await timed(() =>
        pool.query(`SELECT * FROM workhorse.${fn}($1, $2::jsonb, false)`, [
          namespace,
          JSON.stringify(chunk),
        ]),
      )
    ).elapsedMs;
  }
  return elapsed;
}

async function loadRung(
  pool: Pool,
  tenants: number,
  profile: TenantProfile,
  options: ResolvedOptions,
): Promise<TenantRungReport["load"]> {
  await pool.query("DROP SCHEMA IF EXISTS workhorse CASCADE");
  await installSchema(pool);

  const policySync = await timed(async () => {
    await pool.query(`SELECT * FROM workhorse.sync_concurrency_policies_v1($1, $2::jsonb, true)`, [
      namespace,
      JSON.stringify([
        { queue: queueName, maxActive: 1_000_000, maxActivePerKey: options.maxActivePerKey },
      ]),
    ]);
    await pool.query(`SELECT * FROM workhorse.sync_rate_limit_policies_v1($1, $2::jsonb, true)`, [
      namespace,
      JSON.stringify([
        {
          queue: queueName,
          rate: { limit: 1_000_000, intervalMs: 1_000, burst: 1_000_000 },
          perKey: { limit: 1_000_000, intervalMs: 1_000, burst: 1_000_000 },
        },
      ]),
    ]);
  });

  let budgetSyncMs = 0;
  if (profile === "budgeted") {
    const definitions = Array.from({ length: tenants }, (_, index) => ({
      name: tenantName(index),
      maxActive: options.maxActivePerKey,
    }));
    budgetSyncMs = await syncInChunks(pool, "sync_budgets_v1", definitions);
  }

  const budgetExpression = profile === "budgeted" ? "'tenant-' || tenant" : "NULL::text";
  const loadStarted = performance.now();
  // Saturated head: the first tenants already hold `maxActivePerKey` active leases, so their ready
  // rows sit at the front of the window and every claim has to pass over them.
  await pool.query(
    `WITH source AS (
       SELECT tenant, slot,
              md5('active:' || tenant || ':' || slot)::uuid AS id
         FROM generate_series(0, $1::integer - 1) tenant,
              generate_series(1, $2::integer) slot
     ), identity AS (
       INSERT INTO workhorse.task(
         id, queue_name, task_type, concurrency_key, payload, tags, max_attempts, budget_name
       )
       SELECT id, $3, 'tenant.work', 'tenant-' || tenant,
              jsonb_build_object('tenant', tenant, 'slot', slot),
              ARRAY['tenant:' || tenant, 'plan:' || (tenant % 4)], 3, ${budgetExpression}
         FROM source
       RETURNING id, concurrency_key, budget_name
     )
     INSERT INTO workhorse.task_runtime(
       task_id, queue_name, concurrency_key, state, current_attempt, fence_token, run_at,
       worker_id, acquired_at, heartbeat_at, expires_at, attempt_started_at, budget_name
     )
     SELECT id, $3, concurrency_key, 'active', 1, nextval('workhorse.fence_token_seq'),
            clock_timestamp(), 'bench-holder', clock_timestamp(), clock_timestamp(),
            clock_timestamp() + interval '1 hour', clock_timestamp(), budget_name
       FROM identity`,
    [options.saturatedTenants, options.maxActivePerKey, queueName],
  );
  await pool.query(
    `WITH source AS (
       SELECT tenant, slot,
              md5('ready:' || tenant || ':' || slot)::uuid AS id,
              (tenant::bigint * $2::integer + slot) AS sequence
         FROM generate_series(0, $1::integer - 1) tenant,
              generate_series(1, $2::integer) slot
     ), identity AS (
       INSERT INTO workhorse.task(
         id, queue_name, task_type, concurrency_key, payload, tags, max_attempts, budget_name
       )
       SELECT id, $3, 'tenant.work', 'tenant-' || tenant,
              jsonb_build_object('tenant', tenant, 'slot', slot),
              ARRAY['tenant:' || tenant, 'plan:' || (tenant % 4)], 3, ${budgetExpression}
         FROM source
       RETURNING id, concurrency_key, budget_name
     )
     INSERT INTO workhorse.task_runtime(
       task_id, queue_name, concurrency_key, state, current_attempt, run_at, ready_at, sequence,
       budget_name
     )
     SELECT identity.id, $3, identity.concurrency_key, 'ready', 1, clock_timestamp(),
            clock_timestamp(), source.sequence, identity.budget_name
       FROM identity JOIN source ON source.id = identity.id`,
    [tenants, options.tasksPerTenant, queueName],
  );
  await pool.query(`SELECT setval('workhorse.ready_sequence_seq', $1::bigint + 1)`, [
    tenants * options.tasksPerTenant,
  ]);
  // Every tenant has started work before, so its sparse per-key bucket row exists and is full.
  // `claim_v1` prunes at most 100 full key buckets per call, oldest first.
  await pool.query(
    `INSERT INTO workhorse.rate_limit_bucket(queue_name, bucket_scope, bucket_key, tokens, refilled_at)
     SELECT $1, 'key', 'tenant-' || tenant, 1000000,
            clock_timestamp() - make_interval(secs => tenant::double precision)
       FROM generate_series(0, $2::integer - 1) tenant`,
    [queueName, tenants],
  );
  await pool.query(
    "ANALYZE workhorse.task, workhorse.task_runtime, workhorse.budget, workhorse.rate_limit_bucket",
  );
  const loadMs = performance.now() - loadStarted;

  return {
    readyRows: await count(
      pool,
      "SELECT count(*) FROM workhorse.task_runtime WHERE state = 'ready'",
    ),
    activeRows: await count(
      pool,
      "SELECT count(*) FROM workhorse.task_runtime WHERE state = 'active'",
    ),
    budgetRows: await count(pool, "SELECT count(*) FROM workhorse.budget"),
    keyBucketRows: await count(
      pool,
      "SELECT count(*) FROM workhorse.rate_limit_bucket WHERE bucket_scope = 'key'",
    ),
    loadMs,
    policySyncMs: policySync.elapsedMs,
    budgetSyncMs,
  };
}

async function measureClaims(
  pool: Pool,
  options: ResolvedOptions,
): Promise<TenantRungReport["claim"]> {
  const statement = "SELECT payload FROM workhorse.claim_v1($1, $2, 60000)";
  const parameters = [queueName, "bench-claimer"];
  let firstAdmittedTenant: number | null = null;
  let admitted = 0;
  const values: number[] = [];
  for (let index = 0; index < options.warmupSamples + options.claimSamples; index += 1) {
    const { result, elapsedMs } = await timed(() =>
      pool.query<{ payload: { tenant: number } }>(statement, parameters),
    );
    const row = result.rows[0];
    if (row) {
      admitted += 1;
      firstAdmittedTenant ??= row.payload.tenant;
    }
    if (index >= options.warmupSamples) values.push(elapsedMs);
  }
  return {
    ...series(values),
    admittedClaims: admitted,
    firstAdmittedTenant,
    skippedRowsPerClaim: options.saturatedTenants * options.tasksPerTenant,
    keyBucketRowsAfter: await count(
      pool,
      "SELECT count(*) FROM workhorse.rate_limit_bucket WHERE bucket_scope = 'key'",
    ),
  };
}

const activePerKeySql = `SELECT count(*) FROM workhorse.task_runtime active
   WHERE active.state = 'active' AND active.queue_name = $1
     AND active.concurrency_key = $2 AND active.expires_at > clock_timestamp()`;
const activePerBudgetSql = `SELECT count(*) FROM workhorse.task_runtime active
   WHERE active.state = 'active' AND active.budget_name = $1
     AND active.expires_at > clock_timestamp()`;
const tagOverlapSql = `SELECT count(*) FROM workhorse.task WHERE tags && $1::text[]`;
const readyWindowSql = `SELECT runtime.task_id
    FROM workhorse.task_runtime runtime
    JOIN workhorse.task task ON task.id = runtime.task_id
   WHERE runtime.state = 'ready' AND runtime.queue_name = $1
     AND (runtime.deadline_at IS NULL OR runtime.deadline_at > clock_timestamp())
     AND (task.execution_timeout_ms IS NULL OR runtime.execution_used_ms < task.execution_timeout_ms)
   ORDER BY runtime.priority DESC, runtime.sequence, runtime.task_id
   LIMIT ${admissionWindow}`;

async function measureReads(
  pool: Pool,
  tenants: number,
  profile: TenantProfile,
  options: ResolvedOptions,
): Promise<Pick<TenantRungReport, "reads" | "plans">> {
  const probeTenant = tenantName(Math.floor(tenants / 2));
  const saturatedTenant = tenantName(0);
  const probeTag = [`tenant:${Math.floor(tenants / 2)}`];
  const budgetPage = Array.from({ length: Math.min(tenants, 100) }, (_, index) =>
    tenantName(index),
  );
  const { readSamples, warmupSamples } = options;

  const reads: Record<string, LatencySeries> = {
    dashboardTasksByTag: await sampleSeries(
      pool,
      "SELECT workhorse.dashboard_tasks_v1($1::jsonb)",
      [JSON.stringify({ tags: probeTag, pageSize: 50 })],
      readSamples,
      warmupSamples,
    ),
    tagOverlapCount: await sampleSeries(
      pool,
      tagOverlapSql,
      [probeTag],
      readSamples,
      warmupSamples,
    ),
    activePerKeyCount: await sampleSeries(
      pool,
      activePerKeySql,
      [queueName, saturatedTenant],
      readSamples,
      warmupSamples,
    ),
    queueHealth: await sampleSeries(
      pool,
      "SELECT workhorse.queue_health_v1()",
      [],
      readSamples,
      warmupSamples,
    ),
  };
  const plans: Record<string, PlanSummary> = {
    tagOverlapCount: await explain(pool, tagOverlapSql, [probeTag]),
    activePerKeyCount: await explain(pool, activePerKeySql, [queueName, saturatedTenant]),
    readyWindow: await explain(pool, readyWindowSql, [queueName]),
  };
  if (profile === "budgeted") {
    reads.budgetStatusPage = await sampleSeries(
      pool,
      "SELECT * FROM workhorse.budget_status_v1($1::text[])",
      [budgetPage],
      readSamples,
      warmupSamples,
    );
    reads.budgetAdmission = await sampleSeries(
      pool,
      "SELECT workhorse.budget_admission_v1($1, clock_timestamp())",
      [probeTenant],
      readSamples,
      warmupSamples,
    );
    plans.activePerBudgetCount = await explain(pool, activePerBudgetSql, [saturatedTenant]);
  }
  return { reads, plans };
}

async function measureRelations(pool: Pool): Promise<TenantRungReport["relations"]> {
  const result = await pool.query<{ name: string; rows: string | null; bytes: string }>(
    `SELECT c.relname AS name,
            CASE WHEN c.relkind = 'r' THEN c.reltuples::bigint::text END AS rows,
            pg_relation_size(c.oid)::text AS bytes
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'workhorse'
        AND c.relname IN (
          'task', 'task_runtime', 'budget', 'rate_limit_bucket',
          'task_tags_gin_idx', 'task_runtime_ready_idx',
          'task_runtime_active_queue_key_expiry_idx', 'task_runtime_active_budget_expiry_idx',
          'task_runtime_ready_budget_idx', 'budget_pkey', 'rate_limit_bucket_pkey'
        )
      ORDER BY c.relname`,
  );
  return Object.fromEntries(
    result.rows.map((row) => [
      row.name,
      { rows: row.rows === null ? null : Number(row.rows), bytes: Number(row.bytes) },
    ]),
  );
}

export async function runTenantCardinalityBenchmark(
  pool: Pool,
  options: TenantCardinalityOptions = {},
  log: (line: string) => void = () => {},
): Promise<TenantCardinalityReport> {
  const resolved = resolveTenantCardinalityOptions(options);
  const settings = await pool.query<{ version: string; shared_buffers: string; work_mem: string }>(
    `SELECT version() AS version,
            current_setting('shared_buffers') AS shared_buffers,
            current_setting('work_mem') AS work_mem`,
  );
  const rungs: TenantRungReport[] = [];
  for (const tenants of resolved.tenants) {
    for (const profile of resolved.profiles) {
      log(`loading ${tenants} tenants (${profile})`);
      const load = await loadRung(pool, tenants, profile, resolved);
      log(`  loaded ${load.readyRows} ready rows in ${Math.round(load.loadMs)} ms`);
      const claim = await measureClaims(pool, resolved);
      log(`  claim p50 ${claim.p50Ms?.toFixed(2)} ms, p95 ${claim.p95Ms?.toFixed(2)} ms`);
      const { reads, plans } = await measureReads(pool, tenants, profile, resolved);
      const relations = await measureRelations(pool);
      rungs.push({ tenants, profile, load, claim, reads, plans, relations });
    }
  }
  const [row] = settings.rows;
  return {
    generatedAt: new Date().toISOString(),
    postgres: {
      version: row?.version ?? "unknown",
      sharedBuffers: row?.shared_buffers ?? "unknown",
      workMem: row?.work_mem ?? "unknown",
    },
    options: resolved,
    rungs,
  };
}
