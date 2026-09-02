import { readFile } from "node:fs/promises";
import path from "node:path";
import type { JobAttemptOutcome, JobState, Queryable } from "../typescript/core/src/types.js";

type JsonScalar = boolean | number | string | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export interface SqlProtocolManifest {
  formatVersion: number;
  protocolVersion: number;
  schema: { installedVersion: number; minimumVersion: number; maximumVersion: number };
  supportedClientProtocol: { minimumVersion: number; maximumVersion: number };
  fixtureCoverage: Record<"requests" | "schedules" | "interpreter", string[]>;
  coverage: string[];
  runtimeCoverage: string[];
  functions: { name: string; arity: number; contract: string }[];
  views: { name: string; contract: string }[];
  statements: {
    name: string;
    arity: number;
    contract: string;
    catalogues: ("internal" | "protocol" | "admin")[];
  }[];
  typescriptContractSources: string[];
}

interface CompatibilityFixture {
  id: string;
  installedSchemaVersion: number | null;
  clientProtocolVersion: number;
  compatible: boolean;
  refusalCode?: SqlProtocolRefusalCode;
  refusal?: string;
}

export type SqlProtocolRefusalCode =
  | "schema-not-installed"
  | "schema-too-old"
  | "schema-too-new"
  | "client-protocol-too-old"
  | "client-protocol-too-new";

export class SqlProtocolCompatibilityError extends Error {
  constructor(readonly code: SqlProtocolRefusalCode) {
    super(`SQL protocol compatibility check refused mutation: ${code}`);
    this.name = "SqlProtocolCompatibilityError";
  }
}

interface SqlStep {
  id: string;
  covers?: string[];
  sql: string;
  parameters?: JsonValue[];
  expect?: { rows: JsonValue[] };
  error?: { code: string; message: string; detail?: JsonValue };
  capture?: Record<string, string>;
}

interface SqlScenario {
  id: string;
  steps: SqlStep[];
}

interface RuntimeFixtureBase {
  id: string;
  covers: string[];
  jobType: string;
}

type RuntimeAbortReason =
  | "CancellationRequestedError"
  | "DeadlineExceededError"
  | "ExecutionTimeoutError";

export type RuntimeWriteOperation =
  | "setProgress"
  | "checkpoint"
  | "sleep"
  | "sleepUntil"
  | "waitForSignal"
  | "waitForHuman"
  | "runChild"
  | "runChildren";

interface ExpectedRuntimeState {
  state: JobState;
  attempt: number;
  errorName?: "DeadlineExceeded" | "ExecutionTimeout";
}

export interface BatchRuntimeFixture extends RuntimeFixtureBase {
  kind: "batch";
  concurrency: number;
  batchMaxSize: number;
  jobs: { key: string; priority: number; maxAttempts: number; outcome: string }[];
  expectedHandlerOrder: string[];
  expectedAfterFirstRun: Record<string, { state: string; attempt: number }>;
  expectedAfterSecondRun: Record<string, { state: string; attempt: number }>;
}

export interface SuspensionReplayRuntimeFixture extends RuntimeFixtureBase {
  kind: "suspension-replay";
  followingJobType: string;
  checkpointName: string;
  waitName: string;
  waitMs: number;
  expectedHandlerOrder: string[];
  expectedAfterSuspension: Record<string, { state: string; attempt: number }>;
  expectedAfterSlotRelease: Record<string, { state: string; attempt: number }>;
  expectedAfterReplay: Record<string, { state: string; attempt: number }>;
  expectedHandlerRuns: number;
  expectedCheckpointOperations: number;
  expectedAttemptsAfterSuspension: number;
  expectedAttemptsAfterReplay: number;
}

export interface CooperativeCancellationRuntimeFixture extends RuntimeFixtureBase {
  kind: "cooperative-cancellation";
  leaseMs: number;
  heartbeatMs: number;
  cancelReason: string;
  expectedAbortReason: RuntimeAbortReason;
  expectedState: ExpectedRuntimeState;
  expectedAttemptOutcome: JobAttemptOutcome;
}

export interface ExpirationRuntimeFixture extends RuntimeFixtureBase {
  kind: "expiration";
  mode: "deadline" | "execution-timeout";
  durationMs: number;
  localClockLeadMs: number;
  leaseMs: number;
  heartbeatMs: number;
  maxAttempts: number;
  expectedAbortReasons: RuntimeAbortReason[];
  expectedAfterRuns: ExpectedRuntimeState[];
  expectedAttemptOutcomes: JobAttemptOutcome[];
}

export interface LeaseLossRuntimeFixture extends RuntimeFixtureBase {
  kind: "lease-loss";
  leaseMs: number;
  heartbeatMs: number;
  maxAttempts: number;
  expectedAbortMessage: string;
  expectedRejectedWrites: RuntimeWriteOperation[];
  portableRejectedWrites: RuntimeWriteOperation[];
  expectedRejectedWriteError: string;
  expectedState: ExpectedRuntimeState;
  expectedAttemptOutcome: JobAttemptOutcome;
}

export interface HeartbeatCadenceRuntimeFixture extends RuntimeFixtureBase {
  kind: "heartbeat-cadence";
  leaseMs: number;
  heartbeatMs: number;
  expectedCallsWhileBlocked: number;
  expectedMinimumCallsBeforeSettlement: number;
  expectedMaximumOverlap: number;
}

export interface PollCadenceRuntimeFixture extends RuntimeFixtureBase {
  kind: "poll-cadence";
  pollMs: number;
  emptyPollsBeforeEnqueue: number;
  enqueueStallMs: number;
  expectedMinimumDelayMs: number;
  expectedMaximumDelayMs: number;
}

export interface GracefulDrainRuntimeFixture extends RuntimeFixtureBase {
  kind: "graceful-drain";
  concurrency: number;
  jobCount: number;
  settleCheckMs: number;
  expectedActiveAtStop: number;
  expectedSucceeded: number;
  expectedReady: number;
}

export interface TracePropagationRuntimeFixture extends RuntimeFixtureBase {
  kind: "trace-propagation";
}

export type RuntimeFixture =
  | BatchRuntimeFixture
  | SuspensionReplayRuntimeFixture
  | CooperativeCancellationRuntimeFixture
  | ExpirationRuntimeFixture
  | LeaseLossRuntimeFixture
  | HeartbeatCadenceRuntimeFixture
  | PollCadenceRuntimeFixture
  | GracefulDrainRuntimeFixture
  | TracePropagationRuntimeFixture;

export interface RequestFixture {
  id: string;
  application: { type: string; payload: JsonValue; options: Record<string, JsonValue> };
  postgres: Record<string, JsonValue>;
}

export interface ScheduleFixture {
  id: string;
  namespace: string;
  defaultQueue: string;
  prune: boolean;
  application: {
    name: string;
    schedule: string;
    timezone: string;
    enabled: boolean;
    job: {
      type: string;
      payload: JsonValue;
      queue?: string;
      priority: number;
      concurrencyKey?: string;
      maxAttempts: number;
      retryPolicy: JsonValue;
    };
  }[];
  postgres: JsonValue[];
}

export interface InterpreterFixture {
  id: string;
  steps: {
    id: string;
    expect: JsonValue;
    actual: JsonValue;
    rejects?: boolean;
    capture?: Record<string, string>;
  }[];
  errors: {
    id: string;
    expect: { code: string; message: string; detail?: JsonValue };
    actual: { code: string; message: string; detail?: JsonValue };
  }[];
}

export interface SqlProtocolFixtures {
  manifest: SqlProtocolManifest;
  compatibility: CompatibilityFixture[];
  scenarios: SqlScenario[];
  runtime: RuntimeFixture[];
  requests: RequestFixture[];
  schedules: ScheduleFixture[];
  interpreter: InterpreterFixture[];
}

export async function loadSqlProtocolFixtures(repository: string): Promise<SqlProtocolFixtures> {
  const directory = path.join(repository, "protocol", "v1");
  const [manifest, compatibility, scenarios, runtime, requests, schedules, interpreter] =
    await Promise.all([
      readJson<SqlProtocolManifest>(path.join(directory, "manifest.json")),
      readJson<CompatibilityFixture[]>(path.join(directory, "compatibility.json")),
      readJson<SqlScenario[]>(path.join(directory, "scenarios.json")),
      readJson<RuntimeFixture[]>(path.join(directory, "runtime.json")),
      readJson<RequestFixture[]>(path.join(directory, "requests.json")),
      readJson<ScheduleFixture[]>(path.join(directory, "schedules.json")),
      readJson<InterpreterFixture[]>(path.join(directory, "interpreter.json")),
    ]);
  return { manifest, compatibility, scenarios, runtime, requests, schedules, interpreter };
}

export function verifyFixtureExecution(
  manifest: SqlProtocolManifest,
  kind: keyof SqlProtocolManifest["fixtureCoverage"],
  defined: readonly string[],
  executed: ReadonlySet<string>,
): void {
  const expected = new Set(manifest.fixtureCoverage[kind]);
  const definedSet = new Set(defined);
  if (!sameSet(definedSet, expected)) {
    throw new Error(
      `${kind} fixture manifest differs: defined ${[...definedSet]}, expected ${[...expected]}`,
    );
  }
  const missing = [...expected].filter((id) => !executed.has(id));
  if (missing.length > 0)
    throw new Error(`${kind} fixtures were not executed: ${missing.join(", ")}`);
}

export async function verifySqlProtocolFixtures(
  database: Queryable,
  repository: string,
): Promise<{
  manifest: SqlProtocolManifest;
  coverage: Set<string>;
  scenarios: number;
  steps: number;
}> {
  const fixtures = await loadSqlProtocolFixtures(repository);
  verifyCompatibility(fixtures);
  await assertSqlProtocolCompatible(database, fixtures.manifest, fixtures.manifest.protocolVersion);
  const coverage = new Set<string>();
  let stepCount = 0;

  for (const scenario of fixtures.scenarios) {
    const references = new Map<string, JsonValue>();
    for (const step of scenario.steps) {
      stepCount += 1;
      for (const capability of step.covers ?? []) coverage.add(capability);
      const parameters = (step.parameters ?? []).map((value) => {
        const resolved = resolveReferences(value, references);
        return Array.isArray(resolved) ? JSON.stringify(resolved) : resolved;
      });
      try {
        const result = await database.query(step.sql, parameters);
        if (step.error) throw new Error(`${scenario.id}/${step.id} expected an error`);
        const rows = normalizeFixtureValue(result.rows);
        assertFixtureValue(
          step.expect?.rows ?? [],
          rows,
          `${scenario.id}/${step.id}.rows`,
          references,
        );
        for (const [name, pointer] of Object.entries(step.capture ?? {})) {
          references.set(name, readPointer(rows, pointer, `${scenario.id}/${step.id}`));
        }
      } catch (error) {
        if (!step.error) throw annotate(error, scenario.id, step.id);
        assertDatabaseError(error, step.error, scenario.id, step.id, references);
      }
    }
  }

  const missing = fixtures.manifest.coverage.filter(
    (capability) =>
      !fixtures.manifest.runtimeCoverage.includes(capability) && !coverage.has(capability),
  );
  if (missing.length > 0)
    throw new Error(`SQL protocol fixtures lack coverage: ${missing.join(", ")}`);
  return {
    manifest: fixtures.manifest,
    coverage,
    scenarios: fixtures.scenarios.length,
    steps: stepCount,
  };
}

function verifyCompatibility(fixtures: SqlProtocolFixtures): void {
  const { manifest } = fixtures;
  for (const fixture of fixtures.compatibility) {
    const refusalCode = compatibilityRefusal(
      manifest,
      fixture.installedSchemaVersion,
      fixture.clientProtocolVersion,
    );
    const compatible = refusalCode === null;
    if (compatible !== fixture.compatible) {
      throw new Error(
        `Compatibility fixture ${fixture.id} expected compatible=${fixture.compatible}`,
      );
    }
    if (!compatible && (!fixture.refusal || fixture.refusalCode !== refusalCode)) {
      throw new Error(`Compatibility fixture ${fixture.id} must define safe refusal behavior`);
    }
  }
}

export async function assertSqlProtocolCompatible(
  database: Queryable,
  manifest: SqlProtocolManifest,
  clientProtocolVersion: number,
): Promise<void> {
  let installedSchemaVersion: number | null = null;
  try {
    const result = await database.query<{ version: number }>(
      "SELECT version FROM workhorse.schema_version ORDER BY version",
    );
    if (result.rows.length === 1) installedSchemaVersion = result.rows[0]?.version ?? null;
  } catch {
    throw new SqlProtocolCompatibilityError("schema-not-installed");
  }
  const refusal = compatibilityRefusal(manifest, installedSchemaVersion, clientProtocolVersion);
  if (refusal !== null) throw new SqlProtocolCompatibilityError(refusal);
}

function compatibilityRefusal(
  manifest: SqlProtocolManifest,
  installedSchemaVersion: number | null,
  clientProtocolVersion: number,
): SqlProtocolRefusalCode | null {
  if (installedSchemaVersion === null) return "schema-not-installed";
  if (installedSchemaVersion < manifest.schema.minimumVersion) return "schema-too-old";
  if (installedSchemaVersion > manifest.schema.maximumVersion) return "schema-too-new";
  if (clientProtocolVersion < manifest.supportedClientProtocol.minimumVersion) {
    return "client-protocol-too-old";
  }
  if (clientProtocolVersion > manifest.supportedClientProtocol.maximumVersion) {
    return "client-protocol-too-new";
  }
  return null;
}

export function resolveReferences(value: JsonValue, references: Map<string, JsonValue>): JsonValue {
  if (Array.isArray(value)) return value.map((item) => resolveReferences(item, references));
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && "$ref" in value) {
      const reference = references.get(String(value.$ref));
      if (reference === undefined)
        throw new Error(`Unknown fixture reference ${String(value.$ref)}`);
      return reference;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveReferences(item, references)]),
    );
  }
  return value;
}

export function assertFixtureValue(
  expected: JsonValue,
  actual: JsonValue,
  location: string,
  references: Map<string, JsonValue>,
): void {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if ("$ref" in expected) {
      const reference = references.get(String(expected.$ref));
      if (reference === undefined || !deepEqual(reference, actual)) {
        throw new Error(`${location} does not equal fixture reference ${String(expected.$ref)}`);
      }
      return;
    }
    if ("$type" in expected) {
      assertMatcher(String(expected.$type), actual, location);
      return;
    }
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
      throw new Error(`${location} expected an object, received ${JSON.stringify(actual)}`);
    }
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
    const expectedKeys = Object.keys(expected).sort();
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
    const actualKeys = Object.keys(actual).sort();
    if (!deepEqual(expectedKeys, actualKeys)) {
      throw new Error(`${location} keys differ: expected ${expectedKeys}, received ${actualKeys}`);
    }
    for (const key of expectedKeys) {
      assertFixtureValue(expected[key]!, actual[key]!, `${location}.${key}`, references);
    }
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) {
      throw new Error(
        `${location} expected ${expected.length} items, received ${JSON.stringify(actual)}`,
      );
    }
    expected.forEach((item, index) =>
      assertFixtureValue(item, actual[index]!, `${location}[${index}]`, references),
    );
    return;
  }
  if (expected !== actual) {
    throw new Error(
      `${location} expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function assertMatcher(type: string, actual: JsonValue, location: string): void {
  const accepted =
    type === "any" ||
    (type === "uuid" &&
      typeof actual === "string" &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(actual)) ||
    (type === "timestamp" && typeof actual === "string" && isTimestamp(actual)) ||
    (type === "string" && typeof actual === "string") ||
    (type === "integer" && typeof actual === "number" && Number.isInteger(actual)) ||
    (type === "number" && typeof actual === "number" && Number.isFinite(actual)) ||
    (type === "boolean" && typeof actual === "boolean");
  if (!accepted)
    throw new Error(`${location} expected ${type}, received ${JSON.stringify(actual)}`);
}

function isTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1]! &&
    Number(hourText) <= 23 &&
    Number(minuteText) <= 59 &&
    Number(secondText) <= 59
  );
}

export function assertProtocolErrorValue(
  expected: NonNullable<SqlStep["error"]>,
  actual: { code?: unknown; message?: unknown; detail?: unknown },
  location: string,
  references: Map<string, JsonValue>,
): void {
  if (actual.code !== expected.code || actual.message !== expected.message) {
    throw new Error(
      `${location} expected ${expected.code} ${expected.message}, received ${String(actual.code)} ${String(actual.message)}`,
    );
  }
  if (expected.detail !== undefined) {
    const detail = typeof actual.detail === "string" ? JSON.parse(actual.detail) : actual.detail;
    assertFixtureValue(
      expected.detail,
      normalizeFixtureValue(detail),
      `${location}.detail`,
      references,
    );
  }
}

function assertDatabaseError(
  error: unknown,
  expected: NonNullable<SqlStep["error"]>,
  scenario: string,
  step: string,
  references: Map<string, JsonValue>,
): void {
  if (!error || typeof error !== "object") throw annotate(error, scenario, step);
  const value = error as { code?: unknown; message?: unknown; detail?: unknown };
  assertProtocolErrorValue(expected, value, `${scenario}/${step}`, references);
}

export function readPointer(value: JsonValue, pointer: string, context: string): JsonValue {
  let current: JsonValue | undefined = value;
  for (const segment of pointer.split(".")) {
    current = Array.isArray(current)
      ? current[Number(segment)]
      : current && typeof current === "object"
        ? current[segment]
        : undefined;
  }
  if (current === undefined) throw new Error(`${context} cannot capture ${pointer}`);
  return current;
}

export function normalizeFixtureValue<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function annotate(error: unknown, scenario: string, step: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${scenario}/${step}: ${message}`, { cause: error });
}

async function readJson<T>(filename: string): Promise<T> {
  return JSON.parse(await readFile(filename, "utf8")) as T;
}
