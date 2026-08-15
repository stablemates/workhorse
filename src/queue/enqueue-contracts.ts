import { databaseErrorCode, databaseErrorDetails, WorkhorseError } from "../errors.js";
import { injectTraceContext, logDebug, telemetryMetrics, withSpan } from "../telemetry.js";
import type {
  ClaimedJob,
  EnqueueIdempotency,
  EnqueueIdempotencyConflictDetails,
  EnqueueIdempotencyConflictField,
  EnqueueOptions,
  EnqueueOutcome,
  EnqueueRequest,
  EnqueueResult,
  JobContractVersion,
  Json,
  Queryable,
  QueueOptions,
} from "../types.js";
import {
  DEFAULT_IDEMPOTENCY_SCOPE,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  DEFAULT_JOB_VALUE_MAX_BYTES,
  MAX_ENQUEUE_BATCH_SIZE,
  MAX_JOB_CONTRACT_SENSITIVE_KEYS,
  MAX_JOB_PRIORITY,
  MAX_JOB_VALUE_MAX_BYTES,
} from "../types.js";
import { QueueModule } from "./module-context.js";

/** The same scoped enqueue key is still retained for a materially different request. */
export class EnqueueIdempotencyConflictError extends WorkhorseError {
  constructor(readonly details: EnqueueIdempotencyConflictDetails) {
    super(
      `Enqueue idempotency conflict in scope ${details.scope} for key ${details.keyPreview} (${details.keyDigest}); fields: ${details.conflictingFields.join(", ")}`,
    );
    this.name = "EnqueueIdempotencyConflictError";
  }

  get scope(): string {
    return this.details.scope;
  }
  get keyPreview(): string {
    return this.details.keyPreview;
  }
  get keyDigest(): string {
    return this.details.keyDigest;
  }
  get keyLength(): number {
    return this.details.keyLength;
  }
  get existingJobId(): string {
    return this.details.existingJobId;
  }
  get ordinal(): number {
    return this.details.ordinal;
  }
  get conflictingFields(): EnqueueIdempotencyConflictField[] {
    return this.details.conflictingFields;
  }
  get storedRequestDigest(): string {
    return this.details.storedRequestDigest;
  }
  get rejectedRequestDigest(): string {
    return this.details.rejectedRequestDigest;
  }
}

export class JobContractValidationError extends WorkhorseError {
  constructor(
    readonly jobType: string,
    readonly contractVersion: string,
    readonly valueKind: "payload" | "result",
  ) {
    super(`${jobType} ${valueKind} does not satisfy contract version ${contractVersion}`);
    this.name = "JobContractValidationError";
  }
}

export class JobValueSizeLimitError extends WorkhorseError {
  constructor(
    readonly jobType: string,
    readonly valueKind: "payload" | "result",
    readonly actualBytes: number,
    readonly maxBytes: number,
  ) {
    super(`${jobType} ${valueKind} exceeds its configured size limit`);
    this.name = "JobValueSizeLimitError";
  }
}

export class JobContractUnavailableError extends WorkhorseError {
  constructor(
    readonly jobType: string,
    readonly contractVersion: string,
  ) {
    super(`${jobType} contract version ${contractVersion} is not configured in this process`);
    this.name = "JobContractUnavailableError";
  }
}

const enqueueConflictFields = new Set<EnqueueIdempotencyConflictField>([
  "queue",
  "type",
  "payload",
  "priority",
  "concurrencyKey",
  "contractVersion",
  "payloadMaxBytes",
  "resultMaxBytes",
  "sensitivePayloadKeys",
  "sensitiveResultKeys",
  "tags",
  "runAt",
  "deadline",
  "executionTimeoutMs",
  "maxAttempts",
  "retryPolicy",
  "ttlMs",
]);
const enqueueConflictDetailKeys = new Set([
  "scope",
  "keyPreview",
  "keyDigest",
  "keyLength",
  "existingJobId",
  "ordinal",
  "conflictingFields",
  "storedRequestDigest",
  "rejectedRequestDigest",
]);

const sanitizedEnqueueConflictDetails: EnqueueIdempotencyConflictDetails = {
  scope: "unknown",
  keyPreview: "unknown",
  keyDigest: "000000000000",
  keyLength: 0,
  existingJobId: "unknown",
  ordinal: 0,
  conflictingFields: [],
  storedRequestDigest: "0".repeat(64),
  rejectedRequestDigest: "0".repeat(64),
};

function validEnqueueConflictDetails(value: unknown): value is EnqueueIdempotencyConflictDetails {
  if (typeof value !== "object" || value === null) return false;
  const detail = value as Record<string, unknown>;
  const keys = Object.keys(detail);
  return (
    keys.length === enqueueConflictDetailKeys.size &&
    keys.every((key) => enqueueConflictDetailKeys.has(key)) &&
    typeof detail.scope === "string" &&
    detail.scope.length > 0 &&
    [...detail.scope].length <= 256 &&
    typeof detail.keyPreview === "string" &&
    detail.keyPreview.length > 0 &&
    [...detail.keyPreview].length <= 16 &&
    typeof detail.keyDigest === "string" &&
    /^[0-9a-f]{12}$/.test(detail.keyDigest) &&
    typeof detail.keyLength === "number" &&
    Number.isSafeInteger(detail.keyLength) &&
    detail.keyLength >= 1 &&
    detail.keyLength <= 512 &&
    typeof detail.existingJobId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      detail.existingJobId,
    ) &&
    typeof detail.ordinal === "number" &&
    Number.isSafeInteger(detail.ordinal) &&
    detail.ordinal >= 1 &&
    detail.ordinal <= MAX_ENQUEUE_BATCH_SIZE &&
    Array.isArray(detail.conflictingFields) &&
    detail.conflictingFields.length > 0 &&
    detail.conflictingFields.every(
      (field): field is EnqueueIdempotencyConflictField =>
        typeof field === "string" &&
        enqueueConflictFields.has(field as EnqueueIdempotencyConflictField),
    ) &&
    new Set(detail.conflictingFields).size === detail.conflictingFields.length &&
    detail.conflictingFields.every(
      (field, index, fields) => index === 0 || fields[index - 1]! < field,
    ) &&
    typeof detail.storedRequestDigest === "string" &&
    /^[0-9a-f]{64}$/.test(detail.storedRequestDigest) &&
    typeof detail.rejectedRequestDigest === "string" &&
    /^[0-9a-f]{64}$/.test(detail.rejectedRequestDigest)
  );
}

function enqueueConflict(error: unknown): EnqueueIdempotencyConflictError | null {
  if (databaseErrorCode(error) !== "P1001") return null;
  for (const detail of databaseErrorDetails(error)) {
    try {
      const parsed: unknown = JSON.parse(detail);
      if (validEnqueueConflictDetails(parsed)) return new EnqueueIdempotencyConflictError(parsed);
    } catch {
      // PostgreSQL's DETAIL may sit behind an adapter wrapper's own detail string.
    }
  }
  return new EnqueueIdempotencyConflictError(sanitizedEnqueueConflictDetails);
}

function validateValueLimit(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_JOB_VALUE_MAX_BYTES) {
    throw new RangeError(`${field} must be an integer between 1 and ${MAX_JOB_VALUE_MAX_BYTES}`);
  }
  return value;
}

export function validateJobPriority(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_JOB_PRIORITY) {
    throw new RangeError(`priority must be an integer between 0 and ${MAX_JOB_PRIORITY}`);
  }
  return value;
}

function validateSensitiveKeys(keys: readonly string[] | undefined, field: string): void {
  if (keys === undefined) return;
  if (keys.length > MAX_JOB_CONTRACT_SENSITIVE_KEYS) {
    throw new RangeError(`${field} accepts at most ${MAX_JOB_CONTRACT_SENSITIVE_KEYS} keys`);
  }
  if (new Set(keys).size !== keys.length) throw new TypeError(`${field} must contain unique keys`);
  for (const key of keys) {
    const characters = typeof key === "string" ? [...key].length : 0;
    if (characters < 1 || characters > 200) {
      throw new TypeError(`${field} keys must contain 1 to 200 characters`);
    }
  }
}

export function validateQueueOptions(options: QueueOptions): QueueOptions {
  validateValueLimit(options.defaultMaxPayloadBytes, "defaultMaxPayloadBytes");
  validateValueLimit(options.defaultMaxResultBytes, "defaultMaxResultBytes");
  for (const [jobType, typeContracts] of Object.entries(options.contracts ?? {})) {
    if ([...jobType].length === 0) throw new TypeError("contract job types must be non-empty");
    if (
      [...typeContracts.currentVersion].length < 1 ||
      [...typeContracts.currentVersion].length > 100 ||
      !(typeContracts.currentVersion in typeContracts.versions)
    ) {
      throw new TypeError(
        `contract ${jobType} currentVersion must name a configured version of 1 to 100 characters`,
      );
    }
    for (const [version, contract] of Object.entries(typeContracts.versions)) {
      if ([...version].length < 1 || [...version].length > 100) {
        throw new TypeError(`contract ${jobType} versions must contain 1 to 100 characters`);
      }
      validateValueLimit(contract.maxPayloadBytes, `${jobType}.${version}.maxPayloadBytes`);
      validateValueLimit(contract.maxResultBytes, `${jobType}.${version}.maxResultBytes`);
      validateSensitiveKeys(
        contract.sensitivePayloadKeys,
        `${jobType}.${version}.sensitivePayloadKeys`,
      );
      validateSensitiveKeys(
        contract.sensitiveResultKeys,
        `${jobType}.${version}.sensitiveResultKeys`,
      );
      if (
        contract.validatePayload !== undefined &&
        typeof contract.validatePayload !== "function"
      ) {
        throw new TypeError(`${jobType}.${version}.validatePayload must be a function`);
      }
      if (contract.validateResult !== undefined && typeof contract.validateResult !== "function") {
        throw new TypeError(`${jobType}.${version}.validateResult must be a function`);
      }
    }
  }
  return options;
}

function validateContractValue(
  jobType: string,
  version: string,
  kind: "payload" | "result",
  value: Json,
  contract: JobContractVersion,
  maxBytes: number,
): void {
  const validator = kind === "payload" ? contract.validatePayload : contract.validateResult;
  if (validator !== undefined) {
    let accepted = false;
    try {
      accepted = validator(value);
    } catch {
      accepted = false;
    }
    if (!accepted) throw new JobContractValidationError(jobType, version, kind);
  }
  enforceJsonSize(jobType, kind, value, maxBytes);
}

function enforceJsonSize(
  jobType: string,
  kind: "payload" | "result",
  value: Json,
  maxBytes: number,
): void {
  const actualBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (actualBytes > maxBytes) {
    throw new JobValueSizeLimitError(jobType, kind, actualBytes, maxBytes);
  }
}

interface JobAcceptance {
  contractVersion: string | null;
  payloadMaxBytes: number;
  resultMaxBytes: number;
  sensitivePayloadKeys: readonly string[];
  sensitiveResultKeys: readonly string[];
}

/** Owns enqueue serialization and process-local job contract validation behind the Queue facade. */
export class EnqueueContractsModule extends QueueModule {
  jobAcceptance(jobType: string, payload: Json): JobAcceptance {
    const { options } = this.context;
    const typeContracts = options.contracts?.[jobType];
    const contractVersion = typeContracts?.currentVersion ?? null;
    const contract =
      contractVersion === null ? undefined : typeContracts!.versions[contractVersion]!;
    const payloadMaxBytes =
      contract?.maxPayloadBytes ?? options.defaultMaxPayloadBytes ?? DEFAULT_JOB_VALUE_MAX_BYTES;
    const resultMaxBytes =
      contract?.maxResultBytes ?? options.defaultMaxResultBytes ?? DEFAULT_JOB_VALUE_MAX_BYTES;
    if (contract !== undefined) {
      validateContractValue(
        jobType,
        contractVersion!,
        "payload",
        payload,
        contract,
        payloadMaxBytes,
      );
    } else {
      enforceJsonSize(jobType, "payload", payload, payloadMaxBytes);
    }
    return {
      contractVersion,
      payloadMaxBytes,
      resultMaxBytes,
      sensitivePayloadKeys: contract?.sensitivePayloadKeys ?? [],
      sensitiveResultKeys: contract?.sensitiveResultKeys ?? [],
    };
  }

  validateResult(job: ClaimedJob<unknown>, result: Json): void {
    if (job.contractVersion !== null) {
      const contract = this.context.options.contracts?.[job.type]?.versions[job.contractVersion];
      if (contract === undefined) {
        throw new JobContractUnavailableError(job.type, job.contractVersion);
      }
      validateContractValue(
        job.type,
        job.contractVersion,
        "result",
        result,
        contract,
        job.resultMaxBytes,
      );
      return;
    }
    enforceJsonSize(job.type, "result", result, job.resultMaxBytes);
  }

  async enqueue<TPayload extends Json>(
    type: string,
    payload: TPayload,
    options: EnqueueOptions = {},
    transaction: Queryable = this.context.database,
  ): Promise<string> {
    return (await this.enqueueWithResult(type, payload, options, transaction)).jobId;
  }

  async enqueueWithResult<TPayload extends Json>(
    type: string,
    payload: TPayload,
    options: EnqueueOptions = {},
    transaction: Queryable = this.context.database,
  ): Promise<EnqueueResult> {
    return (
      await this.enqueueManyWithResults(
        [{ type, payload, options, tags: options.tags }],
        transaction,
      )
    )[0]!;
  }

  async enqueueMany(
    requests: readonly EnqueueRequest[],
    transaction: Queryable = this.context.database,
  ): Promise<string[]> {
    return (await this.enqueueManyWithResults(requests, transaction)).map((result) => result.jobId);
  }

  async enqueueManyWithResults(
    requests: readonly EnqueueRequest[],
    transaction: Queryable = this.context.database,
  ): Promise<EnqueueResult[]> {
    if (requests.length === 0) return [];
    if (requests.length > MAX_ENQUEUE_BATCH_SIZE) {
      throw new RangeError(`enqueueMany accepts at most ${MAX_ENQUEUE_BATCH_SIZE} requests`);
    }

    const queueNames = new Set(
      requests.map((request) => request.options?.queue ?? this.context.defaultQueue),
    );
    return withSpan(
      "workhorse.enqueue",
      {
        ...(queueNames.size === 1
          ? { "workhorse.queue.name": queueNames.values().next().value! }
          : {}),
        ...(requests.length === 1 ? { "workhorse.job.type": requests[0]!.type } : {}),
        "workhorse.enqueue.count": requests.length,
      },
      async (span) => {
        const traceContext = injectTraceContext();
        const input = requests.map(({ type, payload, options = {}, tags }) => {
          const idempotency: EnqueueIdempotency | undefined = options.idempotency;
          const coalescingModes = [idempotency, options.debounce, options.throttle].filter(
            (mode) => mode !== undefined,
          );
          if (coalescingModes.length > 1) {
            throw new TypeError(
              "enqueue options cannot combine idempotency, debounce, or throttle",
            );
          }
          if (options.debounce !== undefined && options.runAt !== undefined) {
            throw new TypeError(
              "debounced enqueue uses its PostgreSQL-owned window instead of runAt",
            );
          }
          const acceptance = this.jobAcceptance(type, payload);
          return {
            queue: options.queue ?? this.context.defaultQueue,
            type,
            payload,
            priority: validateJobPriority(options.priority),
            ...acceptance,
            ...(traceContext === null ? {} : { traceContext }),
            ...(options.runAt === undefined &&
            (idempotency !== undefined ||
              options.debounce !== undefined ||
              options.throttle !== undefined)
              ? {}
              : { runAt: (options.runAt ?? new Date()).toISOString() }),
            deadline: options.deadline?.toISOString() ?? null,
            concurrencyKey: options.concurrencyKey ?? null,
            executionTimeoutMs: options.executionTimeoutMs ?? null,
            maxAttempts: options.maxAttempts ?? 25,
            retryPolicy: options.retryPolicy ?? null,
            tags: tags ?? options.tags ?? [],
            ...(idempotency === undefined
              ? {}
              : {
                  idempotency: {
                    key: idempotency.key,
                    scope: idempotency.scope ?? DEFAULT_IDEMPOTENCY_SCOPE,
                    ttlMs: idempotency.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
                  },
                }),
            ...(options.debounce === undefined
              ? {}
              : {
                  debounce: {
                    key: options.debounce.key,
                    scope: options.debounce.scope ?? DEFAULT_IDEMPOTENCY_SCOPE,
                    windowMs: options.debounce.windowMs,
                    schedule: options.debounce.schedule,
                  },
                }),
            ...(options.throttle === undefined
              ? {}
              : {
                  throttle: {
                    key: options.throttle.key,
                    scope: options.throttle.scope ?? DEFAULT_IDEMPOTENCY_SCOPE,
                    windowMs: options.throttle.windowMs,
                  },
                }),
          };
        });
        try {
          const result = await transaction.query<{
            ordinal: number;
            job_id: string;
            outcome: EnqueueOutcome;
          }>(
            "SELECT ordinal, job_id, outcome FROM workhorse.enqueue_many_v2($1::jsonb) ORDER BY ordinal",
            [JSON.stringify(input)],
          );
          const enqueueResults = result.rows.map((row) => ({
            jobId: row.job_id,
            outcome: row.outcome,
          }));
          for (const [index, row] of result.rows.entries()) {
            const request = requests[(row.ordinal ?? index + 1) - 1];
            if (!request) continue;
            const outcome = row.outcome;
            const logDetailsByOutcome: Record<
              EnqueueOutcome,
              readonly [Parameters<typeof logDebug>[0], string]
            > = {
              accepted: ["workhorse.job.enqueued", "Job enqueued"],
              replayed: ["workhorse.job.enqueue_replayed", "Idempotent enqueue replayed"],
              replaced: ["workhorse.job.debounced", "Pending job replaced"],
              non_replaceable: ["workhorse.job.debounce_rejected", "Debounced job not replaceable"],
              coalesced: ["workhorse.job.throttled", "Throttled enqueue coalesced"],
            };
            const [eventName, body] = logDetailsByOutcome[outcome];
            logDebug(eventName, body, {
              "workhorse.job.id": row.job_id,
              "workhorse.job.type": request.type,
              "workhorse.queue.name": request.options?.queue ?? this.context.defaultQueue,
            });
            if (outcome !== "accepted") continue;
            telemetryMetrics.enqueued.add(1, {
              "workhorse.queue.name": request.options?.queue ?? this.context.defaultQueue,
              "workhorse.job.type": request.type,
            });
          }
          if (enqueueResults.length === 1) {
            span.setAttribute("workhorse.job.id", enqueueResults[0]!.jobId);
          }
          return enqueueResults;
        } catch (error) {
          throw enqueueConflict(error) ?? error;
        }
      },
    );
  }
}
