import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseTestHarness } from "../../../core/test/support/db.js";
import {
  conformanceExchangeRequest,
  executeConformanceSeedStep,
  readPointer,
  resolveReferences,
  type DashboardConformanceExchange,
  type DashboardConformanceFixtures,
  type JsonValue,
} from "../../../../scripts/verify-dashboard-conformance.js";
import { createDashboardConformanceTransport } from "./conformance-harness.js";

/**
 * Regenerate the `expect` blocks of `dashboard/v1/conformance.json` from the reference server.
 *
 * The fixture file itself authors the seed, the exchanges, and their requests; this tool replays
 * them twice against two freshly installed databases and records each response. A value identical
 * across both runs is committed literally; a value that differs is nondeterministic by
 * construction and becomes a `$type` matcher (or a `$ref` when both runs returned an identifier
 * captured earlier). Per-exchange `coerce` entries force matchers onto values that happen to be
 * stable on one machine but are environment- or time-dependent. Review the diff like any contract
 * change: `pnpm dashboard-conformance:generate`.
 */

type RawExchange = Omit<DashboardConformanceExchange, "expect"> & {
  expect?: DashboardConformanceExchange["expect"];
};
type RawFixtures = Omit<DashboardConformanceFixtures, "scenarios"> & {
  scenarios: {
    id: string;
    seed?: DashboardConformanceFixtures["scenarios"][number]["seed"];
    exchanges?: RawExchange[];
  }[];
};

interface RecordedExchange {
  status: number;
  body: JsonValue;
  references: Map<string, JsonValue>;
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const fixturePath = path.join(repository, "dashboard", "v1", "conformance.json");

async function recordRun(
  runId: string,
  fixtures: RawFixtures,
): Promise<Map<string, RecordedExchange>> {
  const database = createDatabaseTestHarness(new URL(`?${runId}`, import.meta.url).href);
  await database.setup();
  try {
    const transport = createDashboardConformanceTransport(database.pool, fixtures.harness);
    const references = new Map<string, JsonValue>();
    const records = new Map<string, RecordedExchange>();
    for (const scenario of fixtures.scenarios) {
      for (const step of scenario.seed ?? []) {
        await executeConformanceSeedStep(database.pool, scenario.id, step, references);
      }
      for (const exchange of scenario.exchanges ?? []) {
        const location = `${scenario.id}/${exchange.id}`;
        const body = resolveReferences(exchange.request, references);
        const request = conformanceExchangeRequest(fixtures.harness, exchange, body);
        const response = await transport.handle(exchange.mode ?? "writable", request);
        if (!response) throw new Error(`${location} was not answered by the reference server`);
        const actual = (await response.json()) as JsonValue;
        records.set(location, {
          status: response.status,
          body: actual,
          references: new Map(references),
        });
        for (const [name, pointer] of Object.entries(exchange.capture ?? {})) {
          references.set(name, readPointer(actual, pointer, location));
        }
      }
    }
    return records;
  } finally {
    await database.teardown();
  }
}

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function coercionFor(coerce: Record<string, string>, pointer: string): string | undefined {
  const segments = pointer.split(".");
  for (const [pattern, matcher] of Object.entries(coerce)) {
    const patternSegments = pattern.split(".");
    if (patternSegments.length !== segments.length) continue;
    if (patternSegments.every((segment, index) => segment === "*" || segment === segments[index])) {
      return matcher;
    }
  }
  return undefined;
}

function referenceName(
  first: JsonValue,
  second: JsonValue,
  firstReferences: Map<string, JsonValue>,
  secondReferences: Map<string, JsonValue>,
): string | undefined {
  if (typeof first !== "string" || first.length < 16) return undefined;
  for (const [name, value] of firstReferences) {
    if (value === first && secondReferences.get(name) === second) return name;
  }
  return undefined;
}

function mergeExpected(
  first: JsonValue,
  second: JsonValue,
  firstReferences: Map<string, JsonValue>,
  secondReferences: Map<string, JsonValue>,
  coerce: Record<string, string>,
  pointer: string,
): JsonValue {
  // A coercion forces a matcher onto a measurement that is stable across two idle runs but not
  // under load. Null is not such a measurement: it says the field has no value, and replacing it
  // with a type matcher would both lose that meaning and reject the null on verification. Both
  // runs agreeing on null is agreement, not luck.
  const forced = first === null && second === null ? undefined : coercionFor(coerce, pointer);
  if (forced) return { $type: forced };
  const reference = referenceName(first, second, firstReferences, secondReferences);
  if (reference) return { $ref: reference };
  if (Array.isArray(first) || Array.isArray(second)) {
    if (!Array.isArray(first) || !Array.isArray(second) || first.length !== second.length) {
      throw new Error(`${pointer}: array shape differs between runs; adjust the seed or coerce`);
    }
    return first.map((item, index) =>
      mergeExpected(
        item,
        second[index]!,
        firstReferences,
        secondReferences,
        coerce,
        `${pointer}.${index}`,
      ),
    );
  }
  if (
    first !== null &&
    second !== null &&
    typeof first === "object" &&
    typeof second === "object"
  ) {
    const firstKeys = Object.keys(first).toSorted();
    const secondKeys = Object.keys(second).toSorted();
    if (JSON.stringify(firstKeys) !== JSON.stringify(secondKeys)) {
      throw new Error(
        `${pointer}: object keys differ between runs (${firstKeys} vs ${secondKeys})`,
      );
    }
    return Object.fromEntries(
      Object.entries(first).map(([key, item]) => [
        key,
        mergeExpected(
          item,
          (second as Record<string, JsonValue>)[key]!,
          firstReferences,
          secondReferences,
          coerce,
          `${pointer}.${key}`,
        ),
      ]),
    );
  }
  if (first === second) return first;
  if (typeof first === "string" && typeof second === "string") {
    if (uuidPattern.test(first) && uuidPattern.test(second)) return { $type: "uuid" };
    if (timestampPattern.test(first) && timestampPattern.test(second)) {
      return { $type: "timestamp" };
    }
    return { $type: "string" };
  }
  if (typeof first === "number" && typeof second === "number") {
    return { $type: Number.isInteger(first) && Number.isInteger(second) ? "integer" : "number" };
  }
  if (typeof first === "boolean" && typeof second === "boolean") return { $type: "boolean" };
  throw new Error(
    `${pointer}: value differs in type between runs (${JSON.stringify(first)} vs ${JSON.stringify(second)})`,
  );
}

const fixtures = JSON.parse(await readFile(fixturePath, "utf8")) as RawFixtures;
const firstRun = await recordRun("conformance-record-a", fixtures);
const secondRun = await recordRun("conformance-record-b", fixtures);

for (const scenario of fixtures.scenarios) {
  for (const exchange of scenario.exchanges ?? []) {
    const location = `${scenario.id}/${exchange.id}`;
    const first = firstRun.get(location)!;
    const second = secondRun.get(location)!;
    if (first.status !== second.status) {
      throw new Error(
        `${location}: status differs between runs (${first.status} vs ${second.status})`,
      );
    }
    exchange.expect = {
      status: first.status,
      body: mergeExpected(
        first.body,
        second.body,
        first.references,
        second.references,
        exchange.coerce ?? {},
        "body",
      ),
    };
    console.log(`${location} -> ${first.status}`);
  }
}

await writeFile(fixturePath, `${JSON.stringify(fixtures, null, 2)}\n`);
console.log(`wrote ${fixturePath}`);
