import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { installSchema, RedriveIdempotencyConflictError } from "../src/index.js";
import { readDashboardJobDetail } from "../packages/dashboard/src/server/read-model.js";
import { dashboardDatabase } from "../packages/dashboard/src/server/sql.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { createFailedJob, pool, queue } = createIntegrationTestContext(import.meta.url);

describe("operator reads", () => {
  it("preserves priority when a failed job is redriven", async () => {
    const queueName = `priority-redrive-${randomUUID()}`;
    const source = await queue.enqueue("priority-source", null, {
      queue: queueName,
      priority: 85,
      maxAttempts: 1,
    });
    const claimed = await queue.claim("priority-redrive-worker", { queue: queueName });
    expect(claimed).toMatchObject({ id: source, priority: 85 });
    await expect(
      queue.fail(claimed!, "priority-redrive-worker", new Error("terminal priority")),
    ).resolves.toBe("failed");
    await expect(queue.listDeadLetters({ queue: queueName })).resolves.toMatchObject({
      items: [expect.objectContaining({ jobId: source, priority: 85 })],
    });

    const redrive = await queue.redrive(source, {
      requestedBy: "priority-test",
      reason: "preserve dispatch rank",
      requestId: randomUUID(),
    });
    await expect(queue.getJob(redrive.targetJobId!)).resolves.toMatchObject({
      priority: 85,
      state: "ready",
    });
  });

  it("lists only failed outcomes with filters, a stable cursor, and a partial cold index", async () => {
    const smtp = await createFailedJob({
      type: "email",
      queueName: "mail",
      payload: { recipient: "a@example.test" },
      tags: ["urgent", "tenant-a"],
      errorName: "SmtpError",
    });
    const timeout = await createFailedJob({
      type: "email",
      queueName: "mail",
      tags: ["urgent", "tenant-b"],
      errorName: "TimeoutError",
    });
    const other = await createFailedJob({
      type: "report",
      queueName: "analytics",
      tags: ["urgent"],
      errorName: "SmtpError",
    });
    const succeeded = await queue.enqueue("email", {}, { queue: "mail", tags: ["urgent"] });
    const succeededClaim = await queue.claim("successful-list-fixture", { queue: "mail" });
    expect(succeededClaim?.id).toBe(succeeded);
    expect(await queue.complete(succeededClaim!, "successful-list-fixture", { ok: true })).toBe(
      true,
    );

    const base = new Date(Date.now() - 60_000);
    await pool.query(
      `UPDATE workhorse.job_outcome SET finished_at = CASE job_id
         WHEN $1 THEN $4::timestamptz - interval '3 hours'
         WHEN $2 THEN $4::timestamptz - interval '2 hours'
         WHEN $3 THEN $4::timestamptz - interval '1 hour'
         ELSE $4::timestamptz END
       WHERE job_id = ANY($5::uuid[])`,
      [smtp, timeout, other, base, [smtp, timeout, other, succeeded]],
    );

    const first = await pool.query<{
      job_id: string;
      queue_name: string;
      job_type: string;
      tags: string[];
      error: { name: string };
      finished_at: Date;
      redrive_count: number;
    }>(`SELECT * FROM workhorse.list_dead_letters_v2($1, 1, NULL, NULL)`, [
      JSON.stringify({
        queue: "mail",
        type: "email",
        tags: ["urgent"],
        finishedAfter: new Date(base.getTime() - 4 * 3_600_000).toISOString(),
        finishedBefore: base.toISOString(),
      }),
    ]);
    expect(first.rows).toMatchObject([
      {
        job_id: timeout,
        queue_name: "mail",
        job_type: "email",
        tags: ["urgent", "tenant-b"],
        error: { name: "TimeoutError" },
        redrive_count: 0,
      },
    ]);
    const second = await pool.query<{ job_id: string }>(
      `SELECT job_id FROM workhorse.list_dead_letters_v2($1, 10, $2, $3)`,
      [JSON.stringify({ queue: "mail", tags: ["urgent"] }), first.rows[0]!.finished_at, timeout],
    );
    expect(second.rows).toEqual([{ job_id: smtp }]);
    const errorFiltered = await pool.query<{ job_id: string }>(
      "SELECT job_id FROM workhorse.list_dead_letters_v2($1, 10, NULL, NULL)",
      [JSON.stringify({ errorName: "SmtpError" })],
    );
    expect(new Set(errorFiltered.rows.map((row) => row.job_id))).toEqual(new Set([other, smtp]));
    expect(errorFiltered.rows.some((row) => row.job_id === succeeded)).toBe(false);

    const index = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'workhorse' AND indexname = 'job_outcome_failed_finished_idx'`,
    );
    expect(index.rows[0]!.indexdef).toMatch(
      /finished_at DESC, job_id DESC.*WHERE \(state = 'failed'/,
    );
    const dispatchIndexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'workhorse' AND tablename = 'job_runtime'
          AND indexdef ILIKE '%failed%'`,
    );
    expect(dispatchIndexes.rows).toEqual([]);
  });

  it("preserves concurrency keys through redrive and operator projections", async () => {
    const queueName = `keyed-redrive-${randomUUID()}`;
    const sourceId = await queue.enqueue(
      "keyed-redrive",
      { source: true },
      { queue: queueName, concurrencyKey: "tenant-redrive", maxAttempts: 1 },
    );
    const claimed = await queue.claim("keyed-redrive-worker", { queue: queueName });
    expect(claimed?.id).toBe(sourceId);
    await queue.fail(claimed!, "keyed-redrive-worker", new Error("failed"));

    const redrive = await queue.redrive(sourceId, {
      requestedBy: "test",
      reason: "verify concurrency key propagation",
      requestId: `keyed-redrive-${randomUUID()}`,
    });
    await expect(queue.getJob(redrive.targetJobId!)).resolves.toMatchObject({
      concurrencyKey: "tenant-redrive",
    });
    await expect(queue.listDeadLetters({ queue: queueName })).resolves.toMatchObject({
      items: [{ jobId: sourceId, concurrencyKey: "tenant-redrive" }],
    });
    await expect(queue.listJobs({ queue: queueName })).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: sourceId, concurrencyKey: "tenant-redrive" }),
        expect.objectContaining({ id: redrive.targetJobId, concurrencyKey: "tenant-redrive" }),
      ]),
    });
  });

  it("redrives once with immutable source evidence, exact copy semantics, audit, replay, and safe conflict", async () => {
    const rawRequestId = "operator-secret-request-123456";
    const deadline = new Date(Date.now() + 86_400_000);
    const source = await createFailedJob({
      type: "rebuild-search",
      queueName: "operations",
      payload: { tenant: 42, full: true },
      tags: ["tenant-42", "manual"],
      deadline,
      executionTimeoutMs: 12_345,
      retryPolicy: { type: "fixed", delayMs: 250 },
      errorName: "SearchUnavailable",
    });
    await pool.query(
      `INSERT INTO workhorse.job_checkpoint(
         job_id, checkpoint_name, checkpoint_value, attempt, fence_token, worker_id
       ) VALUES ($1, 'source-only', '{"done":true}', 1, 1, 'fixture')`,
      [source],
    );
    await pool.query(
      `INSERT INTO workhorse.job_wait(
         job_id, wait_name, mode, duration_ms, wake_at, attempt, fence_token, worker_id, claimed_at
       ) VALUES ($1, 'source-wait', 'relative', 1000, clock_timestamp() + interval '1 second',
                 1, 1, 'fixture', clock_timestamp())`,
      [source],
    );
    const sourceBefore = await pool.query<{ outcome: Record<string, unknown> }>(
      "SELECT to_jsonb(outcome) - 'history_through_at' AS outcome FROM workhorse.job_outcome outcome WHERE job_id = $1",
      [source],
    );

    const created = await pool.query<{
      status: string;
      source_job_id: string;
      target_job_id: string;
      source_state: string;
      target_state: string;
      requested_at: Date;
    }>("SELECT * FROM workhorse.redrive_v1($1, $2, $3, $4)", [
      source,
      "on-call@example.test",
      "upstream recovered",
      rawRequestId,
    ]);
    expect(created.rows[0]).toMatchObject({
      status: "redriven",
      source_job_id: source,
      source_state: "failed",
      target_state: "ready",
    });
    const target = created.rows[0]!.target_job_id;
    expect(target).not.toBe(source);

    const copied = await pool.query(
      `SELECT job.queue_name, job.job_type, job.payload, job.tags, job.max_attempts,
              job.retry_policy, job.deadline_at, job.execution_timeout_ms,
              runtime.state, runtime.current_attempt, runtime.deadline_at AS runtime_deadline_at
         FROM workhorse.job job JOIN workhorse.job_runtime runtime ON runtime.job_id = job.id
        WHERE job.id = $1`,
      [target],
    );
    expect(copied.rows[0]).toMatchObject({
      queue_name: "operations",
      job_type: "rebuild-search",
      payload: { tenant: 42, full: true },
      tags: ["tenant-42", "manual"],
      max_attempts: 1,
      retry_policy: { type: "fixed", delayMs: 250 },
      deadline_at: null,
      execution_timeout_ms: "12345",
      state: "ready",
      current_attempt: 1,
      runtime_deadline_at: null,
    });
    expect(
      (
        await pool.query(
          `SELECT count(*)::integer AS count FROM (
             SELECT 1 FROM workhorse.job_checkpoint WHERE job_id = $1
             UNION ALL SELECT 1 FROM workhorse.job_wait WHERE job_id = $1
           ) durability`,
          [target],
        )
      ).rows[0]!.count,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(outcome) - 'history_through_at' AS outcome FROM workhorse.job_outcome outcome WHERE job_id = $1",
          [source],
        )
      ).rows[0],
    ).toEqual(sourceBefore.rows[0]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.job_outcome WHERE job_id = $1",
          [target],
        )
      ).rows[0]!.count,
    ).toBe(0);

    const audit = await pool.query<{
      requested_by: string;
      reason: string;
      request_id_preview: string;
      request_id_digest: string;
      request_id_length: number;
      source_state: string;
      target_initial_state: string;
      row_text: string;
    }>(
      `SELECT requested_by, reason, request_id_preview, request_id_digest, request_id_length,
              source_state, target_initial_state, to_jsonb(redrive)::text AS row_text
         FROM workhorse.job_redrive redrive WHERE source_job_id = $1`,
      [source],
    );
    expect(audit.rows[0]).toMatchObject({
      requested_by: "on-call@example.test",
      reason: "upstream recovered",
      request_id_preview: "operator…3456",
      request_id_digest: expect.stringMatching(/^[0-9a-f]{12}$/),
      request_id_length: rawRequestId.length,
      source_state: "failed",
      target_initial_state: "ready",
    });
    expect(audit.rows[0]!.row_text).not.toContain(rawRequestId);
    const events = await pool.query<{
      job_id: string;
      event_type: string;
      details: unknown;
      occurred_at: Date;
    }>(
      `SELECT job_id, event_type, details, occurred_at FROM workhorse.job_event
        WHERE job_id = ANY($1::uuid[]) AND event_type IN ('redriven', 'redrive_created')
        ORDER BY event_type`,
      [[source, target]],
    );
    expect(events.rows).toMatchObject([
      { job_id: target, event_type: "redrive_created" },
      { job_id: source, event_type: "redriven" },
    ]);
    expect(events.rows.every((event) => event.occurred_at >= created.rows[0]!.requested_at)).toBe(
      true,
    );
    expect(JSON.stringify(events.rows)).not.toContain(rawRequestId);

    const replay = await pool.query("SELECT * FROM workhorse.redrive_v1($1, $2, $3, $4)", [
      source,
      "on-call@example.test",
      "upstream recovered",
      rawRequestId,
    ]);
    expect(replay.rows[0]).toMatchObject({ status: "replayed", target_job_id: target });
    expect(replay.rows[0]!.requested_at).toEqual(created.rows[0]!.requested_at);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job_redrive")).rows[0]!
        .count,
    ).toBe(1);

    let conflict: unknown;
    try {
      await pool.query("SELECT * FROM workhorse.redrive_v1($1, $2, $3, $4)", [
        source,
        "on-call@example.test",
        "different reason",
        rawRequestId,
      ]);
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({ code: "P1002" });
    const detail = JSON.parse(String((conflict as { detail: string }).detail));
    expect(detail).toMatchObject({
      sourceJobId: source,
      existingTargetJobId: target,
      requestIdPreview: "operator…3456",
      requestIdLength: rawRequestId.length,
      conflictingFields: ["reason"],
    });
    expect(JSON.stringify(detail)).not.toContain(rawRequestId);

    const live = await queue.enqueue("not-failed", {});
    const notFailed = await pool.query(
      "SELECT * FROM workhorse.redrive_v1($1, 'operator', 'reason', 'live')",
      [live],
    );
    expect(notFailed.rows[0]).toMatchObject({
      status: "not_failed",
      source_job_id: live,
      source_state: "ready",
      target_job_id: null,
      requested_at: null,
    });
    const missing = await pool.query(
      "SELECT * FROM workhorse.redrive_v1(gen_random_uuid(), 'operator', 'reason', 'missing')",
    );
    expect(missing.rows[0]).toMatchObject({
      status: "not_found",
      target_job_id: null,
      requested_at: null,
    });
    await expect(
      pool.query("SELECT * FROM workhorse.redrive_v1($1, '', 'reason', 'bounded')", [source]),
    ).rejects.toThrow(/requested_by/);
    await expect(
      pool.query("SELECT * FROM workhorse.redrive_v1($1, 'operator', 'reason', $2)", [
        source,
        "é".repeat(257),
      ]),
    ).rejects.toThrow(/512 UTF-8 bytes/);
  });

  it("serializes concurrent exact redrive requests to one target", async () => {
    const source = await createFailedJob({ type: "concurrent-redrive" });
    const params = [source, "operator", "retry concurrently", "concurrent-request"];
    const [first, second] = await Promise.all([
      pool.query("SELECT * FROM workhorse.redrive_v1($1, $2, $3, $4)", params),
      pool.query("SELECT * FROM workhorse.redrive_v1($1, $2, $3, $4)", params),
    ]);
    expect(new Set([first.rows[0]!.status, second.rows[0]!.status])).toEqual(
      new Set(["redriven", "replayed"]),
    );
    expect(first.rows[0]!.target_job_id).toBe(second.rows[0]!.target_job_id);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job_redrive")).rows[0]!
        .count,
    ).toBe(1);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0]!.count,
    ).toBe(2);
  });

  it("maps dead-letter, redrive, lineage, conflict, and bulk results through the public Queue API", async () => {
    const older = await createFailedJob({
      type: "public-redrive",
      queueName: "public-redrive",
      tags: ["public"],
      errorName: "PublicFailure",
    });
    const newer = await createFailedJob({
      type: "public-redrive",
      queueName: "public-redrive",
      tags: ["public"],
      errorName: "PublicFailure",
    });
    const now = new Date(Date.now() - 10_000);
    await pool.query(
      `UPDATE workhorse.job_outcome SET finished_at = CASE job_id
         WHEN $1 THEN $3::timestamptz - interval '2 hours'
         WHEN $2 THEN $3::timestamptz - interval '1 hour' END
       WHERE job_id = ANY($4::uuid[])`,
      [older, newer, now, [older, newer]],
    );

    const firstPage = await queue.listDeadLetters({
      queue: "public-redrive",
      tags: ["public"],
      errorName: "PublicFailure",
      limit: 1,
    });
    expect(firstPage.items).toMatchObject([
      {
        jobId: newer,
        queue: "public-redrive",
        type: "public-redrive",
        error: { name: "PublicFailure" },
        redriveCount: 0,
        finishedAt: expect.any(Date),
      },
    ]);
    expect(firstPage.nextCursor).toEqual({
      finishedAt: expect.any(String),
      jobId: newer,
    });
    const secondPage = await queue.listDeadLetters({
      queue: "public-redrive",
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.items.map((item) => item.jobId)).toEqual([older]);
    expect(secondPage.nextCursor).toBeNull();

    const request = {
      requestedBy: "public-operator",
      reason: "validate public mapping",
      requestId: "public-redrive-request",
    };
    const created = await queue.redrive(older, request);
    expect(created).toMatchObject({
      status: "redriven",
      sourceJobId: older,
      targetJobId: expect.any(String),
      sourceState: "failed",
      targetState: "ready",
      requestedAt: expect.any(Date),
    });
    const lineage = await queue.getRedriveLineage(older);
    expect(lineage).toMatchObject({
      records: [
        {
          sourceJobId: older,
          targetJobId: created.targetJobId,
          requestedBy: request.requestedBy,
          reason: request.reason,
          requestIdPreview: "public-r…uest",
          requestIdDigest: expect.stringMatching(/^[0-9a-f]{12}$/),
          requestIdLength: request.requestId.length,
          sourceState: "failed",
          targetInitialState: "ready",
          requestedAt: expect.any(Date),
        },
      ],
      truncated: false,
    });
    let conflict: unknown;
    try {
      await queue.redrive(older, { ...request, reason: "materially different" });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(RedriveIdempotencyConflictError);
    expect(conflict).toMatchObject({
      details: {
        sourceJobId: older,
        existingTargetJobId: created.targetJobId,
        conflictingFields: ["reason"],
      },
    });

    const preview = await queue.redriveMany(
      { queue: "public-redrive", type: "public-redrive", tags: ["public"] },
      {
        requestedBy: "public-operator",
        reason: "bulk public mapping",
        requestId: "public-bulk-request",
      },
      { limit: 2, dryRun: true },
    );
    expect(preview).toMatchObject({
      results: [
        {
          status: "eligible",
          sourceJobId: older,
          targetJobId: null,
          sourceState: "failed",
          targetState: null,
          requestedAt: null,
        },
        {
          status: "eligible",
          sourceJobId: newer,
          targetJobId: null,
          sourceState: "failed",
          targetState: null,
          requestedAt: null,
        },
      ],
      nextCursor: null,
    });
  });

  it("bulk redrive shares filters, bounds oldest-first work, keeps dry-run pure, and replays", async () => {
    const oldest = await createFailedJob({
      type: "bulk-import",
      queueName: "bulk",
      tags: ["tenant-a", "retryable"],
      errorName: "BulkError",
    });
    const middle = await createFailedJob({
      type: "bulk-import",
      queueName: "bulk",
      tags: ["tenant-a", "retryable"],
      errorName: "BulkError",
    });
    const newest = await createFailedJob({
      type: "bulk-import",
      queueName: "bulk",
      tags: ["tenant-a", "retryable"],
      errorName: "BulkError",
    });
    await createFailedJob({
      type: "bulk-import",
      queueName: "other",
      tags: ["tenant-a", "retryable"],
      errorName: "BulkError",
    });
    const base = new Date(Date.now() - 60_000);
    await pool.query(
      `UPDATE workhorse.job_outcome SET finished_at = CASE job_id
         WHEN $1 THEN $4::timestamptz - interval '3 hours'
         WHEN $2 THEN $4::timestamptz - interval '2 hours'
         WHEN $3 THEN $4::timestamptz - interval '1 hour' END
       WHERE job_id = ANY($5::uuid[])`,
      [oldest, middle, newest, base, [oldest, middle, newest]],
    );
    const filter = JSON.stringify({
      queue: "bulk",
      type: "bulk-import",
      tags: ["tenant-a", "retryable"],
      errorName: "BulkError",
      finishedAfter: new Date(base.getTime() - 4 * 3_600_000).toISOString(),
      finishedBefore: base.toISOString(),
    });
    const before = await pool.query<{ jobs: number; redrives: number; events: number }>(
      `SELECT (SELECT count(*)::integer FROM workhorse.job) AS jobs,
              (SELECT count(*)::integer FROM workhorse.job_redrive) AS redrives,
              (SELECT count(*)::integer FROM workhorse.job_event) AS events`,
    );
    const listener = await pool.connect();
    const notifications: string[] = [];
    listener.on("notification", (notification) => notifications.push(notification.payload ?? ""));
    await listener.query("LISTEN workhorse_jobs");
    const preview = await (async () => {
      try {
        const result = await pool.query(
          "SELECT * FROM workhorse.redrive_many_v1($1, 2, true, 'operator', 'bulk recovery', 'bulk-request') ORDER BY ordinal",
          [filter],
        );
        await sleep(25);
        expect(notifications).toEqual([]);
        return result;
      } finally {
        await listener.query("UNLISTEN workhorse_jobs");
        listener.release();
      }
    })();
    expect(preview.rows).toMatchObject([
      {
        ordinal: 1,
        status: "eligible",
        source_job_id: oldest,
        target_job_id: null,
        requested_at: null,
      },
      {
        ordinal: 2,
        status: "eligible",
        source_job_id: middle,
        target_job_id: null,
        requested_at: null,
      },
    ]);
    const afterPreview = await pool.query<{ jobs: number; redrives: number; events: number }>(
      `SELECT (SELECT count(*)::integer FROM workhorse.job) AS jobs,
              (SELECT count(*)::integer FROM workhorse.job_redrive) AS redrives,
              (SELECT count(*)::integer FROM workhorse.job_event) AS events`,
    );
    expect(afterPreview.rows).toEqual(before.rows);

    const created = await pool.query(
      "SELECT * FROM workhorse.redrive_many_v1($1, 2, false, 'operator', 'bulk recovery', 'bulk-request') ORDER BY ordinal",
      [filter],
    );
    expect(created.rows).toMatchObject([
      { ordinal: 1, status: "redriven", source_job_id: oldest, target_state: "ready" },
      { ordinal: 2, status: "redriven", source_job_id: middle, target_state: "ready" },
    ]);
    expect(created.rows.some((row) => row.source_job_id === newest)).toBe(false);
    const replay = await pool.query(
      "SELECT * FROM workhorse.redrive_many_v1($1, 2, false, 'operator', 'bulk recovery', 'bulk-request') ORDER BY ordinal",
      [filter],
    );
    expect(replay.rows.map((row) => row.status)).toEqual(["replayed", "replayed"]);
    expect(replay.rows.map((row) => row.target_job_id)).toEqual(
      created.rows.map((row) => row.target_job_id),
    );
    await expect(
      pool.query(
        "SELECT * FROM workhorse.redrive_many_v1('{}', 1001, true, 'operator', 'reason', 'request')",
      ),
    ).rejects.toThrow(/between 1 and 1000/);
  });

  it("advances bounded bulk redrive across cursor pages including equal finish times", async () => {
    const sourceIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      sourceIds.push(
        await createFailedJob({ type: `bulk-cursor-${index}`, queueName: "bulk-cursor" }),
      );
    }
    const [oldest, ...ties] = sourceIds;
    const boundary = new Date(Date.now() - 60_000);
    await pool.query(
      `UPDATE workhorse.job_outcome
          SET finished_at = CASE WHEN job_id = $1
            THEN $2::timestamptz - interval '1 hour' ELSE $2::timestamptz END
        WHERE job_id = ANY($3::uuid[])`,
      [oldest, boundary, sourceIds],
    );
    const orderedTies = ties[0]! < ties[1]! ? ties : [ties[1]!, ties[0]!];
    const request = {
      requestedBy: "bulk-cursor-operator",
      reason: "drain a bounded backlog",
      requestId: "bulk-cursor-request",
    };

    const first = await queue.redriveMany({ queue: "bulk-cursor" }, request, { limit: 2 });
    expect(first.results.map((result) => result.sourceJobId)).toEqual([oldest, orderedTies[0]]);
    expect(first.nextCursor).toEqual({ finishedAt: expect.any(String), jobId: orderedTies[0] });

    const replay = await queue.redriveMany({ queue: "bulk-cursor" }, request, { limit: 2 });
    expect(replay.results.map((result) => result.status)).toEqual(["replayed", "replayed"]);
    expect(replay.nextCursor).toEqual(first.nextCursor);

    const second = await queue.redriveMany({ queue: "bulk-cursor" }, request, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.results).toMatchObject([
      { status: "redriven", sourceJobId: orderedTies[1], targetJobId: expect.any(String) },
    ]);
    expect(second.nextCursor).toBeNull();
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job_redrive")).rows[0]!
        .count,
    ).toBe(3);
  });

  it("bounds retained lineage traversal and reports truncation", async () => {
    const source = await createFailedJob({
      type: "bounded-lineage-source",
      queueName: "bounded-lineage",
    });
    const first = await queue.redrive(source, {
      requestedBy: "lineage-operator",
      reason: "first generation",
      requestId: "lineage-first",
    });
    const firstTarget = await queue.claim("bounded-lineage-worker", { queue: "bounded-lineage" });
    expect(firstTarget?.id).toBe(first.targetJobId);
    expect(
      await queue.fail(firstTarget!, "bounded-lineage-worker", new Error("first target failed")),
    ).toBe("failed");
    const second = await queue.redrive(first.targetJobId!, {
      requestedBy: "lineage-operator",
      reason: "second generation",
      requestId: "lineage-second",
    });

    expect(await queue.getRedriveLineage(source, 1)).toMatchObject({
      records: [{ sourceJobId: source, targetJobId: first.targetJobId }],
      truncated: true,
    });
    expect(await queue.getRedriveLineage(second.targetJobId!)).toMatchObject({
      records: [
        { sourceJobId: first.targetJobId, targetJobId: second.targetJobId },
        { sourceJobId: source, targetJobId: first.targetJobId },
      ],
      truncated: false,
    });
  });

  it("keeps bounded branching lineage as a shared core and dashboard prefix", async () => {
    const source = await createFailedJob({
      type: "branching-lineage-source",
      queueName: "branching-lineage",
    });
    const first = await queue.redrive(source, {
      requestedBy: "lineage-operator",
      reason: "first branch",
      requestId: "lineage-first-branch",
    });
    const second = await queue.redrive(source, {
      requestedBy: "lineage-operator",
      reason: "second branch",
      requestId: "lineage-second-branch",
    });
    const firstTarget = await queue.claim("branching-lineage-worker", {
      queue: "branching-lineage",
    });
    expect(firstTarget?.id).toBe(first.targetJobId);
    expect(
      await queue.fail(firstTarget!, "branching-lineage-worker", new Error("branch failed")),
    ).toBe("failed");
    const descendant = await queue.redrive(first.targetJobId!, {
      requestedBy: "lineage-operator",
      reason: "branch descendant",
      requestId: "lineage-branch-descendant",
    });
    await pool.query(
      `UPDATE workhorse.job_redrive
          SET requested_at = CASE target_job_id
            WHEN $1::uuid THEN clock_timestamp() - interval '3 minutes'
            WHEN $2::uuid THEN clock_timestamp() - interval '2 minutes'
            ELSE clock_timestamp() - interval '4 minutes'
          END
        WHERE target_job_id = ANY($3::uuid[])`,
      [
        first.targetJobId,
        second.targetJobId,
        [first.targetJobId, second.targetJobId, descendant.targetJobId],
      ],
    );

    const bounded = await queue.getRedriveLineage(source, 2);
    const dashboard = await readDashboardJobDetail(dashboardDatabase(pool), source);
    expect(bounded.truncated).toBe(true);
    expect(dashboard?.redriveLineage.records.slice(0, 2)).toMatchObject(
      bounded.records.map((edge) => ({
        sourceJobId: edge.sourceJobId,
        targetJobId: edge.targetJobId,
      })),
    );
  });

  it("protects redrive sources until descendant targets are pruned", async () => {
    const source = await createFailedJob({
      type: "retained-redrive",
      queueName: "retention-redrive",
    });
    const redrive = await pool.query<{ target_job_id: string }>(
      "SELECT target_job_id FROM workhorse.redrive_v1($1, 'operator', 'retention proof', 'retention-request')",
      [source],
    );
    const target = redrive.rows[0]!.target_job_id;
    const targetClaim = await queue.claim("retention-redrive-target", {
      queue: "retention-redrive",
    });
    expect(targetClaim?.id).toBe(target);
    expect(
      await queue.fail(targetClaim!, "retention-redrive-target", new Error("target failed")),
    ).toBe("failed");
    await pool.query("DELETE FROM workhorse.job_event WHERE job_id = ANY($1::uuid[])", [
      [source, target],
    ]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE job_id = ANY($1::uuid[])", [
      [source, target],
    ]);
    await pool.query(
      `UPDATE workhorse.job SET created_at = clock_timestamp() - interval '40 days'
        WHERE id = ANY($1::uuid[])`,
      [[source, target]],
    );
    await pool.query(
      `UPDATE workhorse.job_outcome
          SET finished_at = clock_timestamp() - interval '40 days',
              history_through_at = clock_timestamp() - interval '40 days'
        WHERE job_id = ANY($1::uuid[])`,
      [[source, target]],
    );

    await expect(
      pool.query("DELETE FROM workhorse.job WHERE id = $1", [source]),
    ).rejects.toMatchObject({
      code: "23503",
    });
    const first = await pool.query<{ pruned: number }>(
      `SELECT workhorse.prune_terminal_jobs_v1(
         clock_timestamp() - interval '30 days', clock_timestamp() - interval '30 days',
         date_trunc('day', clock_timestamp() - interval '30 days'), 10
       ) AS pruned`,
    );
    expect(first.rows[0]!.pruned).toBe(1);
    expect(
      (await pool.query("SELECT id FROM workhorse.job WHERE id = $1", [source])).rows,
    ).toHaveLength(1);
    expect(
      (await pool.query("SELECT id FROM workhorse.job WHERE id = $1", [target])).rows,
    ).toHaveLength(0);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job_redrive")).rows[0]!
        .count,
    ).toBe(0);
    const second = await pool.query<{ pruned: number }>(
      `SELECT workhorse.prune_terminal_jobs_v1(
         clock_timestamp() - interval '30 days', clock_timestamp() - interval '30 days',
         date_trunc('day', clock_timestamp() - interval '30 days'), 10
       ) AS pruned`,
    );
    expect(second.rows[0]!.pruned).toBe(1);
    expect(
      (await pool.query("SELECT id FROM workhorse.job WHERE id = $1", [source])).rows,
    ).toHaveLength(0);
  });

  it("installs and reconverges the v16 operator projection, indexes, functions, and lifecycle triggers", async () => {
    const objects = await pool.query<{
      projection: string | null;
      list_jobs: string | null;
      timeline: string | null;
      projection_has_payload: boolean;
    }>(`SELECT
      to_regclass('workhorse.job_query')::text AS projection,
      to_regprocedure('workhorse.list_jobs_v2(jsonb,integer,timestamp with time zone,uuid,text,jsonb)')::text AS list_jobs,
      to_regprocedure('workhorse.list_job_timeline_v2(uuid,integer,timestamp with time zone,text,bigint)')::text AS timeline,
      EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'workhorse' AND table_name = 'job_query' AND column_name = 'payload'
      ) AS projection_has_payload`);
    expect(objects.rows[0]).toEqual({
      projection: "job_query",
      list_jobs: "list_jobs_v2(jsonb,integer,timestamp with time zone,uuid,text,jsonb)",
      timeline: "list_job_timeline_v2(uuid,integer,timestamp with time zone,text,bigint)",
      projection_has_payload: false,
    });

    const indexes = await pool.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'workhorse'
         AND indexname IN (
           'job_query_created_idx', 'job_query_queue_created_idx',
           'job_query_type_created_idx', 'job_query_state_created_idx',
           'attempt_history_job_time_idx'
         ) ORDER BY indexname`);
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "attempt_history_job_time_idx",
      "job_query_created_idx",
      "job_query_queue_created_idx",
      "job_query_state_created_idx",
      "job_query_type_created_idx",
    ]);

    const triggers = await pool.query<{ tgname: string }>(`
      SELECT tgname FROM pg_trigger
       WHERE tgrelid IN ('workhorse.job_runtime'::regclass, 'workhorse.job_outcome'::regclass)
         AND NOT tgisinternal AND tgname LIKE '%query_projection%'
       ORDER BY tgname`);
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      "job_outcome_query_projection_insert",
      "job_runtime_query_projection_insert",
      "job_runtime_query_projection_update",
    ]);

    const id = await queue.enqueue("projection-converge", { ignored: true });
    await pool.query("UPDATE workhorse.job_query SET state = 'scheduled' WHERE job_id = $1", [id]);
    await installSchema(pool);
    expect(
      (await pool.query("SELECT state FROM workhorse.job_query WHERE job_id = $1", [id])).rows[0],
    ).toEqual({ state: "ready" });
  });

  it("projects meaningful live and terminal transitions without heartbeat churn", async () => {
    const id = await queue.enqueue(
      "projection-transitions",
      { value: 1 },
      { maxAttempts: 1, priority: 63 },
    );
    expect(
      (
        await pool.query(
          `SELECT query.state, query.current_attempt, job.priority
             FROM workhorse.job_query query
             JOIN workhorse.job job ON job.id = query.job_id
            WHERE query.job_id = $1`,
          [id],
        )
      ).rows[0],
    ).toEqual({ state: "ready", current_attempt: 1, priority: 63 });

    const claimed = await queue.claim("projection-worker");
    expect(claimed?.id).toBe(id);
    const active = await pool.query<{ state: string; updated_at: Date }>(
      "SELECT state, updated_at FROM workhorse.job_query WHERE job_id = $1",
      [id],
    );
    expect(active.rows[0]?.state).toBe("active");
    await sleep(5);
    expect(await queue.heartbeat(claimed!, "projection-worker", 30_000)).toBe(true);
    const afterHeartbeat = await pool.query<{ updated_at: Date }>(
      "SELECT updated_at FROM workhorse.job_query WHERE job_id = $1",
      [id],
    );
    expect(afterHeartbeat.rows[0]?.updated_at.getTime()).toBe(active.rows[0]?.updated_at.getTime());

    const requested = await queue.cancel(id, { requestedBy: "operator", reason: "maintenance" });
    expect(requested.status).toBe("cancel_requested");
    expect(
      (
        await pool.query(
          `SELECT state, cancel_requested_by, cancel_reason,
                  cancel_requested_at IS NOT NULL AS requested
             FROM workhorse.job_query WHERE job_id = $1`,
          [id],
        )
      ).rows[0],
    ).toEqual({
      state: "active",
      cancel_requested_by: "operator",
      cancel_reason: "maintenance",
      requested: true,
    });
    expect(
      (
        await pool.query("SELECT workhorse.acknowledge_cancel_v1($1, $2, $3) AS accepted", [
          id,
          "projection-worker",
          claimed!.fenceToken.toString(),
        ])
      ).rows[0]?.accepted,
    ).toBe(true);
    expect(
      (
        await pool.query(
          `SELECT query.state, query.cancel_requested_by, query.cancel_reason, job.priority
             FROM workhorse.job_query query
             JOIN workhorse.job job ON job.id = query.job_id
            WHERE query.job_id = $1`,
          [id],
        )
      ).rows[0],
    ).toEqual({
      state: "canceled",
      cancel_requested_by: "operator",
      cancel_reason: "maintenance",
      priority: 63,
    });
    await expect(queue.getJob(id)).resolves.toMatchObject({ state: "canceled", priority: 63 });
    expect((await queue.getJobTimeline(id)).items.every((item) => item.priority === 63)).toBe(true);
  });

  it("lists mixed live and terminal jobs with every filter and immutable same-time cursors", async () => {
    const createdAt = "2025-01-02T03:04:05.123456Z";
    const ids = [
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002",
      "00000000-0000-0000-0000-000000000003",
    ];
    await pool.query(
      `INSERT INTO workhorse.job(id, queue_name, job_type, payload, tags, max_attempts, created_at)
       VALUES ($1, 'query-a', 'email', '{"n":1}', ARRAY['one'], 3, $4),
              ($2, 'query-a', 'email', '{"n":2}', ARRAY['two'], 3, $4),
              ($3, 'query-b', 'report', '{"n":3}', ARRAY['three'], 3, $4)`,
      [...ids, createdAt],
    );
    await pool.query(
      `INSERT INTO workhorse.job_runtime(
         job_id, queue_name, state, current_attempt, run_at, ready_at, sequence, updated_at
       ) VALUES ($1, 'query-a', 'ready', 1, $2, $2, nextval('workhorse.ready_sequence_seq'), $2)`,
      [ids[0], createdAt],
    );
    await pool.query(
      `INSERT INTO workhorse.job_outcome(
         job_id, state, current_attempt, fence_token, run_at, result, finished_at, updated_at
       ) VALUES
         ($1, 'succeeded', 1, 1, $3, '{}', $3, $3),
         ($2, 'succeeded', 2, 1, $3, '{}', $3, $3)`,
      [ids[1], ids[2], createdAt],
    );

    const filtered = await queue.listJobs({
      queue: "query-a",
      type: "email",
      states: ["ready", "succeeded"],
      createdAfter: new Date("2025-01-02T03:04:05.123Z"),
      createdBefore: new Date("2025-01-02T03:04:05.124Z"),
      limit: 2,
    });
    expect(filtered.items.map((item) => item.id)).toEqual([ids[1], ids[0]]);
    expect(filtered.nextCursor).toBeNull();

    const first = await queue.listJobs({ limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    expect(first.nextCursor).not.toBeNull();
    await pool.query(
      `INSERT INTO workhorse.job(id, queue_name, job_type, payload, max_attempts, created_at)
       VALUES ('00000000-0000-0000-0000-000000000004', 'query-new', 'new', '{}', 1, $1)`,
      [createdAt],
    );
    await pool.query(
      `INSERT INTO workhorse.job_runtime(
         job_id, queue_name, state, run_at, ready_at, sequence, updated_at
       ) VALUES (
         '00000000-0000-0000-0000-000000000004', 'query-new', 'ready', $1, $1,
         nextval('workhorse.ready_sequence_seq'), $1
       )`,
      [createdAt],
    );
    const second = await queue.listJobs({ limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);
    // This is the documented weak consistency boundary: a concurrent row before the cursor is not
    // duplicated into the later page, and no snapshot claim is made for it.
    expect(second.items.some((item) => item.id.endsWith("0004"))).toBe(false);
  });

  it("binds list cursors to normalized filters and payload projections", async () => {
    for (const [id, type] of [
      ["10000000-0000-0000-0000-000000000001", "bound-a"],
      ["10000000-0000-0000-0000-000000000002", "bound-a"],
    ] as const) {
      await pool.query(
        `INSERT INTO workhorse.job(id, queue_name, job_type, payload, max_attempts, created_at)
         VALUES ($1, 'bound', $2, '{"secret":"x"}', 1, '2025-02-01T00:00:00Z')`,
        [id, type],
      );
      await pool.query(
        `INSERT INTO workhorse.job_runtime(
           job_id, queue_name, state, run_at, ready_at, sequence, updated_at
         ) VALUES ($1, 'bound', 'ready', '2025-02-01T00:00:00Z', '2025-02-01T00:00:00Z',
           nextval('workhorse.ready_sequence_seq'), '2025-02-01T00:00:00Z')`,
        [id],
      );
    }
    const first = await queue.listJobs({ type: "bound-a", limit: 1 });
    expect(first.nextCursor?.signature).toMatch(/^[0-9a-f]{16}$/);
    await expect(
      queue.listJobs({ type: "bound-b", limit: 1, cursor: first.nextCursor! }),
    ).rejects.toThrow(/cursor does not match/);
    await expect(
      queue.listJobs({
        type: "bound-a",
        limit: 1,
        cursor: first.nextCursor!,
        payload: { include: true },
      }),
    ).rejects.toThrow(/cursor does not match/);
    await expect(
      pool.query("SELECT * FROM workhorse.list_jobs_v2('{}', 1, now(), NULL, NULL, '{}')"),
    ).rejects.toThrow(/provided together/);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      const timezoneFirst = await client.query<{
        job_id: string;
        cursor_created_at: string;
        cursor_signature: string;
      }>(
        `SELECT job_id, cursor_created_at::text AS cursor_created_at, cursor_signature
           FROM workhorse.list_jobs_v2($1, 1, NULL, NULL, NULL, '{}')`,
        [JSON.stringify({ type: "bound-a", createdAfter: "2025-01-01T00:00:00Z" })],
      );
      await client.query("SET LOCAL TIME ZONE 'Pacific/Honolulu'");
      const timezoneSecond = await client.query(
        `SELECT job_id
           FROM workhorse.list_jobs_v2($1, 1, $2, $3, $4, '{}')`,
        [
          JSON.stringify({ type: "bound-a", createdAfter: "2025-01-01T00:00:00Z" }),
          timezoneFirst.rows[0]!.cursor_created_at,
          timezoneFirst.rows[0]!.job_id,
          timezoneFirst.rows[0]!.cursor_signature,
        ],
      );
      expect(timezoneSecond.rowCount).toBe(1);
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("preserves the public validation contract while operator queries move behind a module", async () => {
    const invalidDate = new Date(Number.NaN);
    const calls: Array<readonly [() => Promise<unknown>, RegExp]> = [
      [() => queue.listJobs(null as never), /listJobs query must be an object/],
      [() => queue.listJobs({ limit: 0 }), /listJobs limit must be an integer between 1 and/],
      [() => queue.listJobs({ createdAfter: invalidDate }), /must be a finite Date/],
      [() => queue.listJobs({ states: ["ready", "ready"] }), /states must be unique: ready/],
      [
        () =>
          queue.listJobs({
            cursor: { createdAt: "now", jobId: "job", signature: "signature", extra: true },
          } as never),
        /listJobs cursor contains unknown field: extra/,
      ],
      [
        () =>
          queue.getJobTimeline("job-a", {
            cursor: {
              jobId: "job-b",
              occurredAt: "now",
              kind: "event",
              recordId: "record",
            },
          }),
        /cursor jobId must match the requested jobId/,
      ],
    ];

    for (const [call, message] of calls) await expect(call()).rejects.toThrow(message);
  });

  it("omits payloads by default and redacts before enforcing byte bounds", async () => {
    const objectId = await queue.enqueue("payload-object", {
      visible: "ok",
      secret: "x".repeat(10_000),
      nested: { secret: "retained" },
    });
    const omitted = await queue.listJobs({ type: "payload-object" });
    expect(omitted.items[0]).toMatchObject({
      id: objectId,
      payload: null,
      payloadStatus: "omitted",
      payloadBytes: null,
    });
    const expectedBytes = Number(
      (
        await pool.query<{ bytes: number }>(
          `SELECT octet_length(($1::jsonb - ARRAY['secret'])::text)::integer AS bytes`,
          [
            JSON.stringify({
              visible: "ok",
              secret: "x".repeat(10_000),
              nested: { secret: "retained" },
            }),
          ],
        )
      ).rows[0]?.bytes,
    );
    const included = await queue.listJobs({
      type: "payload-object",
      payload: { include: true, maxBytes: expectedBytes, redactKeys: ["secret"] },
    });
    expect(included.items[0]).toMatchObject({
      payload: { visible: "ok", nested: { secret: "retained" } },
      payloadStatus: "included",
      payloadBytes: expectedBytes,
    });
    const tooLarge = await queue.listJobs({
      type: "payload-object",
      payload: { include: true, maxBytes: expectedBytes - 1, redactKeys: ["secret"] },
    });
    expect(tooLarge.items[0]).toMatchObject({
      payload: null,
      payloadStatus: "too_large",
      payloadBytes: expectedBytes,
    });

    await queue.enqueue("payload-scalar", "secret");
    await queue.enqueue("payload-array", ["secret", { secret: "retained" }]);
    expect(
      (
        await queue.listJobs({
          states: ["ready"],
          payload: { include: true, maxBytes: 1_024, redactKeys: ["secret"] },
        })
      ).items
        .filter((item) => item.type.startsWith("payload-"))
        .map((item) => item.payload),
    ).toEqual([
      ["secret", { secret: "retained" }],
      "secret",
      { visible: "ok", nested: { secret: "retained" } },
    ]);

    for (const [projection, message] of [
      [{ include: true, maxBytes: 0 }, /between 1 and 1048576/],
      [{ include: true, maxBytes: 1048577 }, /between 1 and 1048576/],
      [{ include: true, redactKeys: ["x", "x"] }, /unique/],
      [{ include: true, redactKeys: [""] }, /1 to 200/],
      [{ include: true, unknown: true }, /permits only/],
    ] as const) {
      await expect(
        pool.query("SELECT * FROM workhorse.list_jobs_v2('{}', 1, NULL, NULL, NULL, $1)", [
          JSON.stringify(projection),
        ]),
      ).rejects.toThrow(message);
    }
    await expect(queue.listJobs({ unknown: true } as never)).rejects.toThrow(
      /query contains unknown field: unknown/,
    );
    await expect(
      queue.listJobs({ payload: { include: true, unknown: true } } as never),
    ).rejects.toThrow(/payload contains unknown field: unknown/);
  });

  it("uses only dedicated operator indexes for global, queue, type, and state creation scans", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const queries = [
        [
          "job_query_created_idx",
          "SELECT * FROM workhorse.job_query ORDER BY created_at DESC, job_id DESC LIMIT 10",
        ],
        [
          "job_query_queue_created_idx",
          "SELECT * FROM workhorse.job_query WHERE queue_name = 'q' ORDER BY created_at DESC, job_id DESC LIMIT 10",
        ],
        [
          "job_query_type_created_idx",
          "SELECT * FROM workhorse.job_query WHERE job_type = 't' ORDER BY created_at DESC, job_id DESC LIMIT 10",
        ],
        [
          "job_query_state_created_idx",
          "SELECT * FROM workhorse.job_query WHERE state = 'ready' ORDER BY created_at DESC, job_id DESC LIMIT 10",
        ],
      ] as const;
      for (const [indexName, sql] of queries) {
        const plan = (
          await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (COSTS OFF) ${sql}`)
        ).rows
          .map((row) => row["QUERY PLAN"])
          .join("\n");
        expect(plan).toContain(indexName);
        expect(plan).not.toMatch(
          /job_runtime_(ready|scheduled|expired_active|deadline|timeout)_idx/,
        );
      }
      const combinedPlan = (
        await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (COSTS OFF)
          SELECT * FROM workhorse.job_query
           WHERE queue_name = 'query-a'
             AND job_type = 'email'
             AND state = ANY (ARRAY['ready', 'succeeded'])
           ORDER BY created_at DESC, job_id DESC LIMIT 10`)
      ).rows
        .map((row) => row["QUERY PLAN"])
        .join("\n");
      expect(combinedPlan).toMatch(/job_query_(queue|type|state)_created_idx/);
      expect(combinedPlan).not.toMatch(
        /job_runtime_(ready|scheduled|expired_active|deadline|timeout)_idx/,
      );
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("merges retained events and attempts with stable equal-time cursors and exact final pages", async () => {
    const jobId = "20000000-0000-0000-0000-000000000001";
    const sameTime = "2025-03-04T05:06:07.123456Z";
    await pool.query(
      `INSERT INTO workhorse.job(id, queue_name, job_type, payload, max_attempts, created_at)
       VALUES ($1, 'timeline', 'timeline', '{}', 2, '2025-03-01T00:00:00Z')`,
      [jobId],
    );
    await pool.query(
      `INSERT INTO workhorse.job_event(job_id, attempt, event_type, details, occurred_at)
       VALUES ($1, 1, 'older-event', '{"position":"old"}', '2025-03-04T05:06:06Z'),
              ($1, 1, 'same-event', '{"position":"event"}', $2),
              ($1, 2, 'newer-event', '{"position":"new"}', '2025-03-04T05:06:08Z')`,
      [jobId, sameTime],
    );
    await pool.query(
      `INSERT INTO workhorse.attempt_history(
         job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at,
         finished_at, error, occurred_at
       ) VALUES (
         $1, 1, 7, 'timeline-worker', 'retry', '2025-03-04T05:00:00Z',
         '2025-03-04T05:00:01Z', $2, '{"name":"Retry"}', $2
       )`,
      [jobId, sameTime],
    );

    const first = await queue.getJobTimeline(jobId, { limit: 2 });
    expect(first.items.every((item) => item.priority === 0)).toBe(true);
    expect(
      first.items.map((item) => [item.kind, item.kind === "event" ? item.eventType : item.outcome]),
    ).toEqual([
      ["event", "newer-event"],
      ["event", "same-event"],
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await queue.getJobTimeline(jobId, { limit: 2, cursor: first.nextCursor! });
    expect(second.items.every((item) => item.priority === 0)).toBe(true);
    expect(second.items.map((item) => item.kind)).toEqual(["attempt", "event"]);
    expect(second.items[0]).toMatchObject({
      kind: "attempt",
      attempt: 1,
      fenceToken: 7n,
      workerId: "timeline-worker",
      outcome: "retry",
      error: { name: "Retry" },
    });
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((item) => `${item.kind}:${item.recordId}`))
        .size,
    ).toBe(4);

    await expect(
      pool.query("SELECT * FROM workhorse.list_job_timeline_v2($1, 10, $2, 'unknown', 1)", [
        jobId,
        sameTime,
      ]),
    ).rejects.toThrow(/event or attempt/);
    await expect(
      pool.query("SELECT * FROM workhorse.list_job_timeline_v2($1, 10, $2, NULL, 1)", [
        jobId,
        sameTime,
      ]),
    ).rejects.toThrow(/provided together/);

    await pool.query("DELETE FROM workhorse.job_event WHERE job_id = $1", [jobId]);
    expect((await queue.getJobTimeline(jobId)).items.map((item) => item.kind)).toEqual(["attempt"]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE job_id = $1", [jobId]);
    expect((await queue.getJobTimeline(jobId)).items).toEqual([]);
    expect((await queue.getJobTimeline("20000000-0000-0000-0000-000000000099")).items).toEqual([]);
  });
});
