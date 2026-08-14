import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_IDEMPOTENCY_SCOPE,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  DEFAULT_JOB_QUERY_PAYLOAD_BYTES,
  DEFAULT_JOB_VALUE_MAX_BYTES,
  MAX_CANCELLATION_REASON_CHARACTERS,
  MAX_CANCELLATION_REQUESTED_BY_CHARACTERS,
  MAX_CHECKPOINT_VALUE_BYTES,
  MAX_ENQUEUE_BATCH_SIZE,
  MAX_EXECUTION_TIMEOUT_MS,
  MAX_IDEMPOTENCY_KEY_BYTES,
  MAX_IDEMPOTENCY_SCOPE_BYTES,
  MAX_IDEMPOTENCY_TTL_MS,
  MAX_JOB_CONTRACT_SENSITIVE_KEYS,
  MAX_JOB_PRIORITY,
  MAX_JOB_QUERY_PAGE_SIZE,
  MAX_JOB_QUERY_PAYLOAD_BYTES,
  MAX_JOB_QUERY_REDACT_KEYS,
  MAX_JOB_VALUE_MAX_BYTES,
  MAX_PROGRESS_VALUE_BYTES,
  MAX_REDRIVE_BATCH_SIZE,
  MAX_REDRIVE_REQUEST_ID_BYTES,
  MAX_WAIT_DURATION_MS,
  MIN_PROGRESS_UPDATE_INTERVAL_MS,
} from "../src/types.js";

// PostgreSQL enforces every bound in this system, so each named limit exists twice: once as a literal
// inside sql/schema.sql, and once as an exported constant that callers read before they send work.
// Nothing links the two. This file is that link. Each rule below anchors a constant to the SQL sites
// that enforce it, and the suite fails when either side moves alone.
//
// A rule is deliberately anchored on the enforcing expression, not only on the message text, so
// loosening a guard while leaving its wording intact is still a failure. Where a site states its bound
// twice — once in the condition and once in the message a caller reads — both are captured, which is
// what keeps a guard and its explanation from disagreeing.

const repository = path.resolve(import.meta.dirname, "..");

interface LimitRule {
  /** Name of the exported constant, used in failure messages. */
  readonly constant: string;
  /** Value the SQL literals must equal. */
  readonly value: number | string;
  /** What the limit bounds, for a reader who hits a failure without the surrounding context. */
  readonly bounds: string;
  /**
   * Patterns matched against the whole schema. Every pattern must match at least once — a pattern that
   * stops matching means the SQL site was renamed or removed and the rule needs rewriting, which is a
   * failure rather than a silent pass. Every capture group of every match must equal `value`.
   */
  readonly patterns: readonly RegExp[];
}

/** Whitespace between a guard and the exception it raises, which spans lines and indentation levels. */
const gap = String.raw`\s*THEN\s*`;

const rules: readonly LimitRule[] = [
  {
    constant: "MAX_ENQUEUE_BATCH_SIZE",
    value: MAX_ENQUEUE_BATCH_SIZE,
    bounds: "requests accepted by one enqueueMany transaction",
    patterns: [
      new RegExp(
        String.raw`v_count > (\d+)${gap}RAISE EXCEPTION 'enqueue batch exceeds maximum size of (\d+)'`,
        "g",
      ),
    ],
  },
  {
    constant: "MAX_JOB_PRIORITY",
    value: MAX_JOB_PRIORITY,
    bounds: "dispatch priority accepted for one job",
    patterns: [
      new RegExp(
        String.raw`v_priority NOT BETWEEN 0 AND (\d+)${gap}RAISE EXCEPTION 'priority must be an integer between 0 and (\d+)'`,
        "g",
      ),
    ],
  },
  {
    constant: "DEFAULT_IDEMPOTENCY_SCOPE",
    value: DEFAULT_IDEMPOTENCY_SCOPE,
    bounds: "namespace applied when a caller omits an idempotency scope",
    patterns: [/COALESCE\((?:v_idempotency|idempotency)->>'scope', '([^']*)'\)/g],
  },
  {
    constant: "DEFAULT_IDEMPOTENCY_TTL_MS",
    value: DEFAULT_IDEMPOTENCY_TTL_MS,
    bounds: "idempotency retention applied when a caller omits ttlMs",
    patterns: [/COALESCE\(\(v_idempotency->>'ttlMs'\)::numeric, (\d+)\)/g],
  },
  {
    constant: "MAX_IDEMPOTENCY_KEY_BYTES",
    value: MAX_IDEMPOTENCY_KEY_BYTES,
    bounds: "UTF-8 size of one enqueue idempotency key",
    patterns: [
      new RegExp(
        String.raw`octet_length\(v_key\) > (\d+)${gap}RAISE EXCEPTION 'idempotency key must contain between 1 and (\d+) UTF-8 bytes'`,
        "g",
      ),
    ],
  },
  {
    constant: "MAX_IDEMPOTENCY_SCOPE_BYTES",
    value: MAX_IDEMPOTENCY_SCOPE_BYTES,
    bounds: "UTF-8 size of one enqueue idempotency scope",
    patterns: [
      new RegExp(
        String.raw`octet_length\(v_scope\) > (\d+)${gap}RAISE EXCEPTION 'idempotency scope must contain between 1 and (\d+) UTF-8 bytes'`,
        "g",
      ),
    ],
  },
  {
    constant: "MAX_IDEMPOTENCY_TTL_MS",
    value: MAX_IDEMPOTENCY_TTL_MS,
    bounds: "enqueue idempotency retention window",
    patterns: [
      new RegExp(
        String.raw`v_ttl_ms NOT BETWEEN 1 AND (\d+)${gap}RAISE EXCEPTION 'idempotency ttlMs must be an integer between 1 and (\d+)'`,
        "g",
      ),
    ],
  },
  {
    constant: "MAX_CHECKPOINT_VALUE_BYTES",
    value: MAX_CHECKPOINT_VALUE_BYTES,
    bounds: "canonical JSONB text size of one durable checkpoint value",
    patterns: [
      new RegExp(
        String.raw`octet_length\(p_checkpoint_value::text\) > (\d+)${gap}RAISE EXCEPTION 'checkpoint_value must be at most (\d+) bytes'`,
        "g",
      ),
    ],
  },
  {
    constant: "MAX_PROGRESS_VALUE_BYTES",
    value: MAX_PROGRESS_VALUE_BYTES,
    bounds: "canonical JSONB text size of latest mutable job progress",
    patterns: [
      new RegExp(
        String.raw`octet_length\(p_progress_value::text\) > (\d+)${gap}RAISE EXCEPTION 'progress_value must be at most (\d+) bytes'`,
        "g",
      ),
    ],
  },
  {
    constant: "MIN_PROGRESS_UPDATE_INTERVAL_MS",
    value: MIN_PROGRESS_UPDATE_INTERVAL_MS,
    bounds: "interval between changed progress writes from one ownership generation",
    patterns: [/IF v_elapsed_ms < (\d+) THEN/g, /ceil\((\d+) - v_elapsed_ms\)::bigint/g],
  },
  {
    constant: "MAX_WAIT_DURATION_MS",
    value: MAX_WAIT_DURATION_MS,
    bounds: "relative duration of one durable wait",
    patterns: [
      new RegExp(
        String.raw`p_duration_ms NOT BETWEEN 1 AND (\d+)${gap}RAISE EXCEPTION 'duration_ms must be between 1 and (\d+)'`,
        "g",
      ),
    ],
  },
  {
    constant: "MAX_EXECUTION_TIMEOUT_MS",
    value: MAX_EXECUTION_TIMEOUT_MS,
    bounds: "active execution budget for one attempt",
    patterns: [
      /v_execution_timeout_ms NOT BETWEEN 1 AND (\d+)/g,
      /RAISE EXCEPTION 'executionTimeoutMs must be an integer between 1 and (\d+)'/g,
    ],
  },
  {
    constant: "MAX_CANCELLATION_REQUESTED_BY_CHARACTERS",
    value: MAX_CANCELLATION_REQUESTED_BY_CHARACTERS,
    bounds: "attribution attached to a cancellation or redrive request",
    patterns: [
      /char_length\(p_requested_by\) > (\d+)/g,
      /RAISE EXCEPTION 'requested_by must contain between 1 and (\d+) characters'/g,
    ],
  },
  {
    constant: "MAX_CANCELLATION_REASON_CHARACTERS",
    value: MAX_CANCELLATION_REASON_CHARACTERS,
    bounds: "reason attached to a cancellation or redrive request",
    patterns: [
      /char_length\(p_reason\) > (\d+)/g,
      /RAISE EXCEPTION 'reason must contain between 1 and (\d+) characters'/g,
      /reason text NOT NULL CHECK \(reason <> '' AND char_length\(reason\) <= (\d+)\)/g,
    ],
  },
  {
    constant: "MAX_REDRIVE_BATCH_SIZE",
    value: MAX_REDRIVE_BATCH_SIZE,
    bounds: "failed jobs inspected or redriven by one bounded operation",
    patterns: [
      new RegExp(
        String.raw`p_limit NOT BETWEEN 1 AND (\d+)${gap}RAISE EXCEPTION '(?:dead-letter|bulk redrive) limit must be between 1 and (\d+)'`,
        "g",
      ),
    ],
  },
  {
    constant: "MAX_REDRIVE_REQUEST_ID_BYTES",
    value: MAX_REDRIVE_REQUEST_ID_BYTES,
    bounds: "UTF-8 size of a redrive request identity",
    patterns: [
      new RegExp(
        String.raw`octet_length\(p_request_id\) > (\d+)${gap}RAISE EXCEPTION 'request_id must contain between 1 and (\d+) UTF-8 bytes'`,
        "g",
      ),
      /request_id_length integer NOT NULL CHECK \(request_id_length BETWEEN 1 AND (\d+)\)/g,
    ],
  },
  {
    constant: "MAX_JOB_QUERY_PAGE_SIZE",
    value: MAX_JOB_QUERY_PAGE_SIZE,
    bounds: "rows returned by one keyset-paginated query",
    patterns: [
      new RegExp(
        String.raw`p_limit IS NULL OR p_limit NOT BETWEEN 1 AND (\d+)${gap}RAISE EXCEPTION 'limit must be between 1 and (\d+)'`,
        "g",
      ),
    ],
  },
  {
    constant: "DEFAULT_JOB_QUERY_PAYLOAD_BYTES",
    value: DEFAULT_JOB_QUERY_PAYLOAD_BYTES,
    bounds: "encoded payload size included by a list projection that omits maxBytes",
    patterns: [/v_max_bytes integer := (\d+);/g],
  },
  {
    constant: "MAX_JOB_QUERY_PAYLOAD_BYTES",
    value: MAX_JOB_QUERY_PAYLOAD_BYTES,
    bounds: "encoded payload size accepted by a list projection",
    patterns: [
      /\(v_projection->>'maxBytes'\)::numeric NOT BETWEEN 1 AND (\d+)/g,
      /RAISE EXCEPTION 'payloadProjection\.maxBytes must be an integer between 1 and (\d+)'/g,
    ],
  },
  {
    constant: "MAX_JOB_QUERY_REDACT_KEYS",
    value: MAX_JOB_QUERY_REDACT_KEYS,
    bounds: "unique top-level payload keys redacted by one list projection",
    patterns: [
      /jsonb_array_length\(v_projection->'redactKeys'\) > (\d+)/g,
      /RAISE EXCEPTION 'payloadProjection\.redactKeys must contain at most (\d+) values'/g,
    ],
  },
  {
    constant: "DEFAULT_JOB_VALUE_MAX_BYTES",
    value: DEFAULT_JOB_VALUE_MAX_BYTES,
    bounds: "canonical JSON size accepted for a payload or result when a contract omits one",
    patterns: [
      /(?:payload|result)_max_bytes integer NOT NULL DEFAULT (\d+)/g,
      /p_(?:payload|result)_max_bytes integer DEFAULT (\d+)/g,
      /COALESCE\(\(v_request->>'(?:payload|result)MaxBytes'\)::numeric, (\d+)\)/g,
    ],
  },
  {
    constant: "MAX_JOB_VALUE_MAX_BYTES",
    value: MAX_JOB_VALUE_MAX_BYTES,
    bounds: "largest configurable canonical JSON size for a payload or result",
    patterns: [
      /(?:payload|result)_max_bytes BETWEEN 1 AND (\d+)/g,
      /v_(?:payload|result)_max_bytes NOT BETWEEN 1 AND (\d+)/g,
      /RAISE EXCEPTION 'payloadMaxBytes and resultMaxBytes must be integers between 1 and (\d+)'/g,
    ],
  },
  {
    constant: "MAX_JOB_CONTRACT_SENSITIVE_KEYS",
    value: MAX_JOB_CONTRACT_SENSITIVE_KEYS,
    bounds: "persisted top-level sensitive keys for one payload or result contract",
    patterns: [
      /jsonb_array_length\(COALESCE\(v_request->'sensitive(?:Payload|Result)Keys', '\[\]'::jsonb\)\) > (\d+)/g,
      /RAISE EXCEPTION 'sensitive payload and result keys must contain at most (\d+) strings/g,
      /AND cardinality\(p_keys\) <= (\d+)/g,
    ],
  },
];

/** Every literal one pattern captured, paired with the text around it so a failure is locatable. */
interface CapturedLiteral {
  readonly literal: string;
  readonly site: string;
}

function capture(schema: string, pattern: RegExp): CapturedLiteral[] {
  const found: CapturedLiteral[] = [];
  for (const match of schema.matchAll(pattern)) {
    const site = match[0].replaceAll(/\s+/g, " ").trim();
    for (const group of match.slice(1)) {
      if (group !== undefined) found.push({ literal: group, site });
    }
  }
  return found;
}

/**
 * Report every SQL literal that no longer agrees with its constant. Exposed as a function rather than
 * inlined into the assertions so the suite can prove, against a mutated copy of the schema, that a
 * one-sided edit is actually detected.
 */
function findDrift(schema: string, against: readonly LimitRule[] = rules): string[] {
  const drift: string[] = [];
  for (const rule of against) {
    for (const pattern of rule.patterns) {
      const captured = capture(schema, pattern);
      if (captured.length === 0) {
        drift.push(`${rule.constant}: no SQL site matched ${pattern.source}`);
        continue;
      }
      for (const { literal, site } of captured) {
        if (literal !== String(rule.value)) {
          drift.push(
            `${rule.constant}: SQL says ${literal}, TypeScript says ${rule.value} — ${site}`,
          );
        }
      }
    }
  }
  return drift;
}

describe("schema limit parity", () => {
  it("agrees with every exported limit constant", async () => {
    const schema = await readFile(path.join(repository, "sql", "schema.sql"), "utf8");
    expect(findDrift(schema)).toEqual([]);
  });

  it("covers each named limit exactly once and explains what it bounds", () => {
    const names = rules.map((rule) => rule.constant);
    expect(new Set(names).size).toBe(names.length);
    for (const rule of rules) {
      expect(rule.bounds, `${rule.constant} needs a description`).not.toBe("");
      expect(rule.patterns.length, `${rule.constant} needs an SQL anchor`).toBeGreaterThan(0);
    }
  });

  it("fails when the SQL side of a limit moves alone", async () => {
    const schema = await readFile(path.join(repository, "sql", "schema.sql"), "utf8");
    // The wording stays identical; only the enforced bound moves. Anchoring on message text alone
    // would miss exactly this edit, which is why the rules anchor on the guard.
    const loosened = schema.replaceAll(
      "octet_length(p_progress_value::text) > 65536",
      "octet_length(p_progress_value::text) > 131072",
    );
    expect(loosened).not.toBe(schema);
    expect(findDrift(loosened)).toContainEqual(
      expect.stringContaining("MAX_PROGRESS_VALUE_BYTES: SQL says 131072"),
    );
  });

  it("fails when the TypeScript side of a limit moves alone", async () => {
    const schema = await readFile(path.join(repository, "sql", "schema.sql"), "utf8");
    const batchRule = rules.find((rule) => rule.constant === "MAX_ENQUEUE_BATCH_SIZE");
    expect(batchRule).toBeDefined();
    const shifted: LimitRule = {
      constant: batchRule!.constant,
      value: MAX_ENQUEUE_BATCH_SIZE + 1,
      bounds: batchRule!.bounds,
      patterns: batchRule!.patterns,
    };
    expect(findDrift(schema, [shifted])).toContainEqual(
      expect.stringContaining("MAX_ENQUEUE_BATCH_SIZE: SQL says 1000"),
    );
  });

  it("fails when an anchored SQL site disappears", async () => {
    const schema = await readFile(path.join(repository, "sql", "schema.sql"), "utf8");
    const removed = schema.replaceAll("v_max_bytes integer := 16384;", "v_max_bytes integer;");
    expect(removed).not.toBe(schema);
    expect(findDrift(removed)).toContainEqual(
      expect.stringContaining("DEFAULT_JOB_QUERY_PAYLOAD_BYTES: no SQL site matched"),
    );
  });
});
