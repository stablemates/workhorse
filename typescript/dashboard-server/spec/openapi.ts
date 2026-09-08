import type { DashboardRouter } from "../src/server/router.js";

/**
 * Compose the OpenAPI 3.1 description of `dashboard/v1` from the committed contract artifacts.
 *
 * The contract already exists three times over: `manifest.json` fixes the transport and the
 * procedure list, `procedures.json` types every request and response as JSON Schema 2020-12, and
 * `conformance.json` pins golden exchanges. None of those is what an HTTP client generator, an
 * API browser, or an agent reading `workhorse.run/openapi.json` expects. This module folds the
 * three into one OpenAPI document and adds the prose the artifacts leave out: what each procedure
 * is for, the error responses the host answers before a procedure runs, and one worked example
 * per operation.
 *
 * The document is derived, never edited. `composeDashboardSpec` in `generate.ts` emits it beside
 * the other artifacts, so `pnpm dashboard-spec:check` fails when the router, the fixtures, or the
 * descriptions here move without regenerating it. The only hand-written input is
 * `procedureDocs`, which the type system and a runtime check both hold to exactly the router's
 * procedure list.
 */

type Json = Record<string, unknown>;

interface ManifestProcedure {
  mutation: boolean;
}

export interface DashboardManifest {
  contractVersion: number;
  transport: { errorEnvelope: Json; requestContentType: string };
  authentication: Json;
  csrf: { mechanism: string; rule: string };
  procedures: Record<string, ManifestProcedure>;
}

export interface DashboardProcedures {
  procedures: Record<string, { path: string; input: Json | null; output: unknown }>;
  $defs: Record<string, Json>;
}

interface ConformanceExchange {
  id: string;
  procedure: string;
  request: unknown;
  method?: string;
  origin?: string;
  mode?: string;
  expect: { status: number; body: unknown };
}

export interface DashboardConformance {
  scenarios: { id: string; exchanges?: ConformanceExchange[] }[];
}

/** The prose one procedure needs beyond what its schemas say. */
export interface ProcedureDoc {
  /** One imperative clause; the operation's `summary`. */
  summary: string;
  /** What the procedure answers and what its inputs mean; the operation's `description`. */
  description: string;
  /** The `NOT_FOUND` message the procedure throws, when it throws one. */
  notFound?: string;
}

type ProcedureName = keyof DashboardRouter["dashboard"];

/**
 * What each procedure is for, verified against `router.ts` and `read-model.ts`.
 *
 * The key type is the router's own procedure list, so adding or removing a procedure fails to
 * compile here until this table follows; the generator repeats the check at runtime against
 * `manifest.json` so the committed artifact cannot disagree either.
 */
export const procedureDocs: Record<ProcedureName, ProcedureDoc> = {
  meta: {
    summary: "Identify the deployment",
    description:
      "Returns the environment name the host was configured with. Takes no input; send an empty envelope.",
  },
  taskCounts: {
    summary: "Count tasks per lifecycle filter",
    description:
      "Returns one count per task filter: all, queued, blocked, retried, running, waiting, canceled, completed, discarded, and scheduled. These are the numbers behind the task view's filter tabs. Takes no input.",
  },
  tasksCursor: {
    summary: "Browse tasks with a cursor",
    description:
      "Returns a task page with nextCursor and previousCursor. Pass a returned cursor unchanged with direction next or previous. Counts are omitted by default (total is null); count exact requests the full matching total. Ordering uses database timestamp precision. Live tasks can move between pages when their state changes.",
  },
  tasks: {
    summary: "List tasks, filtered and paged",
    description:
      "Returns one page of jobs matching filter, queue, worker, jobType, priority, tags, and search, sorted by updated or priority. page is 1-based and at most 100; pageSize is 25, 50, or 100. Payloads are never included; read one task with jobDetail. canCompleteHumanWait reports whether this deployment can complete human waits.",
  },
  taskFacets: {
    summary: "List the values the task filters offer",
    description:
      "Returns the distinct queues, workers (including configured workers not yet seen), job types, and tags observed in retained jobs. Takes no input.",
  },
  activity: {
    summary: "Bucket task activity over a period",
    description:
      "Returns time-bucketed counts for one task filter over a period of 15m, 1h, 6h, 24h, or 7d, grouped by queue, worker, task type, or status, optionally narrowed by tags, queue, and worker. bucketSeconds gives the width of each bucket.",
  },
  events: {
    summary: "List job events and attempts in a window",
    description:
      "Returns one page of job events and attempt outcomes within a window of 15m, 1h, 6h, or 24h, filterable by kind (event, attempt, or all), queue, jobType, event types, and one jobId. retention reports how far back events and attempts are kept.",
  },
  eventDetail: {
    summary: "Read one event or attempt",
    description:
      "Returns the full record for an id of the form event:<uuid> or attempt:<uuid>, including its details and, for attempts, timing and the error. Error stacks are redacted when the host asks for it.",
    notFound: "Event not found",
  },
  cron: {
    summary: "List schedules and maintenance loops",
    description:
      "Returns every schedule definition with its cron expression, enabled flag, and last and next occurrences, plus the cadences of the maintenance loops. Takes no input.",
  },
  queues: {
    summary: "List queues with their policies",
    description:
      "Returns every managed queue with its pause state, counts, concurrency and rate-limit policy summaries, and health reasons. concurrencyPoliciesCapped and rateLimitPoliciesCapped say when a policy list was truncated. Takes no input.",
  },
  system: {
    summary: "Report system health for a window",
    description:
      "Returns the health verdict with its reasons, KPIs, outcome buckets, per-queue rows, retry-storm and failing-type detection, and integrity checks for a window of 15m, 1h, or 24h.",
  },
  workers: {
    summary: "List registered workers",
    description:
      "Returns every worker registration with its heartbeat, slots, and attempt statistics, including configured workers that have not registered yet. canManageWorkers reports whether setWorkerPaused is available. Takes no input.",
  },
  settings: {
    summary: "Read maintenance and retention policy",
    description:
      "Returns the effective maintenance and retention policies with each setting's source (application default or dashboard override), the inputs behind the recommendations, and whether the policies are editable from this dashboard. Takes no input.",
  },
  previewRetentionPolicy: {
    summary: "Preview a retention change",
    description:
      "Returns the rows a retention definition would make eligible for pruning, per category, without applying it. Call it before overrideRetentionPolicy.",
  },
  jobDetail: {
    summary: "Read one task",
    description:
      "Returns one task's identity, lineage (dependencies, children, and redrives), concurrency policy, current attempt, attempts, checkpoints, waits, and events. The payload is redacted. canSignal reports whether signalTask is available for it.",
    notFound: "Task not found",
  },
  humanWaits: {
    summary: "List pending human decisions and signal waits",
    description:
      "Returns the tasks waiting on a human decision or a named signal, with diagnostics on pending and rejected deliveries. canComplete and canSignal report whether this deployment can complete a wait or deliver a signal. Takes no input.",
  },
  enqueueTest: {
    summary: "Enqueue a demonstration job",
    description:
      "Enqueues one demonstration job of the given kind on the demo queue and returns its jobId. feature is required when kind is feature. Available only where the host wires a demo operator; other deployments answer FORBIDDEN.",
  },
  setScheduleEnabled: {
    summary: "Enable or disable a schedule",
    description:
      "Flips the enabled flag of one user schedule identified by namespace and name and returns the resulting flag.",
  },
  setQueuePaused: {
    summary: "Pause or resume a queue",
    description:
      "Sets the pause flag of one queue and returns it. Workers do not claim from a paused queue.",
  },
  purgeQueue: {
    summary: "Purge a queue",
    description: "Deletes the queue's pending jobs and returns deletedCount.",
  },
  setWorkerPaused: {
    summary: "Pause or resume a worker",
    description: "Sets the pause flag of one worker registration and returns it.",
  },
  overrideMaintenancePolicy: {
    summary: "Override maintenance settings",
    description:
      "Overrides one or more maintenance settings for this deployment; at least one setting is required. Answers an empty body.",
  },
  revertMaintenancePolicy: {
    summary: "Revert maintenance settings",
    description:
      "Removes the dashboard override from the named maintenance settings so their application defaults apply again. Answers an empty body.",
  },
  overrideRetentionPolicy: {
    summary: "Override retention settings",
    description:
      "Overrides one or more retention settings for this deployment; at least one setting is required. Preview the effect with previewRetentionPolicy first. Answers an empty body.",
  },
  revertRetentionPolicy: {
    summary: "Revert retention settings",
    description:
      "Removes the dashboard override from the named retention settings so their application defaults apply again. Answers an empty body.",
  },
  runTaskNow: {
    summary: "Run a scheduled task now",
    description:
      "Releases a scheduled task immediately. status distinguishes released from already_ready, not_scheduled, and waiting.",
    notFound: "Task not found",
  },
  cancelTask: {
    summary: "Cancel a task",
    description:
      "Cancels one task. status is canceled for an immediate cancellation, cancel_requested when an active handler still has to observe it, or already_terminal when the task was left untouched. audit.reason is optional.",
    notFound: "Task not found",
  },
  signalTask: {
    summary: "Deliver a signal to a waiting task",
    description:
      "Delivers a named JSON payload to a task waiting on that signal, under an idempotencyKey. status is delivered, duplicate, already_delivered, not_waiting, or stale.",
    notFound: "Task not found",
  },
  completeHumanWait: {
    summary: "Complete a human decision",
    description:
      "Records the result of a named human wait under an idempotencyKey. status is completed, duplicate, already_completed, not_waiting, or stale.",
    notFound: "Task not found",
  },
  redriveTask: {
    summary: "Redrive one dead letter",
    description:
      "Enqueues a fresh copy of one retained terminal failure; the source stays failed. status is redriven for a new task, replayed for a request already applied under the same identity, not_failed, or eligible.",
    notFound: "Task not found",
  },
  redriveDeadLetters: {
    summary: "Redrive a page of dead letters",
    description:
      "Redrives up to limit dead letters matching queue, jobType, and tags, resuming from cursor. Every result is reported, including the sources PostgreSQL refused; nextCursor continues from where this page stopped.",
  },
};

const errorEnvelopeName = "ErrorEnvelope";
const hostErrorName = "HostError";
const validationIssueName = "ValidationIssue";
const jsonDefinitionName = "DashboardJson";
const localJsonDefinition = "__schema0";
const schemaPrefix = "#/components/schemas/";
const placeholderUuid = "00000000-0000-7000-8000-000000000000";
const placeholderTimestamp = "2026-01-01T00:00:00.000Z";
const operationIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;

const envelopeCodes = [
  "BAD_REQUEST",
  "FORBIDDEN",
  "NOT_FOUND",
  "METHOD_NOT_SUPPORTED",
  "INTERNAL_SERVER_ERROR",
];

const ref = (name: string): Json => ({ $ref: `${schemaPrefix}${name}` });

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Move one `procedures.json` schema into the OpenAPI components namespace.
 *
 * `z.toJSONSchema` writes each input as a standalone document: a `$schema` on the root and, for
 * the two inputs that accept arbitrary JSON, a local `$defs.__schema0`. OpenAPI holds every schema
 * under `#/components/schemas`, so the root keywords go and every reference is redirected there,
 * with the local JSON copy pointing at the shared definition the bindings already use.
 */
function rewriteSchema(schema: Json, location: string): Json {
  const { $schema: _dialect, $defs, ...rest } = schema;
  if ($defs !== undefined) {
    const names = isJson($defs) ? Object.keys($defs) : [];
    if (names.length !== 1 || names[0] !== localJsonDefinition) {
      throw new Error(
        `${location} nests $defs ${names.join(", ") || "of an unexpected shape"}; only ${localJsonDefinition} is known`,
      );
    }
  }
  return rewriteReferences(rest, location) as Json;
}

function rewriteReferences(value: unknown, location: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => rewriteReferences(entry, location));
  if (!isJson(value)) return value;
  const result: Json = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$ref" && typeof entry === "string") {
      result[key] = rewriteReference(entry, location);
    } else if (key === "const" || key === "enum" || key === "default" || key === "examples") {
      result[key] = entry;
    } else {
      result[key] = rewriteReferences(entry, location);
    }
  }
  return result;
}

function rewriteReference(reference: string, location: string): string {
  const match = /^#\/\$defs\/([^/]+)$/.exec(reference);
  if (!match) throw new Error(`${location} references ${reference}, which is not a $defs entry`);
  const name = match[1] === localJsonDefinition ? jsonDefinitionName : match[1]!;
  return `${schemaPrefix}${name}`;
}

/** Replace the fixture matchers with fixed placeholder values so an example is plain JSON. */
function concreteExample(value: unknown, location: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => concreteExample(entry, location));
  if (!isJson(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "$ref" && typeof value.$ref === "string") {
    return capturePlaceholder(value.$ref, location);
  }
  if (keys.length === 1 && keys[0] === "$type" && typeof value.$type === "string") {
    return typePlaceholder(value.$type, location);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, concreteExample(entry, location)]),
  );
}

function capturePlaceholder(name: string, location: string): unknown {
  if (name.endsWith("Job")) return placeholderUuid;
  if (name.endsWith("Fence")) return 1;
  // The one non-job capture is an event id, `event:<uuid>`, taken from the events page.
  if (name === "eventDetailId") return `event:${placeholderUuid}`;
  throw new Error(`${location} cites capture ${name}, whose placeholder is unknown`);
}

function typePlaceholder(type: string, location: string): unknown {
  switch (type) {
    case "timestamp":
      return placeholderTimestamp;
    case "uuid":
      return placeholderUuid;
    case "integer":
    case "number":
      return 0;
    case "string":
      return "string";
    case "boolean":
      return false;
    case "any":
      return null;
    default:
      throw new Error(`${location} uses matcher $type ${type}, whose placeholder is unknown`);
  }
}

const placeholderNote =
  "Taken from conformance.json. Generated identifiers, timestamps, and measurements are replaced by placeholders: " +
  `${placeholderUuid} stands for a UUID, ${placeholderTimestamp} for a timestamp, 0 and "string" for a measured number or text.`;

function example(exchange: ConformanceExchange, value: unknown, summary: string): Json {
  return {
    summary,
    description: `${placeholderNote} Fixture: ${exchange.id}.`,
    value: concreteExample(value, `conformance exchange ${exchange.id}`),
  };
}

/**
 * The fixture that stands in for a procedure's happy path: its shortest successful exchange in
 * the writable, same-origin deployment. Error fixtures are found by what they exercise rather
 * than by id, so a renamed fixture keeps the document generating.
 */
function successExchange(
  exchanges: readonly ConformanceExchange[],
  procedure: string,
): ConformanceExchange {
  let chosen: ConformanceExchange | undefined;
  let chosenSize = Number.POSITIVE_INFINITY;
  for (const exchange of exchanges) {
    if (exchange.procedure !== procedure || exchange.expect.status !== 200) continue;
    if ((exchange.mode ?? "writable") !== "writable") continue;
    if ((exchange.origin ?? "same") !== "same" || exchange.method !== undefined) continue;
    const size = JSON.stringify(exchange.expect.body).length;
    if (size < chosenSize) {
      chosen = exchange;
      chosenSize = size;
    }
  }
  if (!chosen) throw new Error(`conformance.json has no successful exchange for ${procedure}`);
  return chosen;
}

function errorExchange(
  exchanges: readonly ConformanceExchange[],
  status: number,
  mode: string,
  origin: string,
): ConformanceExchange {
  const found = exchanges.find(
    (exchange) =>
      exchange.expect.status === status &&
      (exchange.mode ?? "writable") === mode &&
      (exchange.origin ?? "same") === origin,
  );
  if (!found) {
    throw new Error(`conformance.json has no ${status} exchange in mode ${mode}, origin ${origin}`);
  }
  return found;
}

/** The error envelope narrowed to one code and status. */
function envelopeOf(code: string, status: number, data?: Json): Json {
  const json: Json = {
    type: "object",
    properties: {
      code: { const: code },
      status: { const: status },
      ...(data ? { data } : {}),
    },
  };
  return {
    allOf: [ref(errorEnvelopeName), { type: "object", properties: { json } }],
  };
}

function jsonResponse(description: string, schema: Json, examples: Record<string, Json>): Json {
  return {
    description,
    content: { "application/json": { schema, examples } },
  };
}

function hostExample(summary: string, message: string): Json {
  return { summary, value: { error: message } };
}

function envelopeExample(summary: string, code: string, status: number, message: string): Json {
  return { summary, value: { json: { defined: false, code, status, message } } };
}

interface OpenApiInput {
  manifest: DashboardManifest;
  procedures: DashboardProcedures;
  conformance: DashboardConformance;
  /** The procedure prose; defaults to `procedureDocs`. Exposed so a test can hand in a wrong table. */
  docs?: Record<string, ProcedureDoc>;
}

/** Compose `openapi.json` as its exact file content. */
export function composeDashboardOpenApi({
  manifest,
  procedures,
  conformance,
  docs = procedureDocs,
}: OpenApiInput): string {
  const names = Object.keys(manifest.procedures);
  const missing = names.filter((name) => !(name in docs));
  const orphaned = Object.keys(docs).filter((name) => !(name in manifest.procedures));
  if (missing.length > 0 || orphaned.length > 0) {
    throw new Error(
      `procedureDocs and the manifest disagree: missing ${missing.join(", ") || "none"}; ` +
        `orphaned ${orphaned.join(", ") || "none"}`,
    );
  }
  const untyped = names.filter((name) => !(name in procedures.procedures));
  if (untyped.length > 0) {
    throw new Error(`procedures.json lacks ${untyped.join(", ")}`);
  }

  const exchanges = conformance.scenarios.flatMap((scenario) => scenario.exchanges ?? []);

  const schemas: Record<string, Json> = {};
  for (const [name, definition] of Object.entries(procedures.$defs)) {
    schemas[name] = rewriteSchema(definition, `$defs.${name}`);
  }
  const handWritten: Record<string, Json> = {
    [errorEnvelopeName]: {
      ...rewriteSchema(manifest.transport.errorEnvelope, "manifest.transport.errorEnvelope"),
      description:
        "The body of every failed procedure call, under the same json key as a success. " +
        `code is one of ${envelopeCodes.join(", ")}; status repeats the HTTP status. ` +
        "Errors the host answers before a procedure runs use HostError instead.",
    },
    [hostErrorName]: {
      type: "object",
      description:
        "The body the host answers before a procedure runs: authorization, workspace resolution, schema compatibility, and the same-origin check.",
      properties: { error: { type: "string" } },
      required: ["error"],
      additionalProperties: false,
    },
    [validationIssueName]: {
      type: "object",
      description:
        "One input validation failure, as the request schema reports it. Keys beyond these three depend on the failed rule.",
      properties: {
        code: { type: "string" },
        path: { type: "array", items: { type: ["string", "integer"] } },
        message: { type: "string" },
      },
      required: ["code", "path", "message"],
    },
  };
  for (const name of Object.keys(handWritten)) {
    if (name in schemas) throw new Error(`$defs already defines ${name}`);
  }
  Object.assign(schemas, handWritten);

  const badRequest = errorExchange(exchanges, 400, "writable", "same");
  const notFound = errorExchange(exchanges, 404, "writable", "same");
  const methodNotSupported = errorExchange(exchanges, 405, "writable", "same");
  const crossOrigin = errorExchange(exchanges, 403, "writable", "cross");
  const readOnly = errorExchange(exchanges, 403, "read-only", "same");

  const responses: Record<string, Json> = {
    BadRequest: jsonResponse(
      "The envelope is malformed or the input failed the request schema. data.issues lists the failures when the schema produced them.",
      envelopeOf("BAD_REQUEST", 400, {
        type: "object",
        properties: { issues: { type: "array", items: ref(validationIssueName) } },
      }),
      { validation: example(badRequest, badRequest.expect.body, "Input rejected by the schema") },
    ),
    Unauthorized: jsonResponse(
      "No authenticated principal: the host's authorization rejected the request, or no single-admin session cookie was presented.",
      ref(hostErrorName),
      { unauthenticated: hostExample("No session", "Unauthorized") },
    ),
    Forbidden: jsonResponse(
      "The host's authorization refused the authenticated principal.",
      ref(hostErrorName),
      { forbidden: hostExample("Principal refused", "Forbidden") },
    ),
    MutationForbidden: jsonResponse(
      "Three refusals share this status. HostError bodies: the host's authorization refused the principal, or the same-origin check failed. " +
        `${manifest.csrf.rule} ` +
        "Envelope body: the deployment is read-only, or the host wires no controller for this mutation.",
      { oneOf: [ref(hostErrorName), envelopeOf("FORBIDDEN", 403)] },
      {
        crossOrigin: example(crossOrigin, crossOrigin.expect.body, "Origin does not match"),
        readOnly: example(readOnly, readOnly.expect.body, "Read-only deployment"),
        forbidden: hostExample("Principal refused", "Forbidden"),
      },
    ),
    NotFound: jsonResponse(
      "Envelope body: the procedure found no record for the given id. HostError body: the first path segment names no configured workspace.",
      { oneOf: [envelopeOf("NOT_FOUND", 404), ref(hostErrorName)] },
      {
        missingRecord: example(notFound, notFound.expect.body, "No record for the id"),
        unknownWorkspace: hostExample("Unknown workspace", "Unknown dashboard workspace"),
      },
    ),
    UnknownWorkspace: jsonResponse(
      "The first path segment names no configured workspace. This procedure never answers NOT_FOUND itself.",
      ref(hostErrorName),
      { unknownWorkspace: hostExample("Unknown workspace", "Unknown dashboard workspace") },
    ),
    MethodNotSupported: jsonResponse(
      "The path was requested with a method other than POST.",
      envelopeOf("METHOD_NOT_SUPPORTED", 405),
      {
        get: example(methodNotSupported, methodNotSupported.expect.body, "GET on a procedure path"),
      },
    ),
    InternalServerError: jsonResponse(
      "The procedure failed unexpectedly. The message carries no stack trace.",
      envelopeOf("INTERNAL_SERVER_ERROR", 500),
      {
        failure: envelopeExample(
          "Unexpected failure",
          "INTERNAL_SERVER_ERROR",
          500,
          "Internal server error",
        ),
      },
    ),
    SchemaIncompatible: jsonResponse(
      "The installed Workhorse schema is incompatible with this server; the message names the mismatch.",
      ref(hostErrorName),
      { incompatible: hostExample("Schema mismatch", "Incompatible Workhorse schema") },
    ),
  };

  const paths: Record<string, Json> = {};
  for (const name of names) {
    const { mutation } = manifest.procedures[name]!;
    const contract = procedures.procedures[name]!;
    const doc = docs[name]!;
    const operationId = `dashboard_${name}`;
    if (!operationIdPattern.test(operationId)) {
      throw new Error(`${operationId} is not a valid operationId`);
    }
    const fixture = successExchange(exchanges, name);

    const requestSchema: Json = contract.input
      ? {
          type: "object",
          properties: { json: rewriteSchema(contract.input, `${name}.input`) },
          required: ["json"],
        }
      : {
          type: "object",
          description: "An empty envelope; the procedure takes no input.",
          properties: {},
        };
    const responseSchema: Json =
      contract.output === null
        ? {
            type: "object",
            description: "The procedure produces no result and answers an empty object.",
            properties: {},
            additionalProperties: false,
          }
        : {
            type: "object",
            properties: {
              json: rewriteReferences(contract.output, `${name}.output`) as Json,
            },
            required: ["json"],
          };

    const description = doc.notFound
      ? `${doc.description} Answers NOT_FOUND with the message "${doc.notFound}" when the id matches nothing.`
      : doc.description;

    paths[contract.path] = {
      post: {
        operationId,
        summary: doc.summary,
        description,
        tags: [mutation ? "mutations" : "reads"],
        "x-workhorse-mutation": mutation,
        requestBody: {
          required: true,
          content: {
            [manifest.transport.requestContentType]: {
              schema: requestSchema,
              examples: { conformance: example(fixture, fixture.request, "Request") },
            },
          },
        },
        responses: {
          "200": {
            description: contract.output === null ? "Applied." : "The procedure's result.",
            content: {
              "application/json": {
                schema: responseSchema,
                examples: { conformance: example(fixture, fixture.expect.body, "Response") },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": {
            $ref: `#/components/responses/${mutation ? "MutationForbidden" : "Forbidden"}`,
          },
          "404": {
            $ref: `#/components/responses/${doc.notFound ? "NotFound" : "UnknownWorkspace"}`,
          },
          "405": { $ref: "#/components/responses/MethodNotSupported" },
          "500": { $ref: "#/components/responses/InternalServerError" },
          "503": { $ref: "#/components/responses/SchemaIncompatible" },
        },
      },
    };
  }

  const document = {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "Workhorse dashboard API",
      version: String(manifest.contractVersion),
      summary: "The RPC procedures behind the embedded Workhorse dashboard, contract dashboard/v1.",
      description:
        "This API is served by your own Workhorse deployment at {origin}{basePath}, never by workhorse.run, which publishes only this document. " +
        "Workhorse's primary protocol is SQL (ADR 0023): applications enqueue and work jobs through PostgreSQL, and these procedures are the operator surface the dashboard consumes, not an ingress API for application traffic. " +
        "Every procedure is one POST with a JSON envelope; the path carries the contract's major version, and a breaking change creates dashboard/v2 instead of moving a package major (ADR 0054). " +
        "Reads go through the versioned dashboard_*_v1 SQL views and mutations through the shared versioned SQL functions, so any backend bound by this contract answers the same shapes. " +
        "The document is generated from the committed dashboard/v1 artifacts (manifest.json, procedures.json, conformance.json) by pnpm dashboard-spec:generate and checked by pnpm dashboard-spec:check, so it cannot drift from the router.",
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
      contact: { name: "Workhorse", url: "https://github.com/stablemates/workhorse/issues" },
    },
    externalDocs: {
      description: "The dashboard/v1 wire contract",
      url: "https://github.com/stablemates/workhorse/tree/main/dashboard/v1",
    },
    servers: [
      {
        url: "{origin}{basePath}",
        description: "The deployment that embeds the dashboard.",
        variables: {
          origin: {
            default: "https://app.example.com",
            description: "The scheme and host of the application serving the dashboard.",
          },
          basePath: {
            default: "/workhorse",
            description:
              "The dashboard mount path: /workhorse by default, an empty string when the dashboard owns the host root, or {path}/{workspace} when the host serves named workspaces.",
          },
        },
      },
    ],
    tags: [
      {
        name: "reads",
        description:
          "Procedures that read the versioned dashboard views. They accept any Origin and are served by read-only deployments.",
      },
      {
        name: "mutations",
        description:
          "Procedures that change state through the shared versioned SQL functions. They require a same-origin request, a writable deployment, and a host that wires the matching controller; each carries an audit block whose actor the server replaces with the authenticated principal.",
      },
    ],
    security: [{ dashboardSession: [] }],
    "x-workhorse-authentication": manifest.authentication,
    paths,
    components: {
      securitySchemes: {
        dashboardSession: {
          type: "apiKey",
          in: "cookie",
          name: "__Host-workhorse-dashboard-session",
          description:
            "Authorization is delegated to the host application, which may accept any credential it recognizes. " +
            "A deployment without a host authorizer runs the built-in single-admin session instead: POST {basePath}/login with a form body of username and password sets this cookie, and POST {basePath}/logout clears it. " +
            "An unauthenticated request answers 401 and an unauthorized one 403, both with a HostError body.",
        },
      },
      schemas,
      responses,
    },
  };

  return `${JSON.stringify(document, null, 2)}\n`;
}
