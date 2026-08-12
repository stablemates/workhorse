import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_IDEMPOTENCY_SCOPE,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  EnqueueIdempotencyConflictError,
  installSchema,
  type Json,
  MAX_ENQUEUE_BATCH_SIZE,
  MAX_IDEMPOTENCY_KEY_BYTES,
  MAX_IDEMPOTENCY_SCOPE_BYTES,
  MAX_IDEMPOTENCY_TTL_MS,
  JobContractValidationError,
  Queue,
  type Queryable,
  Worker,
} from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue, safeKeyDigest, safeKeyPreview } = createIntegrationTestContext(
  import.meta.url,
);

describe("enqueue contracts", () => {
  it("rejects invalid and oversized payloads before accepting a durable job", async () => {
    const contractedQueue = new Queue(pool, "default", {
      contracts: {
        "mail.send": {
          currentVersion: "2026-08-10",
          versions: {
            "2026-08-10": {
              validatePayload: (value) =>
                typeof value === "object" &&
                value !== null &&
                !Array.isArray(value) &&
                typeof value.recipient === "string",
              maxPayloadBytes: 64,
            },
          },
        },
      },
    });

    await expect(contractedQueue.enqueue("mail.send", { recipient: 42 })).rejects.toBeInstanceOf(
      JobContractValidationError,
    );
    await expect(
      contractedQueue.enqueue("mail.send", { recipient: `${"a".repeat(80)}@example.test` }),
    ).rejects.toThrow(/payload exceeds its configured size limit/);
    await expect(
      pool.query("SELECT count(*)::integer AS count FROM workhorse.job"),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    await expect(
      pool.query(
        `SELECT workhorse.enqueue_v1(
          'default', 'mail.send', $1::jsonb, clock_timestamp(), 1, '{}', NULL,
          'sql-client', 16, 1048576, '{}', '{}'
        )`,
        [JSON.stringify({ recipient: "too-large-for-sql" })],
      ),
    ).rejects.toThrow(/payload exceeds its configured size limit/);
    await expect(
      pool.query("SELECT count(*)::integer AS count FROM workhorse.job"),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const id = await contractedQueue.enqueue("mail.send", { recipient: "a@example.test" });
    await expect(contractedQueue.getJob(id)).resolves.toMatchObject({
      id,
      contractVersion: "2026-08-10",
      payload: { recipient: "a@example.test" },
    });
  });

  it("fails a handler attempt when its result violates the accepted contract", async () => {
    const contractedQueue = new Queue(pool, "default", {
      contracts: {
        "invoice.total": {
          currentVersion: "1",
          versions: {
            "1": {
              validatePayload: (value) => typeof value === "object" && value !== null,
              validateResult: (value) =>
                typeof value === "object" &&
                value !== null &&
                !Array.isArray(value) &&
                typeof value.total === "number",
              maxResultBytes: 32,
            },
          },
        },
      },
    });
    const invalidId = await contractedQueue.enqueue("invoice.total", {}, { maxAttempts: 1 });
    const oversizedId = await contractedQueue.enqueue("invoice.total", {}, { maxAttempts: 1 });
    const worker = new Worker(contractedQueue, { workerId: "contract-result-worker" }).handle(
      "invoice.total",
      async (_payload, context): Promise<Json> => {
        if (context.job.id === invalidId) return { amount: 10 };
        return { total: 10, note: "x".repeat(40) };
      },
    );

    await worker.runOnce();
    await worker.runOnce();

    await expect(contractedQueue.getJob(invalidId)).resolves.toMatchObject({
      state: "failed",
      error: { name: "JobContractValidationError" },
      result: null,
    });
    await expect(contractedQueue.getJob(oversizedId)).resolves.toMatchObject({
      state: "failed",
      error: { name: "JobValueSizeLimitError" },
      result: null,
    });

    const sqlLimitedId = await contractedQueue.enqueue("invoice.total", {}, { maxAttempts: 1 });
    const sqlLimited = await contractedQueue.claim("contract-sql-result-worker");
    await expect(
      pool.query("SELECT workhorse.complete_v1($1, $2, $3, $4::jsonb)", [
        sqlLimitedId,
        "contract-sql-result-worker",
        sqlLimited!.fenceToken.toString(),
        JSON.stringify({ total: 10, note: "x".repeat(40) }),
      ]),
    ).rejects.toThrow(/result exceeds its configured size limit/);
    await expect(contractedQueue.getJob(sqlLimitedId)).resolves.toMatchObject({
      state: "active",
      result: null,
    });
  });

  it("removes sensitive handler details before durable operator views", async () => {
    const secret = "operator-view-secret";
    const contractedQueue = new Queue(pool, "default", {
      contracts: {
        "contract.failure": {
          currentVersion: "1",
          versions: { "1": { sensitivePayloadKeys: ["token"] } },
        },
      },
    });
    const id = await contractedQueue.enqueue(
      "contract.failure",
      { token: secret },
      { maxAttempts: 1 },
    );
    const claimed = await contractedQueue.claim("contract-error-worker");
    await pool.query("SELECT workhorse.fail_v1($1, $2, $3, $4::jsonb)", [
      id,
      "contract-error-worker",
      claimed!.fenceToken.toString(),
      JSON.stringify({ name: "Error", message: `could not use ${secret}`, stack: secret }),
    ]);

    const snapshot = await contractedQueue.getJob(id);
    const timeline = await contractedQueue.getJobTimeline(id);
    const deadLetters = await contractedQueue.listDeadLetters({ type: "contract.failure" });
    expect(
      JSON.stringify({ snapshot, timeline, deadLetters }, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toContain(secret);
    expect(snapshot?.error).toEqual({
      name: "RedactedJobError",
      message: "Job handler failed; details redacted",
    });
  });

  it("uses the accepted version and redacts its sensitive fields from operator reads", async () => {
    const versionOne = {
      validatePayload: (value: Json) =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        value.revision === 1,
      validateResult: (value: Json) =>
        typeof value === "object" && value !== null && !Array.isArray(value) && value.ok === true,
      sensitivePayloadKeys: ["token"],
      sensitiveResultKeys: ["receiptSecret"],
    } as const;
    const firstDeployment = new Queue(pool, "default", {
      contracts: {
        "contract.versioned": { currentVersion: "1", versions: { "1": versionOne } },
      },
    });
    const id = await firstDeployment.enqueue("contract.versioned", {
      revision: 1,
      token: "payload-secret",
      visible: "payload-visible",
    });
    const secondDeployment = new Queue(pool, "default", {
      contracts: {
        "contract.versioned": {
          currentVersion: "2",
          versions: {
            "1": versionOne,
            "2": {
              validatePayload: (value) =>
                typeof value === "object" &&
                value !== null &&
                !Array.isArray(value) &&
                value.revision === 2,
            },
          },
        },
      },
    });
    const claimed = await secondDeployment.claim("contract-version-worker");
    expect(claimed).toMatchObject({ id, contractVersion: "1", payload: { revision: 1 } });
    expect(
      await secondDeployment.complete(claimed!, "contract-version-worker", {
        ok: true,
        receiptSecret: "result-secret",
        visible: "result-visible",
      }),
    ).toBe(true);

    const snapshot = await secondDeployment.getJob(id);
    expect(snapshot).toMatchObject({
      contractVersion: "1",
      payload: { revision: 1, visible: "payload-visible" },
      result: { ok: true, visible: "result-visible" },
    });
    const listed = await secondDeployment.listJobs({
      type: "contract.versioned",
      payload: { include: true },
    });
    expect(listed.items[0]).toMatchObject({
      id,
      payload: { revision: 1, visible: "payload-visible" },
    });
    expect(snapshot?.payload).not.toHaveProperty("token");
    expect(snapshot?.result).not.toHaveProperty("receiptSecret");
    expect(listed.items[0]?.payload).not.toHaveProperty("token");
  });

  it("captures the current contract when synchronizing and firing a recurring job", async () => {
    const contractedQueue = new Queue(pool, "default", {
      contracts: {
        "contract.scheduled": {
          currentVersion: "schedule-current",
          versions: {
            "schedule-current": {
              validatePayload: (value) =>
                typeof value === "object" &&
                value !== null &&
                !Array.isArray(value) &&
                value.kind === "scheduled",
              sensitivePayloadKeys: ["token"],
            },
          },
        },
      },
    });
    await contractedQueue.syncSchedules("contract-tests", [
      {
        name: "scheduled-contract",
        schedule: "0 * * * *",
        job: {
          type: "contract.scheduled",
          payload: { kind: "scheduled", token: "schedule-secret" },
        },
      },
    ]);
    const schedule = (await contractedQueue.schedules(["contract-tests"]))[0]!;
    const id = await contractedQueue.fireSchedule(
      schedule.namespace,
      schedule.name,
      schedule.revision,
      new Date("2026-08-10T12:00:00Z"),
    );

    await expect(contractedQueue.claim("scheduled-contract-worker")).resolves.toMatchObject({
      id,
      contractVersion: "schedule-current",
      payload: { kind: "scheduled", token: "schedule-secret" },
    });
    await expect(contractedQueue.getJob(id!)).resolves.toMatchObject({
      payload: { kind: "scheduled" },
    });
    expect((await contractedQueue.getJob(id!))?.payload).not.toHaveProperty("token");
  });

  it("refuses to turn an existing v1 schema into a mixed installation", async () => {
    await pool.query("DROP SCHEMA workhorse CASCADE");
    try {
      await pool.query(`
        CREATE SCHEMA workhorse;
        CREATE TABLE workhorse.schema_version (version integer PRIMARY KEY);
        INSERT INTO workhorse.schema_version(version) VALUES (1);
        CREATE TABLE workhorse.job_current (id uuid PRIMARY KEY)`);
      await expect(installSchema(pool)).rejects.toThrow(/non-v24 or mixed workhorse schema/);
      const version = await pool.query<{ version: number }>(
        "SELECT version FROM workhorse.schema_version",
      );
      expect(version.rows).toEqual([{ version: 1 }]);
      expect(
        (await pool.query("SELECT to_regclass('workhorse.job_runtime') AS relation")).rows[0],
      ).toEqual({ relation: null });
    } finally {
      await pool.query("DROP SCHEMA IF EXISTS workhorse CASCADE");
      await installSchema(pool);
    }
  });

  it("enqueues a mixed batch atomically while preserving result and ready FIFO order", async () => {
    const runAt = new Date(Date.now() + 60_000);
    const ids = await queue.enqueueMany([
      { type: "first", payload: { order: 1 } },
      { type: "later", payload: { order: 2 }, options: { runAt } },
      { type: "third", payload: { order: 3 }, options: { maxAttempts: 5 } },
    ]);

    expect(ids).toHaveLength(3);
    expect((await queue.getJob(ids[0]!))?.type).toBe("first");
    expect((await queue.getJob(ids[1]!))?.state).toBe("scheduled");
    expect((await queue.getJob(ids[2]!))?.maxAttempts).toBe(5);
    expect((await queue.claim("worker-a"))?.id).toBe(ids[0]);
    expect((await queue.claim("worker-b"))?.id).toBe(ids[2]);

    const events = await pool.query<{ job_id: string; event_type: string }>(
      "SELECT job_id, event_type FROM workhorse.job_event WHERE event_type = 'enqueued' ORDER BY event_id",
    );
    expect(events.rows).toEqual(ids.map((jobId) => ({ job_id: jobId, event_type: "enqueued" })));
  });

  it("replays an equivalent scoped key without duplicate job, event, FIFO, or notify effects", async () => {
    const queueName = "idempotency-replay";
    const rawKey = "sensitive-request-key-that-must-never-leak";
    const scope = "tenant-a";
    const listener = await pool.connect();
    const notifications: string[] = [];
    listener.on("notification", (message) => notifications.push(message.payload ?? ""));
    try {
      await listener.query("LISTEN workhorse_jobs");
      const options = {
        queue: queueName,
        tags: ["durable"],
        retryPolicy: { type: "fixed" as const, delayMs: 25 },
        idempotency: { key: rawKey, scope, ttlMs: 60_000 },
      };
      const first = await queue.enqueue("invoice.capture", { invoiceId: "inv-1" }, options);
      const firstRuntime = await pool.query<{ sequence: string }>(
        "SELECT sequence::text FROM workhorse.job_runtime WHERE job_id = $1",
        [first],
      );
      const firstSequenceState = await pool.query<{ last_value: string; is_called: boolean }>(
        "SELECT last_value::text, is_called FROM workhorse.ready_sequence_seq",
      );
      await sleep(10);
      const replay = await queue.enqueue("invoice.capture", { invoiceId: "inv-1" }, options);
      await sleep(50);

      expect(replay).toBe(first);
      expect(
        (
          await pool.query(`SELECT
            (SELECT count(*)::integer FROM workhorse.job) AS jobs,
            (SELECT count(*)::integer FROM workhorse.job_event) AS events,
            (SELECT count(*)::integer FROM workhorse.job_runtime) AS runtimes`)
        ).rows[0],
      ).toEqual({ jobs: 1, events: 1, runtimes: 1 });
      expect(
        (
          await pool.query<{ sequence: string }>(
            "SELECT sequence::text FROM workhorse.job_runtime WHERE job_id = $1",
            [first],
          )
        ).rows,
      ).toEqual(firstRuntime.rows);
      expect(
        (
          await pool.query<{ last_value: string; is_called: boolean }>(
            "SELECT last_value::text, is_called FROM workhorse.ready_sequence_seq",
          )
        ).rows,
      ).toEqual(firstSequenceState.rows);
      expect(notifications.filter((payload) => payload === queueName)).toHaveLength(1);
      const event = await pool.query<{ details: Record<string, unknown> }>(
        "SELECT details FROM workhorse.job_event WHERE job_id = $1 AND event_type = 'enqueued'",
        [first],
      );
      const storedDigest = await pool.query<{ request_digest: string }>(
        `SELECT workhorse.sha256_hex_v1(request_fingerprint::text) AS request_digest
           FROM workhorse.enqueue_idempotency WHERE job_id = $1`,
        [first],
      );
      expect(event.rows[0]?.details).toMatchObject({
        idempotency: {
          scope,
          key_preview: safeKeyPreview(rawKey),
          key_digest: safeKeyDigest(scope, rawKey),
          key_length: [...rawKey].length,
          ttl_ms: 60_000,
          expires_at: expect.any(String),
          request_digest: storedDigest.rows[0]?.request_digest,
        },
      });
      expect(JSON.stringify(event.rows[0]?.details)).not.toContain(rawKey);
    } finally {
      await listener.query("UNLISTEN workhorse_jobs");
      listener.release();
    }
  });

  it("isolates keys by scope and applies documented defaults", async () => {
    const first = await queue.enqueue("scoped", {}, { idempotency: { key: "shared" } });
    const replay = await queue.enqueue(
      "scoped",
      {},
      {
        idempotency: {
          key: "shared",
          scope: DEFAULT_IDEMPOTENCY_SCOPE,
          ttlMs: DEFAULT_IDEMPOTENCY_TTL_MS,
        },
      },
    );
    const otherScope = await queue.enqueue(
      "scoped",
      {},
      {
        idempotency: { key: "shared", scope: "other" },
      },
    );

    expect(replay).toBe(first);
    expect(otherScope).not.toBe(first);
    expect(
      (
        await pool.query(
          `SELECT idempotency_scope, job_id
             FROM workhorse.enqueue_idempotency ORDER BY idempotency_scope`,
        )
      ).rows,
    ).toEqual([
      { idempotency_scope: "default", job_id: first },
      { idempotency_scope: "other", job_id: otherScope },
    ]);
  });

  it("raises a typed conflict for material request or retention-window mismatch", async () => {
    const rawKey = "private-conflict-key-that-must-not-leak";
    const scope = "tenant";
    const first = await queue.enqueue(
      "conflict",
      { version: 1 },
      {
        queue: "critical",
        maxAttempts: 3,
        idempotency: { key: rawKey, scope, ttlMs: 60_000 },
      },
    );
    const conflict = await queue
      .enqueue(
        "conflict",
        { version: 2 },
        {
          queue: "critical",
          maxAttempts: 3,
          idempotency: { key: rawKey, scope, ttlMs: 60_000 },
        },
      )
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(EnqueueIdempotencyConflictError);
    expect(conflict).toMatchObject({
      scope,
      keyPreview: safeKeyPreview(rawKey),
      keyDigest: safeKeyDigest(scope, rawKey),
      keyLength: [...rawKey].length,
      existingJobId: first,
      ordinal: 1,
      conflictingFields: ["payload"],
      storedRequestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      rejectedRequestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(conflict).not.toHaveProperty("key");
    expect(JSON.stringify(conflict)).not.toContain(rawKey);
    expect((conflict as Error).message).not.toContain(rawKey);
    const expectedDigests = await pool.query<{
      stored_request_digest: string;
      rejected_request_digest: string;
    }>(
      `SELECT workhorse.sha256_hex_v1(request_fingerprint::text) AS stored_request_digest,
              workhorse.sha256_hex_v1(
                jsonb_set(request_fingerprint, '{payload}', '{"version": 2}'::jsonb)::text
              ) AS rejected_request_digest
         FROM workhorse.enqueue_idempotency WHERE job_id = $1`,
      [first],
    );
    expect(conflict).toMatchObject({
      storedRequestDigest: expectedDigests.rows[0]?.stored_request_digest,
      rejectedRequestDigest: expectedDigests.rows[0]?.rejected_request_digest,
    });

    const rawSqlError = await pool
      .query("SELECT * FROM workhorse.enqueue_many_v1($1::jsonb)", [
        JSON.stringify([
          {
            queue: "critical",
            type: "conflict",
            payload: { version: 2 },
            maxAttempts: 3,
            retryPolicy: null,
            tags: [],
            idempotency: { key: rawKey, scope, ttlMs: 60_000 },
          },
        ]),
      ])
      .catch((error: unknown) => error);
    expect(rawSqlError).toMatchObject({ code: "P1001" });
    expect(JSON.stringify(rawSqlError)).not.toContain(rawKey);
    await expect(
      queue.enqueue(
        "conflict",
        { version: 1 },
        {
          queue: "critical",
          maxAttempts: 3,
          idempotency: { key: rawKey, scope, ttlMs: 60_001 },
        },
      ),
    ).rejects.toMatchObject({ conflictingFields: ["ttlMs"] });
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0],
    ).toEqual({ count: 1 });
  });

  it("treats the concurrency key as material enqueue identity", async () => {
    const idempotency = { key: "keyed-concurrency", scope: "tenant", ttlMs: 60_000 };
    const first = await queue.enqueue(
      "keyed",
      { version: 1 },
      { concurrencyKey: "tenant-a", idempotency },
    );

    await expect(
      queue.enqueue("keyed", { version: 1 }, { concurrencyKey: "tenant-a", idempotency }),
    ).resolves.toBe(first);
    await expect(
      queue.enqueue("keyed", { version: 1 }, { concurrencyKey: "tenant-b", idempotency }),
    ).rejects.toMatchObject({ conflictingFields: ["concurrencyKey"] });
    await expect(queue.getJob(first)).resolves.toMatchObject({ concurrencyKey: "tenant-a" });
  });

  it("treats tags as a set for replay while preserving the first job's stored tag order", async () => {
    const first = await queue.enqueue(
      "tag-equivalence",
      {},
      {
        tags: ["zeta", "alpha", "zeta"],
        idempotency: { key: "tag-equivalence" },
      },
    );
    const replay = await queue.enqueue(
      "tag-equivalence",
      {},
      {
        tags: ["alpha", "zeta"],
        idempotency: { key: "tag-equivalence" },
      },
    );
    expect(replay).toBe(first);
    expect((await queue.getJob(first))?.tags).toEqual(["zeta", "alpha", "zeta"]);
  });

  it("keeps omitted keyed runAt replayable but treats explicit runAt as material", async () => {
    const omitted = await queue.enqueue(
      "run-at-omitted",
      {},
      {
        idempotency: { key: "run-at-omitted" },
      },
    );
    await sleep(10);
    await expect(
      queue.enqueue("run-at-omitted", {}, { idempotency: { key: "run-at-omitted" } }),
    ).resolves.toBe(omitted);

    const firstRunAt = new Date(Date.now() + 60_000);
    await queue.enqueue(
      "run-at-explicit",
      {},
      {
        runAt: firstRunAt,
        idempotency: { key: "run-at-explicit" },
      },
    );
    await expect(
      queue.enqueue(
        "run-at-explicit",
        {},
        {
          runAt: new Date(firstRunAt.getTime() + 1),
          idempotency: { key: "run-at-explicit" },
        },
      ),
    ).rejects.toMatchObject({ conflictingFields: ["runAt"] });
  });

  it("preserves v9 default runAt serialization only for unkeyed requests", async () => {
    let serialized: Array<Record<string, unknown>> = [];
    const transaction: Queryable = {
      async query() {
        serialized = JSON.parse(String(arguments[1]?.[0])) as Array<Record<string, unknown>>;
        return { rows: [{ job_id: "unkeyed" }, { job_id: "keyed" }] } as never;
      },
    };
    await queue.enqueueMany(
      [
        { type: "unkeyed", payload: {} },
        { type: "keyed", payload: {}, options: { idempotency: { key: "keyed" } } },
      ],
      transaction,
    );
    expect(serialized[0]?.runAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(serialized[1]).not.toHaveProperty("runAt");
  });

  it("sanitizes syntactically valid malformed PostgreSQL conflict details", async () => {
    const transaction: Queryable = {
      async query() {
        throw { code: "P1001", detail: JSON.stringify({ scope: "partial" }) };
      },
    };
    const error = await queue
      .enqueue("malformed-conflict", {}, { idempotency: { key: "secret" } }, transaction)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EnqueueIdempotencyConflictError);
    expect(error).toMatchObject({
      details: {
        scope: "unknown",
        keyPreview: "unknown",
        keyDigest: "000000000000",
        keyLength: 0,
        existingJobId: "unknown",
        ordinal: 0,
        conflictingFields: [],
        storedRequestDigest: "0".repeat(64),
        rejectedRequestDigest: "0".repeat(64),
      },
    });
    expect((error as Error).message).not.toContain("undefined");
  });

  it("preserves safe PostgreSQL conflict details through adapter error causes", async () => {
    const details = {
      scope: "tenant-safe",
      keyPreview: "wrapped-key",
      keyDigest: "0123456789ab",
      keyLength: 11,
      existingJobId: "123e4567-e89b-42d3-a456-426614174000",
      ordinal: 2,
      conflictingFields: ["payload", "ttlMs"],
      storedRequestDigest: "a".repeat(64),
      rejectedRequestDigest: "b".repeat(64),
    };
    const postgresError = Object.assign(new Error("PostgreSQL conflict"), {
      detail: JSON.stringify(details),
    });
    const adapterError = Object.assign(
      new Error("Adapter query failed", { cause: postgresError }),
      {
        code: "P1001",
      },
    );
    const transaction: Queryable = {
      async query() {
        throw adapterError;
      },
    };

    const error = await queue
      .enqueue("wrapped-conflict", {}, { idempotency: { key: "wrapped-key" } }, transaction)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EnqueueIdempotencyConflictError);
    expect(error).toMatchObject({ details, ...details });
  });

  it("validates idempotency UTF-8 byte and TTL bounds in PostgreSQL", async () => {
    expect(Buffer.byteLength("é".repeat(256))).toBe(MAX_IDEMPOTENCY_KEY_BYTES);
    expect(Buffer.byteLength("é".repeat(128))).toBe(MAX_IDEMPOTENCY_SCOPE_BYTES);
    await expect(
      queue.enqueue(
        "bounds",
        {},
        {
          idempotency: {
            key: "é".repeat(256),
            scope: "é".repeat(128),
            ttlMs: MAX_IDEMPOTENCY_TTL_MS,
          },
        },
      ),
    ).resolves.toEqual(expect.any(String));
    await expect(
      queue.enqueue("bounds-minimum", {}, { idempotency: { key: "minimum-ttl", ttlMs: 1 } }),
    ).resolves.toEqual(expect.any(String));
    await expect(
      queue.enqueue("bounds", {}, { idempotency: { key: "é".repeat(257) } }),
    ).rejects.toThrow(/512 UTF-8 bytes/);
    await expect(
      queue.enqueue("bounds", {}, { idempotency: { key: "scope", scope: "é".repeat(129) } }),
    ).rejects.toThrow(/256 UTF-8 bytes/);
    for (const ttlMs of [0, 1.5, MAX_IDEMPOTENCY_TTL_MS + 1]) {
      await expect(
        queue.enqueue(
          "bounds",
          {},
          {
            idempotency: { key: `ttl-${ttlMs}`, ttlMs } as never,
          },
        ),
      ).rejects.toThrow(/ttlMs must be an integer/);
    }
    await expect(
      pool.query(
        `SELECT * FROM workhorse.enqueue_many_v1(
          '[{"queue":"default","type":"direct","idempotency":{"key":""}}]'::jsonb
        )`,
      ),
    ).rejects.toThrow(/1 and 512 UTF-8 bytes/);
    await expect(
      pool.query(
        `SELECT * FROM workhorse.enqueue_many_v1(
          '[{"queue":"default","type":"direct","idempotency":{}}]'::jsonb
        )`,
      ),
    ).rejects.toThrow(/requires a string key/);
  });

  it("serializes concurrent exact replays through the scoped unique index", async () => {
    const ids = await Promise.all(
      Array.from({ length: 12 }, () =>
        queue.enqueue(
          "concurrent",
          { stable: true },
          {
            idempotency: { key: "concurrent-key", scope: "tenant", ttlMs: 60_000 },
          },
        ),
      ),
    );
    expect(new Set(ids).size).toBe(1);
    expect(
      (
        await pool.query(`SELECT
          (SELECT count(*)::integer FROM workhorse.job) AS jobs,
          (SELECT count(*)::integer FROM workhorse.enqueue_idempotency) AS keys,
          (SELECT count(*)::integer FROM workhorse.job_event) AS events`)
      ).rows[0],
    ).toEqual({ jobs: 1, keys: 1, events: 1 });
  });

  it("prevents reverse-order overlapping keyed batches from deadlocking", async () => {
    const runBatch = async (order: readonly [string, string]) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = '2s'");
        const ids = await queue.enqueueMany(
          order.map((key) => ({
            type: `deadlock-${key}`,
            payload: { key },
            options: { idempotency: { key, scope: "deadlock", ttlMs: 60_000 } },
          })),
          client,
        );
        await client.query("COMMIT");
        return ids;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };
    const [forward, reverse] = await Promise.all([
      runBatch(["alpha", "omega"]),
      runBatch(["omega", "alpha"]),
    ]);
    expect(forward[0]).toBe(reverse[1]);
    expect(forward[1]).toBe(reverse[0]);
    expect(new Set([...forward, ...reverse]).size).toBe(2);
  });

  it("preserves same-batch ordering for keyed and unkeyed requests and rolls back conflicts", async () => {
    const ids = await queue.enqueueMany([
      { type: "keyed-a", payload: { order: 1 }, options: { idempotency: { key: "a" } } },
      { type: "keyed-a", payload: { order: 1 }, options: { idempotency: { key: "a" } } },
      { type: "unkeyed", payload: { order: 2 } },
      { type: "keyed-b", payload: { order: 3 }, options: { idempotency: { key: "b" } } },
    ]);
    expect(ids[1]).toBe(ids[0]);
    expect(new Set(ids).size).toBe(3);
    expect((await queue.claim("batch-1"))?.id).toBe(ids[0]);
    expect((await queue.claim("batch-2"))?.id).toBe(ids[2]);
    expect((await queue.claim("batch-3"))?.id).toBe(ids[3]);

    await expect(
      queue.enqueueMany([
        { type: "before", payload: {}, options: { idempotency: { key: "rollback-before" } } },
        { type: "same", payload: { value: 1 }, options: { idempotency: { key: "collision" } } },
        { type: "same", payload: { value: 2 }, options: { idempotency: { key: "collision" } } },
      ]),
    ).rejects.toMatchObject({ name: "EnqueueIdempotencyConflictError", ordinal: 3 });
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.enqueue_idempotency WHERE job_id IN (SELECT id FROM workhorse.job WHERE job_type IN ('before', 'same'))",
        )
      ).rows[0],
    ).toEqual({ count: 0 });
  });

  it("rolls back keyed enqueue with caller transactions and permits expiry reuse", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await queue.enqueue("transactional", {}, { idempotency: { key: "rolled-back" } }, client);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.enqueue_idempotency"))
        .rows[0],
    ).toEqual({ count: 0 });

    const first = await queue.enqueue(
      "expiring",
      { version: 1 },
      {
        idempotency: { key: "reuse", ttlMs: 5 },
      },
    );
    await sleep(15);
    const reused = await queue.enqueue(
      "expiring",
      { version: 2 },
      {
        idempotency: { key: "reuse", ttlMs: 5 },
      },
    );
    expect(reused).not.toBe(first);
    expect((await queue.getJob(first))?.payload).toEqual({ version: 1 });
    expect((await queue.getJob(reused))?.payload).toEqual({ version: 2 });
  });

  it("keeps omitted-key enqueue behavior fully non-deduplicating", async () => {
    const first = await queue.enqueue("ordinary", { same: true });
    const second = await queue.enqueue("ordinary", { same: true });
    expect(second).not.toBe(first);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0],
    ).toEqual({ count: 2 });
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.enqueue_idempotency"))
        .rows[0],
    ).toEqual({ count: 0 });
    const events = await pool.query<{ details: Record<string, unknown> }>(
      "SELECT details FROM workhorse.job_event ORDER BY event_id",
    );
    expect(events.rows).toHaveLength(2);
    expect(events.rows.every((row) => !("idempotency" in row.details))).toBe(true);
  });

  it("round-trips tags and supports indexed overlap filtering", async () => {
    const billingId = await queue.enqueue(
      "invoice.capture",
      { invoiceId: "inv-1" },
      { tags: ["billing", "priority"] },
    );
    const reportId = (
      await queue.enqueueMany([
        { type: "report.weekly", payload: {}, tags: ["reports", "weekly"] },
        { type: "email.send", payload: {}, tags: ["email", "transactional"] },
      ])
    )[0]!;

    await expect(queue.getJob(billingId)).resolves.toMatchObject({
      id: billingId,
      tags: ["billing", "priority"],
    });
    await expect(queue.getJob(reportId)).resolves.toMatchObject({
      id: reportId,
      tags: ["reports", "weekly"],
    });
    const tagged = await pool.query<{ id: string }>(
      "SELECT id FROM workhorse.job WHERE tags && $1::text[] ORDER BY id",
      [["billing", "weekly"]],
    );
    expect(new Set(tagged.rows.map((row) => row.id))).toEqual(new Set([billingId, reportId]));

    await expect(queue.enqueue("invalid", {}, { tags: [""] })).rejects.toThrow(/non-empty tags/);
    await expect(
      queue.enqueue(
        "too-many",
        {},
        { tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`) },
      ),
    ).rejects.toThrow(/at most 20/);
  });

  it("treats an empty enqueue batch as a query-free no-op", async () => {
    const transaction = { query: async () => Promise.reject(new Error("query must not run")) };
    await expect(queue.enqueueMany([], transaction)).resolves.toEqual([]);
  });

  it("bounds batch size client-side and classifies a batch against one timestamp", async () => {
    const transaction = { query: async () => Promise.reject(new Error("query must not run")) };
    const tooMany = Array.from({ length: MAX_ENQUEUE_BATCH_SIZE + 1 }, () => ({
      type: "bounded",
      payload: {},
    }));
    await expect(queue.enqueueMany(tooMany, transaction)).rejects.toThrow(
      `at most ${MAX_ENQUEUE_BATCH_SIZE}`,
    );

    const runAt = new Date(Date.now() + 20);
    const ids = await queue.enqueueMany(
      Array.from({ length: MAX_ENQUEUE_BATCH_SIZE }, (_, order) => ({
        type: "same-boundary",
        payload: { order },
        options: { runAt },
      })),
    );
    const states = await pool.query<{ state: string }>(
      "SELECT DISTINCT state FROM workhorse.job_runtime WHERE job_id = ANY($1::uuid[])",
      [ids],
    );
    expect(states.rows).toHaveLength(1);
  });

  it("rolls back the entire batch for invalid input and participates in caller transactions", async () => {
    await expect(
      queue.enqueueMany([
        { type: "valid", payload: {} },
        { type: "", payload: {} },
      ]),
    ).rejects.toThrow("each request requires");
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0].count,
    ).toBe(0);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await queue.enqueueMany([{ type: "rolled-back", payload: {} }], client);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0].count,
    ).toBe(0);
  });

  it("notifies once per distinct queue containing ready jobs", async () => {
    const alpha = "enqueue-many-integration-alpha";
    const beta = "enqueue-many-integration-beta";
    const listener = await pool.connect();
    const notifications: string[] = [];
    listener.on("notification", (message) => notifications.push(message.payload ?? ""));
    try {
      await listener.query("LISTEN workhorse_jobs");
      await queue.enqueueMany([
        { type: "a", payload: {}, options: { queue: alpha } },
        { type: "b", payload: {}, options: { queue: alpha } },
        { type: "c", payload: {}, options: { queue: beta } },
        {
          type: "later",
          payload: {},
          options: { queue: "scheduled-only", runAt: new Date(Date.now() + 60_000) },
        },
      ]);
      await sleep(50);
      const relevant = notifications.filter((payload) => payload === alpha || payload === beta);
      expect(relevant).toHaveLength(2);
      expect(new Set(relevant)).toEqual(new Set([alpha, beta]));
    } finally {
      await listener.query("UNLISTEN workhorse_jobs");
      listener.release();
    }
  });

  it("participates in a caller transaction", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await queue.enqueue("email", { to: "a@example.com" }, {}, client);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0].count,
    ).toBe(0);
  });

  it("defaults enqueued jobs to 25 attempts in both client and SQL entry points", async () => {
    const clientId = await queue.enqueue("client-default", {});
    const sqlResult = await pool.query<{ job_id: string }>(
      "SELECT workhorse.enqueue_v1('default', 'sql-default', '{}'::jsonb) AS job_id",
    );
    const batchResult = await pool.query<{ job_id: string }>(
      "SELECT job_id FROM workhorse.enqueue_many_v1($1::jsonb)",
      [
        JSON.stringify([
          {
            queue: "default",
            type: "batch-default",
            payload: {},
            runAt: new Date().toISOString(),
          },
        ]),
      ],
    );

    const attempts = await pool.query<{ job_type: string; max_attempts: number }>(
      "SELECT job_type, max_attempts FROM workhorse.job WHERE id = ANY($1::uuid[]) ORDER BY job_type",
      [[clientId, sqlResult.rows[0]!.job_id, batchResult.rows[0]!.job_id]],
    );
    expect(attempts.rows).toEqual([
      { job_type: "batch-default", max_attempts: 25 },
      { job_type: "client-default", max_attempts: 25 },
      { job_type: "sql-default", max_attempts: 25 },
    ]);
  });

  it("separates scheduled work and promotes only when due", async () => {
    const id = await queue.enqueue(
      "email",
      { to: "a@example.com" },
      { runAt: new Date(Date.now() + 120) },
    );
    expect((await queue.getJob(id))?.state).toBe("scheduled");
    expect(await queue.claim("worker-a")).toBeNull();
    await sleep(150);
    expect(await queue.promote()).toBe(1);
    expect((await queue.getJob(id))?.state).toBe("ready");
    expect((await queue.claim("worker-a"))?.id).toBe(id);
  });
});
