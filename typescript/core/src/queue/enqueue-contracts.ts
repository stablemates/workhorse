import { SQL_STATEMENTS } from "./sql-catalogue.generated.js";
import {
  databaseErrorCode,
  databaseErrorDetails,
  fastTierRejection,
  WorkhorseError,
} from "../errors.js";
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
import { compileContractSchema, parseStoredContractSchema } from "../contract-schema.js";
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
  "budget",
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

/** The protocol value of an execution timeout. Zero means no timeout, the same as an omitted one. */
export function executionTimeoutValue(value: number | undefined): number | null {
  return value === undefined || value === 0 ? null : value;
}

const DEFAULT_MAX_ATTEMPTS = 25;
const MAX_TASK_ATTEMPTS = 100;

/** The protocol value of an attempt limit. Zero means the default, the same as an omitted one. */
export function maxAttemptsValue(value: number | undefined): number {
  if (value === undefined || value === 0) return DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TASK_ATTEMPTS) {
    throw new RangeError(
      `maxAttempts must be an integer between 1 and ${MAX_TASK_ATTEMPTS}, or 0 for the default`,
    );
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

// PostgreSQL enforces the limit on octet_length(value::jsonb::text), so the client measures the
// same text from the JSON it sends. Without exponent notation that text is at most twice as long
// as the compact JSON, which lets most values skip the exact measure.
function serializeJsonWithinLimit(
  taskType: string,
  kind: "payload" | "result",
  value: Json,
  maxBytes: number,
): string {
  const serialized = JSON.stringify(value);
  const compactBytes = Buffer.byteLength(serialized, "utf8");
  if (compactBytes * 2 <= maxBytes && !EXPONENT_NUMBER.test(serialized)) return serialized;
  const actualBytes = jsonbTextBytes(serialized);
  if (actualBytes > maxBytes) {
    throw new TaskValueSizeLimitError(taskType, kind, actualBytes, maxBytes);
  }
  return serialized;
}

// A number token in exponent notation. JSON.stringify writes an explicit exponent sign, and a
// JSON.rawJSON number can omit it or use an upper-case E.
const EXPONENT_NUMBER = /\d[eE][+-]?\d/;

// PostgreSQL refuses a jsonb string or key that holds NUL or a surrogate outside a pair, and that
// refusal would stop the worker rather than fail the attempt. The error carries no part of the
// result, so the failure envelope that reports it stays storable.
function assertStorableResult(taskType: string, serialized: string): string {
  if (hasUnstorableEscape(serialized)) {
    throw new TypeError(
      `${taskType} result contains a NUL character or an unpaired surrogate, which PostgreSQL jsonb cannot store`,
    );
  }
  return serialized;
}

const UNSTORABLE_ESCAPE_START = /\\u(?:0000|[dD])/;
const JSON_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|[^])/g;

/**
 * Keeps ordinary text off the full scan. Every refused escape is \u0000 or a surrogate, and every
 * surrogate escape starts with \ud or \uD. JSON.stringify writes non-ASCII text and `<` raw, so
 * ordinary text matches neither.
 */
export function mayHoldUnstorableEscape(serialized: string): boolean {
  return UNSTORABLE_ESCAPE_START.test(serialized);
}

/**
 * Scans valid JSON for a \u escape jsonb refuses. JSON.stringify writes NUL as \u0000 and a lone
 * surrogate as its escape, and a toJSON can write either. A high surrogate is stored only when a
 * low surrogate escape follows it at once.
 */
export function hasUnstorableEscape(serialized: string): boolean {
  if (!mayHoldUnstorableEscape(serialized)) return false;
  let lowExpectedAt = -1;
  for (const match of serialized.matchAll(JSON_ESCAPE)) {
    const unit = match[1] === undefined ? undefined : Number.parseInt(match[1], 16);
    if (lowExpectedAt >= 0) {
      if (match.index !== lowExpectedAt || unit === undefined || unit < 0xdc00 || unit > 0xdfff) {
        return true;
      }
      lowExpectedAt = -1;
    } else if (unit !== undefined) {
      if (unit === 0 || (unit >= 0xdc00 && unit <= 0xdfff)) return true;
      if (unit >= 0xd800 && unit <= 0xdbff) lowExpectedAt = match.index + match[0].length;
    }
  }
  return lowExpectedAt >= 0;
}

interface OpenContainer {
  object: boolean;
  /** The bytes of each member by key, so that a later member replaces an earlier one. */
  members: Map<string, number>;
  bytes: number;
  count: number;
  key: string;
  /** The jsonb text bytes of `key` and the `": "` after it. */
  keyBytes: number;
}

/**
 * Returns the UTF-8 length of PostgreSQL's jsonb text for valid JSON text. That text puts a space
 * after each `:` and `,`. It escapes strings as JSON.stringify does. It keeps the last member of
 * each key. It writes each number in plain decimal notation with the scale of its token. The walk
 * reads tokens, so a JSON.rawJSON number such as `0.0` keeps its scale. It keeps its own stack,
 * so any nesting measures without a stack overflow.
 */
export function jsonbTextBytes(serialized: string): number {
  const stack: OpenContainer[] = [];
  let result = 0;
  let expectKey = false;
  const add = (bytes: number): void => {
    const top = stack.at(-1);
    if (top === undefined) result = bytes;
    else if (top.object) top.members.set(top.key, top.keyBytes + bytes);
    else {
      top.bytes += bytes;
      top.count += 1;
    }
  };
  for (let index = 0; index < serialized.length;) {
    const code = serialized.charCodeAt(index);
    if (code === OPEN_BRACE || code === OPEN_BRACKET) {
      stack.push({
        object: code === OPEN_BRACE,
        members: new Map(),
        bytes: 0,
        count: 0,
        key: "",
        keyBytes: 0,
      });
      expectKey = code === OPEN_BRACE;
      index += 1;
    } else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) {
      const top = stack.pop()!;
      let { bytes, count } = top;
      if (top.object) {
        count = top.members.size;
        for (const member of top.members.values()) bytes += member;
      }
      add(2 + bytes + (count > 0 ? 2 * (count - 1) : 0));
      expectKey = false;
      index += 1;
    } else if (code === COMMA) {
      expectKey = stack.at(-1)?.object === true;
      index += 1;
    } else if (code === QUOTE) {
      let end = index + 1;
      let escaped = false;
      for (
        let next = serialized.charCodeAt(end);
        next !== QUOTE;
        next = serialized.charCodeAt(end)
      ) {
        if (next === BACKSLASH) {
          escaped = true;
          end += 2;
        } else end += 1;
      }
      const token = serialized.slice(index, end + 1);
      const text = escaped ? (JSON.parse(token) as string) : undefined;
      // JSON.stringify writes an unescaped string as it is, so the token is its own jsonb text.
      const bytes = text === undefined ? Buffer.byteLength(token, "utf8") : jsonbStringBytes(text);
      if (expectKey) {
        const top = stack.at(-1)!;
        top.key = text ?? token.slice(1, -1);
        top.keyBytes = bytes + 2;
        expectKey = false;
      } else add(bytes);
      index = end + 1;
    } else if (code === LETTER_T || code === LETTER_N) {
      add(4);
      index += 4;
    } else if (code === LETTER_F) {
      add(5);
      index += 5;
    } else if (isNumberCharacter(code)) {
      let end = index + 1;
      while (end < serialized.length && isNumberCharacter(serialized.charCodeAt(end))) end += 1;
      add(numericTextBytes(serialized.slice(index, end)));
      index = end;
    } else {
      // Whitespace and `:` add nothing to the measure.
      index += 1;
    }
  }
  return result;
}

const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COMMA = 0x2c;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const LETTER_T = 0x74;
const LETTER_N = 0x6e;
const LETTER_F = 0x66;

// A character that a JSON number token can hold: a digit, a sign, `.`, `e`, or `E`.
function isNumberCharacter(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2d ||
    code === 0x2b ||
    code === 0x2e ||
    code === 0x65 ||
    code === 0x45
  );
}

// escape_json escapes the same characters as JSON.stringify, with the same text.
function jsonbStringBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8");
}

const NEGATIVE_ZERO = /^-0(?:\.0*)?$/;

// numeric_out writes the integer part without leading zeros and as many fraction digits as the
// token had after its decimal point, less the exponent. Zero has no sign.
function numericTextBytes(token: string): number {
  if (!/[eE]/.test(token)) return NEGATIVE_ZERO.test(token) ? token.length - 1 : token.length;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) return token.length;
  const [, sign, integerDigits, fractionDigits = "", exponentText = "0"] = match;
  const exponent = Number(exponentText);
  // PostgreSQL refuses an exponent this large, so the database reports the value.
  if (!Number.isSafeInteger(exponent)) return token.length;
  const digits = integerDigits! + fractionDigits;
  const point = integerDigits!.length + exponent;
  let integerLength = 1;
  if (point > 0) {
    const available = Math.min(point, digits.length);
    const leadingZeros = /^0*/.exec(digits.slice(0, available))![0].length;
    if (leadingZeros < available) integerLength = point - leadingZeros;
  }
  const scale = Math.max(0, fractionDigits.length - exponent);
  const negative = sign === "-" && /[1-9]/.test(digits);
  return (negative ? 1 : 0) + integerLength + (scale > 0 ? 1 + scale : 0);
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
  // The jsonb text, so that a number that a double cannot hold keeps all its digits.
  schema: string | { payload: Json; result: Json };
  payload_max_bytes: number;
  result_max_bytes: number;
  payload_redact_keys: string[];
  result_redact_keys: string[];
}

// The contract definition with its schema as jsonb text. pg parses jsonb into doubles, and the text
// keeps the exact decimal of each schema number.
const CONTRACT_DEFINITION_TEXT =
  "SELECT contract.version, contract.schema::text AS schema, contract.payload_max_bytes, " +
  "contract.result_max_bytes, contract.payload_redact_keys, contract.result_redact_keys " +
  `FROM (${SQL_STATEMENTS["get_contract_definition_v1"]}) contract`;

/** One row an enqueue statement returns. */
export interface EnqueueRow {
  ordinal: number;
  task_id: string | null;
  outcome: EnqueueOutcome | "contract_mismatch";
  reason: string | null;
}

/** One enqueue request in the JSON shape PostgreSQL reads, with its payload already serialized. */
type SerializedEnqueueRequest = { serializedPayload: string; runAt?: string } & Record<
  string,
  unknown
>;

function serializedRequest(request: Record<string, unknown>, serializedPayload: string): string {
  const serialized = JSON.stringify(request);
  return `${serialized.slice(0, -1)},"payload":${serializedPayload}}`;
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
  }

  private async loadContract(
    taskType: string,
    version: string | null,
    database: Queryable = this.context.database,
  ): Promise<{ version: string; contract: TaskContractVersion } | null> {
    const result = await database.query<ContractDefinitionRow>(CONTRACT_DEFINITION_TEXT, [
      taskType,
      version,
    ]);
    const row = result.rows[0];
    if (row === undefined) return null;
    const schema =
      typeof row.schema === "string"
        ? (parseStoredContractSchema(row.schema) as { payload: Json; result: Json })
        : row.schema;
    return {
      version: row.version,
      contract: {
        payloadSchema: schema.payload,
        resultSchema: schema.result,
        maxPayloadBytes: row.payload_max_bytes,
        maxResultBytes: row.result_max_bytes,
        sensitivePayloadKeys: row.payload_redact_keys,
        sensitiveResultKeys: row.result_redact_keys,
      },
    };
  }

  async taskAcceptance(
    taskType: string,
    payload: Json,
    version?: string | null,
  ): Promise<TaskAcceptance> {
    if (version === undefined) {
      return (await this.serializedTaskAcceptance(taskType, payload)).acceptance;
    }
    // A retained child without a contract must stay uncontracted on replay, even when its type
    // now has a current version. Pinned versions never replace the current-contract cache.
    let definition: CachedContractDefinition | null = null;
    if (version !== null) {
      definition = await this.loadContract(taskType, version);
      const local = this.context.options.contracts?.[taskType]?.versions[version];
      if (definition === null && local !== undefined) definition = { version, contract: local };
      if (definition === null) throw new TaskContractUnavailableError(taskType, version);
    }
    return this.serializedTaskAcceptanceUnder(taskType, payload, definition).acceptance;
  }

  // A schedule stores the contract fields of its task type, and firing an occurrence does not check
  // the contract policy. A stale version would persist on every occurrence, so each type's current
  // contract comes from PostgreSQL, not from the cache or the local definitions.
  async currentTaskAcceptances(
    tasks: readonly { type: string; payload: Json }[],
  ): Promise<TaskAcceptance[]> {
    const taskTypes = [...new Set(tasks.map((task) => task.type))];
    const definitions = new Map(
      await Promise.all(
        taskTypes.map(
          async (taskType) => [taskType, await this.loadContract(taskType, null)] as const,
        ),
      ),
    );
    return tasks.map(
      (task) =>
        this.serializedTaskAcceptanceUnder(
          task.type,
          task.payload,
          definitions.get(task.type) ?? null,
        ).acceptance,
    );
  }

  // An operator can change the selected version or its limits after syncContracts(). A payload the
  // cached definition rejects may be valid under the current one, so the client reloads the
  // definition once through the enqueue's queryable and validates again before it reports the
  // rejection. A producer that never synchronized has a cached definition only after a contract
  // mismatch fetched it, and that fetched definition is what PostgreSQL will accept on the retry.
  private async serializedTaskAcceptance(
    taskType: string,
    payload: Json,
    database: Queryable = this.context.database,
  ): Promise<SerializedTaskAcceptance> {
    const databaseContract = this.state.currentDatabaseContracts.get(taskType);
    try {
      return this.serializedTaskAcceptanceUnder(taskType, payload, databaseContract);
    } catch (error) {
      if (
        databaseContract === undefined ||
        !(error instanceof TaskContractValidationError || error instanceof TaskValueSizeLimitError)
      ) {
        throw error;
      }
      const definition = await this.loadContract(taskType, null, database);
      this.storeCurrentContract(taskType, definition);
      return this.serializedTaskAcceptanceUnder(taskType, payload, definition ?? undefined);
    }
  }

  private storeCurrentContract(taskType: string, definition: CachedContractDefinition | null) {
    if (definition === null) this.state.currentDatabaseContracts.delete(taskType);
    else this.state.currentDatabaseContracts.set(taskType, definition);
  }

  private serializedTaskAcceptanceUnder(
    taskType: string,
    payload: Json,
    databaseContract: CachedContractDefinition | null | undefined,
  ): SerializedTaskAcceptance {
    const { options } = this.context;
    const typeContracts = databaseContract === null ? undefined : options.contracts?.[taskType];
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
      return assertStorableResult(
        task.type,
        validateContractValue(
          task.type,
          task.contractVersion,
          "result",
          result,
          contract,
          task.resultMaxBytes,
        ),
      );
    }
    return assertStorableResult(
      task.type,
      serializeJsonWithinLimit(task.type, "result", result, task.resultMaxBytes),
    );
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
    if (requests.length === 0) return [];
    if (requests.length > MAX_ENQUEUE_BATCH_SIZE) {
      throw new RangeError(`enqueueMany accepts at most ${MAX_ENQUEUE_BATCH_SIZE} requests`);
    }
    return this.submitEnqueueRequests(requests, transaction, async (serializedInput) => {
      const result = await transaction.query<EnqueueRow>(SQL_STATEMENTS["enqueue_many_v1"], [
        serializedInput,
      ]);
      return result.rows;
    });
  }

  /**
   * Serialize one enqueue request for a callback of a task group. A callback is enqueued later, so
   * it carries no run time unless the caller set one.
   */
  async serializeCallbackRequest(
    request: EnqueueRequest,
    transaction: Queryable = this.context.database,
  ): Promise<string> {
    const options = request.options ?? {};
    if (
      options.idempotency !== undefined ||
      options.debounce !== undefined ||
      options.throttle !== undefined
    ) {
      throw new TypeError(
        "task group callbacks cannot use enqueue idempotency, debounce, or throttle",
      );
    }
    const [input] = await this.serializeEnqueueRequests([request], transaction);
    const { serializedPayload, ...serialized } = input!;
    if (options.runAt === undefined) delete serialized.runAt;
    return serializedRequest(serialized, serializedPayload);
  }

  /**
   * Serialize a batch of requests, submit it through `submit`, and map the rows. On a contract
   * mismatch, PostgreSQL enqueued nothing: the client reloads the named contracts and submits the
   * batch one more time.
   */
  async submitEnqueueRequests(
    requests: readonly EnqueueRequest[],
    transaction: Queryable,
    submit: (serializedInput: string) => Promise<readonly EnqueueRow[]>,
  ): Promise<EnqueueResult[]> {
    return this.enqueueManyWithResultsAttempt(requests, transaction, true, submit);
  }

  private async serializeEnqueueRequests(
    requests: readonly EnqueueRequest[],
    transaction: Queryable,
  ): Promise<SerializedEnqueueRequest[]> {
    const traceContext = injectTraceContext();
    return Promise.all(
      requests.map((request) => this.serializeEnqueueRequest(request, transaction, traceContext)),
    );
  }

  private async serializeEnqueueRequest(
    { type, payload, options = {}, tags }: EnqueueRequest,
    transaction: Queryable,
    traceContext: ReturnType<typeof injectTraceContext>,
  ): Promise<SerializedEnqueueRequest> {
    const idempotency: Idempotency | undefined = options.idempotency;
    const coalescingModes = [idempotency, options.debounce, options.throttle].filter(
      (mode) => mode !== undefined,
    );
    if (coalescingModes.length > 1) {
      throw new TypeError("enqueue options cannot combine idempotency, debounce, or throttle");
    }
    if (options.debounce !== undefined && options.runAt !== undefined) {
      throw new TypeError("debounced enqueue uses its PostgreSQL-owned window instead of runAt");
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
      transaction,
    );
    if (options.prerequisiteTaskId !== undefined && options.dependencies !== undefined) {
      throw new TypeError("enqueue options cannot combine prerequisiteTaskId and dependencies");
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
        new Set(dependencies.prerequisiteTaskIds).size !== dependencies.prerequisiteTaskIds.length
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
      budget: options.budget ?? null,
      executionTimeoutMs: executionTimeoutValue(options.executionTimeoutMs),
      maxAttempts: maxAttemptsValue(options.maxAttempts),
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
              // Zero means the default retention window, the same as an omitted one.
              ttlMs:
                idempotency.ttlMs === undefined || idempotency.ttlMs === 0
                  ? DEFAULT_IDEMPOTENCY_TTL_MS
                  : idempotency.ttlMs,
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
  }

  private async enqueueManyWithResultsAttempt(
    requests: readonly EnqueueRequest[],
    transaction: Queryable,
    refreshOnMismatch: boolean,
    submit: (serializedInput: string) => Promise<readonly EnqueueRow[]>,
  ): Promise<EnqueueResult[]> {
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
        const input = await this.serializeEnqueueRequests(requests, transaction);
        try {
          const serializedInput = `[${input
            .map(({ serializedPayload, ...request }) =>
              serializedRequest(request, serializedPayload),
            )
            .join(",")}]`;
          const result = { rows: await submit(serializedInput) };
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
              this.storeCurrentContract(
                taskType,
                await this.loadContract(taskType, null, transaction),
              );
            }
            if (!refreshOnMismatch) {
              throw new Error("Contract policy changed again while retrying enqueue");
            }
            return this.enqueueManyWithResultsAttempt(requests, transaction, false, submit);
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
          throw (
            enqueueConflict(error) ??
            dependencyCycle(error) ??
            dependencyLimit(error) ??
            fastTierRejection(error) ??
            error
          );
        }
      },
    );
  }
}
