import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Queryable } from "../typescript/core/src/types.js";
import {
  assertFixtureValue,
  readPointer,
  resolveReferences,
  type JsonValue,
} from "./verify-sql-protocol.js";

export { readPointer, resolveReferences, type JsonValue };

/**
 * Execute the committed `dashboard/v1/conformance.json` fixtures against a dashboard backend.
 *
 * The fixtures are HTTP-level golden exchanges: SQL seed steps bring a freshly installed schema to
 * a known state, then each exchange posts one oRPC envelope and asserts the exact response status
 * and body. The TypeScript dashboard server is the reference implementation bound by these
 * fixtures (`typescript/dashboard-server/test/conformance.test.ts`); a foreign backend passes them
 * by wiring its own transport into `DashboardConformanceTransport`.
 */

export interface DashboardConformanceHarness {
  basePath: string;
  origin: string;
  crossOrigin: string;
  authenticatedActor: string;
  environment: string;
  configuredWorkers: string[];
  maintenanceLoops: { tickIntervalMs: number };
}

export interface DashboardConformanceSeedStep {
  id: string;
  sql: string;
  parameters?: JsonValue[];
  expect?: { rows: JsonValue[] };
  capture?: Record<string, string>;
}

export type DashboardConformanceMode = "writable" | "read-only";
export type DashboardConformanceOrigin = "same" | "cross" | "none";

export interface DashboardConformanceExchange {
  id: string;
  procedure: string;
  /** Which backend deployment answers this exchange. Defaults to "writable". */
  mode?: DashboardConformanceMode;
  /** Origin header behavior. Defaults to "same". */
  origin?: DashboardConformanceOrigin;
  /** HTTP method. Defaults to "POST". */
  method?: string;
  /** Literal JSON request body (the oRPC envelope), after `$ref` resolution. */
  request: JsonValue;
  expect: { status: number; body: JsonValue };
  capture?: Record<string, string>;
  /**
   * Generator input, ignored by verification: response-body pointers (`*` matches one segment)
   * whose values are environment-dependent and must stay `$type` matchers on regeneration.
   */
  coerce?: Record<string, string>;
}

export interface DashboardConformanceScenario {
  id: string;
  seed?: DashboardConformanceSeedStep[];
  exchanges?: DashboardConformanceExchange[];
}

export interface DashboardConformanceFixtures {
  formatVersion: number;
  contractVersion: number;
  harness: DashboardConformanceHarness;
  scenarios: DashboardConformanceScenario[];
}

interface DashboardManifest {
  formatVersion: number;
  contractVersion: number;
  procedures: Record<string, { mutation: boolean }>;
}

export interface DashboardConformanceTransport {
  /** Answer one owned HTTP request in the given deployment mode. */
  handle(mode: DashboardConformanceMode, request: Request): Promise<Response | null>;
}

export async function loadDashboardConformanceFixtures(
  repository: string,
): Promise<{ fixtures: DashboardConformanceFixtures; manifest: DashboardManifest }> {
  const directory = path.join(repository, "dashboard", "v1");
  const [fixtures, manifest] = await Promise.all([
    readJson<DashboardConformanceFixtures>(path.join(directory, "conformance.json")),
    readJson<DashboardManifest>(path.join(directory, "manifest.json")),
  ]);
  return { fixtures, manifest };
}

export function conformanceExchangeRequest(
  harness: DashboardConformanceHarness,
  exchange: DashboardConformanceExchange,
  body: JsonValue,
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  const origin = exchange.origin ?? "same";
  if (origin === "same") headers.set("origin", harness.origin);
  if (origin === "cross") headers.set("origin", harness.crossOrigin);
  const method = exchange.method ?? "POST";
  return new Request(
    `${harness.origin}${harness.basePath}/rpc/dashboard/${exchange.procedure}`,
    method === "GET" || method === "HEAD"
      ? { method, headers }
      : { method, headers, body: JSON.stringify(body) },
  );
}

export async function executeConformanceSeedStep(
  database: Queryable,
  scenarioId: string,
  step: DashboardConformanceSeedStep,
  references: Map<string, JsonValue>,
): Promise<void> {
  const location = `${scenarioId}/${step.id}`;
  const parameters = (step.parameters ?? []).map((value) => {
    const resolved = resolveReferences(value, references);
    return Array.isArray(resolved) ? JSON.stringify(resolved) : resolved;
  });
  try {
    const result = await database.query(step.sql, parameters);
    const rows = toJson(result.rows);
    if (step.expect) assertFixtureValue(step.expect.rows, rows, `${location}.rows`, references);
    for (const [name, pointer] of Object.entries(step.capture ?? {})) {
      references.set(name, readPointer(rows, pointer, location));
    }
  } catch (error) {
    throw annotate(error, location);
  }
}

export async function verifyDashboardConformanceFixtures(
  database: Queryable,
  repository: string,
  transport: DashboardConformanceTransport,
): Promise<{ scenarios: number; seedSteps: number; exchanges: number }> {
  const { fixtures, manifest } = await loadDashboardConformanceFixtures(repository);
  if (fixtures.contractVersion !== manifest.contractVersion) {
    throw new Error("conformance.json and manifest.json disagree on contractVersion");
  }
  let seedSteps = 0;
  let exchanges = 0;

  // One reference namespace spans the whole file: identifiers captured while seeding are cited
  // by exchanges in later scenarios, and mutation responses can be captured for follow-up reads.
  const references = new Map<string, JsonValue>();
  for (const scenario of fixtures.scenarios) {
    for (const step of scenario.seed ?? []) {
      seedSteps += 1;
      await executeConformanceSeedStep(database, scenario.id, step, references);
    }

    for (const exchange of scenario.exchanges ?? []) {
      exchanges += 1;
      const location = `${scenario.id}/${exchange.id}`;
      if (!(exchange.procedure in manifest.procedures)) {
        throw new Error(`${location} exercises unknown procedure ${exchange.procedure}`);
      }
      const body = resolveReferences(exchange.request, references);
      const request = conformanceExchangeRequest(fixtures.harness, exchange, body);
      const response = await transport.handle(exchange.mode ?? "writable", request);
      if (!response) throw new Error(`${location} was not answered by the dashboard backend`);
      try {
        if (response.status !== exchange.expect.status) {
          throw new Error(`expected status ${exchange.expect.status}, received ${response.status}`);
        }
        const actual = (await response.json()) as JsonValue;
        assertFixtureValue(exchange.expect.body, actual, `${location}.body`, references);
        for (const [name, pointer] of Object.entries(exchange.capture ?? {})) {
          references.set(name, readPointer(actual, pointer, location));
        }
      } catch (error) {
        throw annotate(error, location);
      }
    }
  }

  assertConformanceCoverage(fixtures, manifest);
  return { scenarios: fixtures.scenarios.length, seedSteps, exchanges };
}

/**
 * Require the fixtures to exercise the whole procedure surface: a successful exchange for every
 * procedure, plus the cross-origin rejection and read-only FORBIDDEN behavior for every mutation,
 * and at least one exchange for each error envelope status the contract names.
 */
function assertConformanceCoverage(
  fixtures: DashboardConformanceFixtures,
  manifest: DashboardManifest,
): void {
  const succeeded = new Set<string>();
  const crossRejected = new Set<string>();
  const readOnlyForbidden = new Set<string>();
  const errorStatuses = new Set<number>();

  for (const scenario of fixtures.scenarios) {
    for (const exchange of scenario.exchanges ?? []) {
      const mode = exchange.mode ?? "writable";
      const origin = exchange.origin ?? "same";
      const status = exchange.expect.status;
      if (status >= 400) errorStatuses.add(status);
      if (status < 300 && mode === "writable" && origin === "same") {
        succeeded.add(exchange.procedure);
      }
      if (status === 403 && mode === "writable" && origin !== "same") {
        crossRejected.add(exchange.procedure);
      }
      if (status === 403 && mode === "read-only" && origin === "same") {
        readOnlyForbidden.add(exchange.procedure);
      }
    }
  }

  const missing: string[] = [];
  for (const [name, { mutation }] of Object.entries(manifest.procedures)) {
    if (!succeeded.has(name)) missing.push(`${name} has no successful exchange`);
    if (mutation && !crossRejected.has(name)) {
      missing.push(`${name} has no cross-origin rejection exchange`);
    }
    if (mutation && !readOnlyForbidden.has(name)) {
      missing.push(`${name} has no read-only FORBIDDEN exchange`);
    }
  }
  for (const status of [400, 404, 405]) {
    if (!errorStatuses.has(status)) missing.push(`no exchange covers status ${status}`);
  }
  if (missing.length > 0) {
    throw new Error(`Dashboard conformance fixtures lack coverage:\n${missing.join("\n")}`);
  }
}

function toJson<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function annotate(error: unknown, location: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${location}: ${message}`, { cause: error });
}

async function readJson<T>(filename: string): Promise<T> {
  return JSON.parse(await readFile(filename, "utf8")) as T;
}
