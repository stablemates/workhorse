import { SQL_STATEMENTS } from "./sql-catalogue.generated.js";
import { databaseErrorCode, databaseErrorDetails, WorkhorseError } from "../errors.js";
import { injectTraceContext, logDebug, telemetryMetrics, withSpan } from "../telemetry.js";
import type {
  ClaimedTask,
  Idempotency,
  EnqueueIdempotencyConflictDetails,
  EnqueueIdempotencyConflictField,
  EnqueueOptions,
  EnqueueNonReplaceableReason,
  EnqueueOutcome,
  EnqueueRequest,
  EnqueueResult,
  TaskContractVersion,
  Json,
  Queryable,
  QueueOptions,
} from "../types.js";
import {
  DEFAULT_IDEMPOTENCY_SCOPE,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  DEFAULT_TASK_VALUE_MAX_BYTES,
  MAX_ENQUEUE_BATCH_SIZE,
  MAX_TASK_CONTRACT_SENSITIVE_KEYS,
  MAX_TASK_DEPENDENCIES,
  MAX_TASK_PRIORITY,
  MAX_TASK_VALUE_MAX_BYTES,
} from "../types.js";
import { compileContractSchema } from "../contract-schema.js";
import { QueueModule, type QueueModuleContext } from "./module-context.js";
import type { CachedContractDefinition, QueueModuleState } from "./modules.js";

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
  get existingTaskId(): string {
    return this.details.existingTaskId;
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

export type DependencyLimit = "prerequisites" | "dependents" | "unresolved_dependents" | "unknown";

export interface DependencyCycleDetails {
  readonly dependentTaskId: string;
  readonly prerequisiteTaskId: string;
  readonly cycleTaskIds: readonly string[];
  readonly truncated: boolean;
}

/** PostgreSQL rejected an edge because it would make the dependency graph cyclic. */
export class DependencyCycleError extends WorkhorseError {
  constructor(readonly details: DependencyCycleDetails) {
    super(
      `Dependency from ${details.dependentTaskId} to ${details.prerequisiteTaskId} forms a cycle`,
    );
    this.name = "DependencyCycleError";
  }

  get dependentTaskId(): string {
    return this.details.dependentTaskId;
  }
  get prerequisiteTaskId(): string {
    return this.details.prerequisiteTaskId;
  }
  get cycleTaskIds(): readonly string[] {
    return this.details.cycleTaskIds;
  }
  get truncated(): boolean {
    return this.details.truncated;
  }
}

/** PostgreSQL rejected a dependency edge because it exceeded a bounded graph dimension. */
export class DependencyLimitExceededError extends WorkhorseError {
  constructor(
    readonly taskId: string,
    readonly limit: DependencyLimit,
    readonly max: number,
  ) {
    super(`Task ${taskId} exceeds the supported dependency limit for ${limit}`);
    this.name = "DependencyLimitExceededError";
  }
}

export class TaskContractValidationError extends WorkhorseError {
  constructor(
    readonly taskType: string,
    readonly contractVersion: string,
    readonly valueKind: "payload" | "result",
  ) {
    super(`${taskType} ${valueKind} does not satisfy contract version ${contractVersion}`);
    this.name = "TaskContractValidationError";
  }
}

export class TaskValueSizeLimitError extends WorkhorseError {
  constructor(
    readonly taskType: string,
    readonly valueKind: "payload" | "result",
    readonly actualBytes: number,
    readonly maxBytes: number,
  ) {
    super(`${taskType} ${valueKind} exceeds its configured size limit`);
    this.name = "TaskValueSizeLimitError";
  }
}

export class TaskContractUnavailableError extends WorkhorseError {
  constructor(
    readonly taskType: string,
    readonly contractVersion: string,
  ) {
    super(`${taskType} contract version ${contractVersion} is not configured in this process`);
    this.name = "TaskContractUnavailableError";
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
  "prerequisiteTaskId",
  "dependencies",
  "ttlMs",
]);
const enqueueConflictDetailKeys = new Set([
  "scope",
  "keyPreview",
  "keyDigest",
  "keyLength",
  "existingTaskId",
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
  existingTaskId: "unknown",
  ordinal: 0,
  conflictingFields: [],
  storedRequestDigest: "0".repeat(64),
  rejectedRequestDigest: "0".repeat(64),
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const enqueueNonReplaceableReasons = new Set<EnqueueNonReplaceableReason>([
  "incompatible_key_mode",
  "not_pending",
  "window_elapsed_pending",
]);

function parsedErrorDetails<T>(
  error: unknown,
  valid: (value: unknown) => value is T,
  fallback: T,
): T {
  for (const detail of databaseErrorDetails(error)) {
    try {
      const parsed: unknown = JSON.parse(detail);
      if (valid(parsed)) return parsed;
    } catch {
      // PostgreSQL's DETAIL may sit behind an adapter wrapper's own detail string.
    }
  }
  return fallback;
}

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
    typeof detail.existingTaskId === "string" &&
    uuidPattern.test(detail.existingTaskId) &&
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
  return new EnqueueIdempotencyConflictError(
    parsedErrorDetails(error, validEnqueueConflictDetails, sanitizedEnqueueConflictDetails),
  );
}

interface DependencyLimitDetails {
  readonly taskId: string;
  readonly limit: DependencyLimit;
  readonly max: number;
}

function validDependencyLimitDetails(value: unknown): value is DependencyLimitDetails {
  if (typeof value !== "object" || value === null) return false;
  const detail = value as Record<string, unknown>;
  return (
    Object.keys(detail).length === 3 &&
    typeof detail.taskId === "string" &&
    uuidPattern.test(detail.taskId) &&
    typeof detail.max === "number" &&
    Number.isSafeInteger(detail.max) &&
    detail.max === MAX_TASK_DEPENDENCIES &&
    (detail.limit === "prerequisites" ||
      detail.limit === "dependents" ||
      detail.limit === "unresolved_dependents")
  );
}

function validDependencyCycleDetails(value: unknown): value is DependencyCycleDetails {
  if (typeof value !== "object" || value === null) return false;
  const detail = value as Record<string, unknown>;
  return (
    Object.keys(detail).length === 4 &&
    typeof detail.dependentTaskId === "string" &&
    uuidPattern.test(detail.dependentTaskId) &&
    typeof detail.prerequisiteTaskId === "string" &&
    uuidPattern.test(detail.prerequisiteTaskId) &&
    Array.isArray(detail.cycleTaskIds) &&
    detail.cycleTaskIds.length >= 2 &&
    detail.cycleTaskIds.length <= 101 &&
    detail.cycleTaskIds.every((taskId) => typeof taskId === "string" && uuidPattern.test(taskId)) &&
    typeof detail.truncated === "boolean"
  );
}

function dependencyLimit(error: unknown): DependencyLimitExceededError | null {
  if (databaseErrorCode(error) !== "P1005") return null;
  const details = parsedErrorDetails<DependencyLimitDetails>(error, validDependencyLimitDetails, {
    taskId: "unknown",
    limit: "unknown",
    max: MAX_TASK_DEPENDENCIES,
  });
  return new DependencyLimitExceededError(details.taskId, details.limit, details.max);
}

function dependencyCycle(error: unknown): DependencyCycleError | null {
  if (databaseErrorCode(error) !== "P1003") return null;
  return new DependencyCycleError(
    parsedErrorDetails<DependencyCycleDetails>(error, validDependencyCycleDetails, {
      dependentTaskId: "unknown",
      prerequisiteTaskId: "unknown",
      cycleTaskIds: [],
      truncated: true,
    }),
  );
}

function validateValueLimit(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TASK_VALUE_MAX_BYTES) {
    throw new RangeError(`${field} must be an integer between 1 and ${MAX_TASK_VALUE_MAX_BYTES}`);
  }
  return value;
}

export function validateTaskPriority(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TASK_PRIORITY) {
    throw new RangeError(`priority must be an integer between 0 and ${MAX_TASK_PRIORITY}`);
  }
  return value;
}

function validateSensitiveKeys(keys: readonly string[] | undefined, field: string): void {
  if (keys === undefined) return;
  if (keys.length > MAX_TASK_CONTRACT_SENSITIVE_KEYS) {
    throw new RangeError(`${field} accepts at most ${MAX_TASK_CONTRACT_SENSITIVE_KEYS} keys`);
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
  for (const [taskType, typeContracts] of Object.entries(options.contracts ?? {})) {
    if ([...taskType].length === 0) throw new TypeError("contract task types must be non-empty");
    if (
      [...typeContracts.currentVersion].length < 1 ||
      [...typeContracts.currentVersion].length > 100 ||
      !(typeContracts.currentVersion in typeContracts.versions)
    ) {
      throw new TypeError(
        `contract ${taskType} currentVersion must name a configured version of 1 to 100 characters`,
      );
    }
    for (const [version, contract] of Object.entries(typeContracts.versions)) {
      if ([...version].length < 1 || [...version].length > 100) {
        throw new TypeError(`contract ${taskType} versions must contain 1 to 100 characters`);
      }
      validateValueLimit(contract.maxPayloadBytes, `${taskType}.${version}.maxPayloadBytes`);
      validateValueLimit(contract.maxResultBytes, `${taskType}.${version}.maxResultBytes`);
      validateSensitiveKeys(
        contract.sensitivePayloadKeys,
        `${taskType}.${version}.sensitivePayloadKeys`,
      );
      validateSensitiveKeys(
        contract.sensitiveResultKeys,
        `${taskType}.${version}.sensitiveResultKeys`,
      );
      if (contract.payloadSchema !== undefined) {
        compileContractSchema(contract.payloadSchema);
      }
      if (contract.resultSchema !== undefined) {
        compileContractSchema(contract.resultSchema);
      }
    }
  }
  return options;
}

function validateContractValue(
  taskType: string,
  version: string,
  kind: "payload" | "result",
  value: Json,
  contract: TaskContractVersion,
  maxBytes: number,
): string {
  const schema = kind === "payload" ? contract.payloadSchema : contract.resultSchema;
  if (schema !== undefined) {
    const validator = compileContractSchema(schema);
    if (!validator(value)) throw new TaskContractValidationError(taskType, version, kind);
  }
  return serializeJsonWithinLimit(taskType, kind, value, maxBytes);
}

function serializeJsonWithinLimit(
  taskType: string,
  kind: "payload" | "result",
  value: Json,
  maxBytes: number,
): string {
  const serialized = JSON.stringify(value);
  const actualBytes = Buffer.byteLength(serialized, "utf8");
  if (actualBytes > maxBytes) {
    throw new TaskValueSizeLimitError(taskType, kind, actualBytes, maxBytes);
  }
  return serialized;
}

interface TaskAcceptance {
  contractVersion: string | null;
  payloadMaxBytes: number;
  resultMaxBytes: number;
  sensitivePayloadKeys: readonly string[];
  sensitiveResultKeys: readonly string[];
}

interface SerializedTaskAcceptance {
  acceptance: TaskAcceptance;
  serializedPayload: string;
}

interface ContractDefinitionRow {
  version: string;
  schema: { payload: Json; result: Json };
  payload_max_bytes: number;
  result_max_bytes: number;
  payload_redact_keys: string[];
  result_redact_keys: string[];
}

/** Owns enqueue serialization and process-local task contract validation behind the Queue facade. */
export class EnqueueContractsModule extends QueueModule {
  constructor(
    context: QueueModuleContext,
    private readonly state: QueueModuleState,
  ) {
    super(context);
  }

  async syncContracts(): Promise<void> {
    const definitions = Object.entries(this.context.options.contracts ?? {}).map(
      ([taskType, contracts]) => ({
        taskType,
        currentVersion: contracts.currentVersion,
        versions: Object.fromEntries(
          Object.entries(contracts.versions).map(([version, contract]) => [
            version,
            {
              payloadSchema: contract.payloadSchema,
              resultSchema: contract.resultSchema,
              maxPayloadBytes:
                contract.maxPayloadBytes ??
                this.context.options.defaultMaxPayloadBytes ??
                DEFAULT_TASK_VALUE_MAX_BYTES,
              maxResultBytes:
                contract.maxResultBytes ??
                this.context.options.defaultMaxResultBytes ??
                DEFAULT_TASK_VALUE_MAX_BYTES,
              sensitivePayloadKeys: contract.sensitivePayloadKeys,
              sensitiveResultKeys: contract.sensitiveResultKeys,
            },
          ]),
        ),
      }),
    );
    await this.context.database.query(SQL_STATEMENTS["sync_contract_definitions_v1"], [
      JSON.stringify(definitions),
    ]);
    const currentContracts = new Map<string, CachedContractDefinition>();
    for (const taskType of Object.keys(this.context.options.contracts ?? {})) {
      const definition = await this.loadContract(taskType, null);
      if (definition !== null) currentContracts.set(taskType, definition);
    }
    this.state.currentDatabaseContracts.clear();
    for (const [taskType, definition] of currentContracts) {
      this.state.currentDatabaseContracts.set(taskType, definition);
    }
    this.state.contractsSynchronized = true;
  }

  private async loadContract(
    taskType: string,
    version: string | null,
    database: Queryable = this.context.database,
  ): Promise<{ version: string; contract: TaskContractVersion } | null> {
    const result = await database.query<ContractDefinitionRow>(
      SQL_STATEMENTS["get_contract_definition_v1"],
      [taskType, version],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      version: row.version,
      contract: {
        payloadSchema: row.schema.payload,
        resultSchema: row.schema.result,
        maxPayloadBytes: row.payload_max_bytes,
        maxResultBytes: row.result_max_bytes,
        sensitivePayloadKeys: row.payload_redact_keys,
        sensitiveResultKeys: row.result_redact_keys,
      },
    };
  }

  async taskAcceptance(taskType: string, payload: Json): Promise<TaskAcceptance> {
    return (await this.serializedTaskAcceptance(taskType, payload)).acceptance;
  }

  private async serializedTaskAcceptance(
    taskType: string,
    payload: Json,
  ): Promise<SerializedTaskAcceptance> {
    const { options } = this.context;
    const typeContracts = options.contracts?.[taskType];
    const databaseContract = !this.state.contractsSynchronized
      ? undefined
      : this.state.currentDatabaseContracts.get(taskType);
    const contractVersion = databaseContract?.version ?? typeContracts?.currentVersion ?? null;
    const contract =
      databaseContract?.contract ??
      (contractVersion === null ? undefined : typeContracts!.versions[contractVersion]!);
    const payloadMaxBytes =
      contract?.maxPayloadBytes ?? options.defaultMaxPayloadBytes ?? DEFAULT_TASK_VALUE_MAX_BYTES;
    const resultMaxBytes =
      contract?.maxResultBytes ?? options.defaultMaxResultBytes ?? DEFAULT_TASK_VALUE_MAX_BYTES;
    if (contract !== undefined) {
      const serializedPayload = validateContractValue(
        taskType,
        contractVersion!,
        "payload",
        payload,
        contract,
        payloadMaxBytes,
      );
      return {
        acceptance: {
          contractVersion,
          payloadMaxBytes,
          resultMaxBytes,
          sensitivePayloadKeys: contract.sensitivePayloadKeys ?? [],
          sensitiveResultKeys: contract.sensitiveResultKeys ?? [],
        },
        serializedPayload,
      };
    } else {
      const serializedPayload = serializeJsonWithinLimit(
        taskType,
        "payload",
        payload,
        payloadMaxBytes,
      );
      return {
        acceptance: {
          contractVersion,
          payloadMaxBytes,
          resultMaxBytes,
          sensitivePayloadKeys: [],
          sensitiveResultKeys: [],
        },
        serializedPayload,
      };
    }
  }

  async validateResult(task: ClaimedTask, result: Json): Promise<string> {
    if (task.contractVersion !== null) {
      const retainedVersions = this.state.retainedDatabaseContracts.get(task.type);
      let contract = retainedVersions?.get(task.contractVersion)?.contract;
      if (contract === undefined) {
        const loaded = await this.loadContract(task.type, task.contractVersion);
        contract =
          loaded?.contract ??
          this.context.options.contracts?.[task.type]?.versions[task.contractVersion];
        if (loaded !== null) {
          const versions = retainedVersions ?? new Map<string, CachedContractDefinition>();
          versions.set(task.contractVersion, loaded);
          this.state.retainedDatabaseContracts.set(task.type, versions);
        }
      }
      if (contract === undefined) {
        throw new TaskContractUnavailableError(task.type, task.contractVersion);
      }
      return validateContractValue(
        task.type,
        task.contractVersion,
        "result",
        result,
        contract,
        task.resultMaxBytes,
      );
    }
    return serializeJsonWithinLimit(task.type, "result", result, task.resultMaxBytes);
  }

  async enqueue<TPayload extends Json>(
    type: string,
    payload: TPayload,
    options: EnqueueOptions = {},
    transaction: Queryable = this.context.database,
  ): Promise<string> {
    return (await this.enqueueWithResult(type, payload, options, transaction)).taskId;
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
    return (await this.enqueueManyWithResults(requests, transaction)).map(
      (result) => result.taskId,
    );
  }

  async enqueueManyWithResults(
    requests: readonly EnqueueRequest[],
    transaction: Queryable = this.context.database,
  ): Promise<EnqueueResult[]> {
    return this.enqueueManyWithResultsAttempt(requests, transaction, true);
  }

  private async enqueueManyWithResultsAttempt(
    requests: readonly EnqueueRequest[],
    transaction: Queryable,
    refreshOnMismatch: boolean,
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
        ...(requests.length === 1 ? { "workhorse.task.type": requests[0]!.type } : {}),
        "workhorse.enqueue.count": requests.length,
      },
      async (span) => {
        const traceContext = injectTraceContext();
        const input = await Promise.all(
          requests.map(async ({ type, payload, options = {}, tags }) => {
            const idempotency: Idempotency | undefined = options.idempotency;
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
            if (
              (options.debounce !== undefined || options.throttle !== undefined) &&
              (options.prerequisiteTaskId !== undefined || options.dependencies !== undefined)
            ) {
              throw new TypeError(
                "enqueue options cannot combine debounce or throttle with prerequisiteTaskId or dependencies",
              );
            }
            const { serializedPayload, acceptance } = await this.serializedTaskAcceptance(
              type,
              payload,
            );
            if (options.prerequisiteTaskId !== undefined && options.dependencies !== undefined) {
              throw new TypeError(
                "enqueue options cannot combine prerequisiteTaskId and dependencies",
              );
            }
            const dependencies = options.dependencies;
            if (dependencies !== undefined) {
              if (
                dependencies.prerequisiteTaskIds.length === 0 ||
                dependencies.prerequisiteTaskIds.length > MAX_TASK_DEPENDENCIES
              ) {
                throw new RangeError(
                  `dependencies requires between 1 and ${MAX_TASK_DEPENDENCIES} prerequisiteTaskIds`,
                );
              }
              if (
                new Set(dependencies.prerequisiteTaskIds).size !==
                dependencies.prerequisiteTaskIds.length
              ) {
                throw new TypeError("dependencies prerequisiteTaskIds must be unique");
              }
            }
            const prerequisiteTaskIds = [...(dependencies?.prerequisiteTaskIds ?? [])];
            // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
            prerequisiteTaskIds.sort();
            return {
              queue: options.queue ?? this.context.defaultQueue,
              type,
              serializedPayload,
              priority: validateTaskPriority(options.priority),
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
              prerequisiteTaskId: options.prerequisiteTaskId ?? null,
              dependencies:
                dependencies === undefined
                  ? null
                  : {
                      prerequisiteTaskIds,
                      onSuccess: dependencies.onSuccess,
                      onFailure: dependencies.onFailure,
                      onCancellation: dependencies.onCancellation,
                    },
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
          }),
        );
        try {
          const serializedInput = `[${input
            .map(({ serializedPayload, ...request }) => {
              const serializedRequest = JSON.stringify(request);
              return `${serializedRequest.slice(0, -1)},"payload":${serializedPayload}}`;
            })
            .join(",")}]`;
          const result = await transaction.query<{
            ordinal: number;
            task_id: string | null;
            outcome: EnqueueOutcome | "contract_mismatch";
            reason: string | null;
          }>(SQL_STATEMENTS["enqueue_many_v1"], [serializedInput]);
          const mismatchRow = result.rows.find((row) => row.outcome === "contract_mismatch");
          if (mismatchRow !== undefined) {
            const mismatch = JSON.parse(mismatchRow.reason ?? "null") as {
              taskTypes?: unknown;
            } | null;
            if (
              mismatch === null ||
              !Array.isArray(mismatch.taskTypes) ||
              mismatch.taskTypes.some((taskType) => typeof taskType !== "string")
            ) {
              throw new Error("PostgreSQL returned invalid contract mismatch details");
            }
            for (const taskType of mismatch.taskTypes) {
              const definition = await this.loadContract(taskType, null, transaction);
              if (definition === null) this.state.currentDatabaseContracts.delete(taskType);
              else this.state.currentDatabaseContracts.set(taskType, definition);
            }
            if (!refreshOnMismatch) {
              throw new Error("Contract policy changed again while retrying enqueue");
            }
            return this.enqueueManyWithResultsAttempt(requests, transaction, false);
          }
          const enqueueResults = result.rows.map((row): EnqueueResult => {
            if (row.task_id === null || row.outcome === "contract_mismatch") {
              throw new Error("PostgreSQL returned an incomplete enqueue result");
            }
            if (row.outcome !== "non_replaceable") {
              return { taskId: row.task_id, outcome: row.outcome };
            }
            if (!enqueueNonReplaceableReasons.has(row.reason as EnqueueNonReplaceableReason)) {
              throw new Error(
                "PostgreSQL returned a non_replaceable enqueue without a valid reason",
              );
            }
            return {
              taskId: row.task_id,
              outcome: row.outcome,
              reason: row.reason as EnqueueNonReplaceableReason,
            };
          });
          for (const [index, row] of result.rows.entries()) {
            const request = requests[(row.ordinal ?? index + 1) - 1];
            if (!request) continue;
            const outcome = row.outcome;
            if (outcome === "contract_mismatch" || row.task_id === null) continue;
            const logDetailsByOutcome: Record<
              EnqueueOutcome,
              readonly [Parameters<typeof logDebug>[0], string]
            > = {
              accepted: ["workhorse.task.enqueued", "Task enqueued"],
              replayed: ["workhorse.task.enqueue_replayed", "Idempotent enqueue replayed"],
              replaced: ["workhorse.task.debounced", "Pending task replaced"],
              non_replaceable: [
                "workhorse.task.debounce_rejected",
                "Debounced task not replaceable",
              ],
              coalesced: ["workhorse.task.throttled", "Throttled enqueue coalesced"],
            };
            const [eventName, body] = logDetailsByOutcome[outcome];
            logDebug(eventName, body, {
              "workhorse.task.id": row.task_id,
              "workhorse.task.type": request.type,
              "workhorse.queue.name": request.options?.queue ?? this.context.defaultQueue,
            });
            telemetryMetrics.enqueueOutcomes.add(1, {
              "workhorse.queue.name": request.options?.queue ?? this.context.defaultQueue,
              "workhorse.enqueue.outcome": outcome,
            });
            if (outcome !== "accepted") continue;
            telemetryMetrics.enqueued.add(1, {
              "workhorse.queue.name": request.options?.queue ?? this.context.defaultQueue,
              "workhorse.task.type": request.type,
            });
          }
          if (enqueueResults.length === 1) {
            span.setAttribute("workhorse.task.id", enqueueResults[0]!.taskId);
            span.setAttribute("workhorse.enqueue.outcome", enqueueResults[0]!.outcome);
          }
          return enqueueResults;
        } catch (error) {
          throw enqueueConflict(error) ?? dependencyCycle(error) ?? dependencyLimit(error) ?? error;
        }
      },
    );
  }
}
