import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { RedriveIdempotencyConflictError } from "../src/index.js";
import { readDashboardTaskDetail } from "../../dashboard-server/src/server/read-model.js";
import { dashboardDatabase } from "../../dashboard-server/src/server/sql.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { createFailedTask, pool, queue, admin } = createIntegrationTestContext(import.meta.url);

describe("operator reads", () => {
  async function projectionXmin(taskId: string): Promise<string | undefined> {
    return (
      await pool.query<{ xmin: string }>(
        "SELECT xmin::text AS xmin FROM workhorse.task_query WHERE task_id = $1",
        [taskId],
      )
    ).rows[0]?.xmin;
  }

  it("preserves priority when a failed task is redriven", async () => {
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
    await expect(admin.listDeadLetters({ queue: queueName })).resolves.toMatchObject({
      items: [expect.objectContaining({ taskId: source, priority: 85 })],
    });

    const redrive = await admin.redrive(source, {
      actor: "priority-test",
      reason: "preserve dispatch rank",
      requestId: randomUUID(),
    });
    await expect(admin.getTask(redrive.targetTaskId!)).resolves.toMatchObject({
      priority: 85,
      state: "ready",
    });
  });

  it("lists only failed outcomes with filters, a stable cursor, and a partial cold index", async () => {
    const smtp = await createFailedTask({
      type: "email",
      queueName: "mail",
      payload: { recipient: "a@example.test" },
      tags: ["urgent", "tenant-a"],
      errorName: "SmtpError",
    });
    const timeout = await createFailedTask({
      type: "email",
      queueName: "mail",
      tags: ["urgent", "tenant-b"],
      errorName: "TimeoutError",
    });
    const other = await createFailedTask({
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
      `UPDATE workhorse.task_outcome SET finished_at = CASE task_id
         WHEN $1 THEN $4::timestamptz - interval '3 hours'
         WHEN $2 THEN $4::timestamptz - interval '2 hours'
         WHEN $3 THEN $4::timestamptz - interval '1 hour'
         ELSE $4::timestamptz END
       WHERE task_id = ANY($5::uuid[])`,
      [smtp, timeout, other, base, [smtp, timeout, other, succeeded]],
    );

    const first = await pool.query<{
      task_id: string;
      queue_name: string;
      task_type: string;
      tags: string[];
      error: { name: string };
      finished_at: Date;
      redrive_count: number;
    }>(`SELECT * FROM workhorse.list_dead_letters_v1($1, 1, NULL, NULL)`, [
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
        task_id: timeout,
        queue_name: "mail",
        task_type: "email",
        tags: ["urgent", "tenant-b"],
        error: { name: "TimeoutError" },
        redrive_count: 0,
      },
    ]);
    const second = await pool.query<{ task_id: string }>(
      `SELECT task_id FROM workhorse.list_dead_letters_v1($1, 10, $2, $3)`,
      [JSON.stringify({ queue: "mail", tags: ["urgent"] }), first.rows[0]!.finished_at, timeout],
    );
    expect(second.rows).toEqual([{ task_id: smtp }]);
    const errorFiltered = await pool.query<{ task_id: string }>(
      "SELECT task_id FROM workhorse.list_dead_letters_v1($1, 10, NULL, NULL)",
      [JSON.stringify({ errorName: "SmtpError" })],
    );
    expect(new Set(errorFiltered.rows.map((row) => row.task_id))).toEqual(new Set([other, smtp]));
    expect(errorFiltered.rows.some((row) => row.task_id === succeeded)).toBe(false);

    const index = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'workhorse' AND indexname = 'task_outcome_failed_finished_idx'`,
    );
    expect(index.rows[0]!.indexdef).toMatch(
      /finished_at DESC, task_id DESC.*WHERE \(state = 'failed'/,
    );
    const dispatchIndexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'workhorse' AND tablename = 'task_runtime'
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

    const redrive = await admin.redrive(sourceId, {
      actor: "test",
      reason: "verify concurrency key propagation",
      requestId: `keyed-redrive-${randomUUID()}`,
    });
    await expect(admin.getTask(redrive.targetTaskId!)).resolves.toMatchObject({
      concurrencyKey: "tenant-redrive",
    });
    await expect(admin.listDeadLetters({ queue: queueName })).resolves.toMatchObject({
      items: [{ taskId: sourceId, concurrencyKey: "tenant-redrive" }],
    });
    await expect(admin.listTasks({ queue: queueName })).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: sourceId, concurrencyKey: "tenant-redrive" }),
        expect.objectContaining({ id: redrive.targetTaskId, concurrencyKey: "tenant-redrive" }),
      ]),
    });
  });

  it("redrives once with immutable source evidence, exact copy semantics, audit, replay, and safe conflict", async () => {
    const rawRequestId = "operator-secret-request-123456";
    const deadline = new Date(Date.now() + 86_400_000);
    const source = await createFailedTask({
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
      `INSERT INTO workhorse.task_checkpoint(
         task_id, checkpoint_name, checkpoint_value, attempt, fence_token, worker_id
       ) VALUES ($1, 'source-only', '{"done":true}', 1, 1, 'fixture')`,
      [source],
    );
    await pool.query(
      `INSERT INTO workhorse.task_wait(
         task_id, wait_name, mode, duration_ms, wake_at, attempt, fence_token, worker_id, claimed_at
       ) VALUES ($1, 'source-wait', 'relative', 1000, clock_timestamp() + interval '1 second',
                 1, 1, 'fixture', clock_timestamp())`,
      [source],
    );
    const sourceBefore = await pool.query<{ outcome: Record<string, unknown> }>(
      "SELECT to_jsonb(outcome) - 'history_through_at' AS outcome FROM workhorse.task_outcome outcome WHERE task_id = $1",
      [source],
    );

    const created = await pool.query<{
      status: string;
      source_task_id: string;
      target_task_id: string;
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
      source_task_id: source,
      source_state: "failed",
      target_state: "ready",
    });
    const target = created.rows[0]!.target_task_id;
    expect(target).not.toBe(source);

    const copied = await pool.query(
      `SELECT task.queue_name, task.task_type, task.payload, task.tags, task.max_attempts,
              task.retry_policy, task.deadline_at, task.execution_timeout_ms,
              runtime.state, runtime.current_attempt, runtime.deadline_at AS runtime_deadline_at
         FROM workhorse.task task JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
        WHERE task.id = $1`,
      [target],
    );
    expect(copied.rows[0]).toMatchObject({
      queue_name: "operations",
      task_type: "rebuild-search",
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
             SELECT 1 FROM workhorse.task_checkpoint WHERE task_id = $1
             UNION ALL SELECT 1 FROM workhorse.task_wait WHERE task_id = $1
           ) durability`,
          [target],
        )
      ).rows[0]!.count,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(outcome) - 'history_through_at' AS outcome FROM workhorse.task_outcome outcome WHERE task_id = $1",
          [source],
        )
      ).rows[0],
    ).toEqual(sourceBefore.rows[0]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.task_outcome WHERE task_id = $1",
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
         FROM workhorse.task_redrive redrive WHERE source_task_id = $1`,
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
      task_id: string;
      event_type: string;
      details: unknown;
      occurred_at: Date;
    }>(
      `SELECT task_id, event_type, details, occurred_at FROM workhorse.task_event
        WHERE task_id = ANY($1::uuid[]) AND event_type IN ('redriven', 'redrive_created')
        ORDER BY event_type`,
      [[source, target]],
    );
    expect(events.rows).toMatchObject([
      { task_id: target, event_type: "redrive_created" },
      { task_id: source, event_type: "redriven" },
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
    expect(replay.rows[0]).toMatchObject({ status: "replayed", target_task_id: target });
    expect(replay.rows[0]!.requested_at).toEqual(created.rows[0]!.requested_at);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.task_redrive")).rows[0]!
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
      sourceTaskId: source,
      existingTargetTaskId: target,
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
      source_task_id: live,
      source_state: "ready",
      target_task_id: null,
      requested_at: null,
    });
    const missing = await pool.query(
      "SELECT * FROM workhorse.redrive_v1(gen_random_uuid(), 'operator', 'reason', 'missing')",
    );
    expect(missing.rows[0]).toMatchObject({
      status: "not_found",
      target_task_id: null,
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
    const source = await createFailedTask({ type: "concurrent-redrive" });
    const params = [source, "operator", "retry concurrently", "concurrent-request"];
    const [first, second] = await Promise.all([
      pool.query("SELECT * FROM workhorse.redrive_v1($1, $2, $3, $4)", params),
      pool.query("SELECT * FROM workhorse.redrive_v1($1, $2, $3, $4)", params),
    ]);
    expect(new Set([first.rows[0]!.status, second.rows[0]!.status])).toEqual(
      new Set(["redriven", "replayed"]),
    );
    expect(first.rows[0]!.target_task_id).toBe(second.rows[0]!.target_task_id);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.task_redrive")).rows[0]!
        .count,
    ).toBe(1);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.task")).rows[0]!.count,
    ).toBe(2);
  });

  it("maps dead-letter, redrive, lineage, conflict, and bulk results through the public Admin API", async () => {
    const older = await createFailedTask({
      type: "public-redrive",
      queueName: "public-redrive",
      tags: ["public"],
      errorName: "PublicFailure",
    });
    const newer = await createFailedTask({
      type: "public-redrive",
      queueName: "public-redrive",
      tags: ["public"],
      errorName: "PublicFailure",
    });
    const now = new Date(Date.now() - 10_000);
    await pool.query(
      `UPDATE workhorse.task_outcome SET finished_at = CASE task_id
         WHEN $1 THEN $3::timestamptz - interval '2 hours'
         WHEN $2 THEN $3::timestamptz - interval '1 hour' END
       WHERE task_id = ANY($4::uuid[])`,
      [older, newer, now, [older, newer]],
    );

    const firstPage = await admin.listDeadLetters({
      queue: "public-redrive",
      tags: ["public"],
      errorName: "PublicFailure",
      limit: 1,
    });
    expect(firstPage.items).toMatchObject([
      {
        taskId: newer,
        queue: "public-redrive",
        type: "public-redrive",
        error: { name: "PublicFailure" },
        redriveCount: 0,
        finishedAt: expect.any(Date),
      },
    ]);
    expect(firstPage.nextCursor).toEqual({
      finishedAt: expect.any(String),
      taskId: newer,
    });
    const secondPage = await admin.listDeadLetters({
      queue: "public-redrive",
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.items.map((item) => item.taskId)).toEqual([older]);
    expect(secondPage.nextCursor).toBeNull();

    const request = {
      actor: "public-operator",
      reason: "validate public mapping",
      requestId: "public-redrive-request",
    };
    const created = await admin.redrive(older, request);
    expect(created).toMatchObject({
      status: "redriven",
      sourceTaskId: older,
      targetTaskId: expect.any(String),
      sourceState: "failed",
      targetState: "ready",
      requestedAt: expect.any(Date),
    });
    const lineage = await admin.getRedriveLineage(older);
    expect(lineage).toMatchObject({
      records: [
        {
          sourceTaskId: older,
          targetTaskId: created.targetTaskId,
          requestedBy: request.actor,
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
      await admin.redrive(older, { ...request, reason: "materially different" });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(RedriveIdempotencyConflictError);
    expect(conflict).toMatchObject({
      details: {
        sourceTaskId: older,
        existingTargetTaskId: created.targetTaskId,
        conflictingFields: ["reason"],
      },
    });

    const preview = await admin.redriveMany(
      { queue: "public-redrive", type: "public-redrive", tags: ["public"] },
      {
        actor: "public-operator",
        reason: "bulk public mapping",
        requestId: "public-bulk-request",
      },
      { limit: 2, dryRun: true },
    );
    expect(preview).toMatchObject({
      results: [
        {
          status: "eligible",
          sourceTaskId: older,
          targetTaskId: null,
          sourceState: "failed",
          targetState: null,
          requestedAt: null,
        },
        {
          status: "eligible",
          sourceTaskId: newer,
          targetTaskId: null,
          sourceState: "failed",
          targetState: null,
          requestedAt: null,
        },
      ],
      nextCursor: null,
    });
  });

  it("bulk redrive shares filters, bounds oldest-first work, keeps dry-run pure, and replays", async () => {
    const oldest = await createFailedTask({
      type: "bulk-import",
      queueName: "bulk",
      tags: ["tenant-a", "retryable"],
      errorName: "BulkError",
    });
    const middle = await createFailedTask({
      type: "bulk-import",
      queueName: "bulk",
      tags: ["tenant-a", "retryable"],
      errorName: "BulkError",
    });
    const newest = await createFailedTask({
      type: "bulk-import",
      queueName: "bulk",
      tags: ["tenant-a", "retryable"],
      errorName: "BulkError",
    });
    await createFailedTask({
      type: "bulk-import",
      queueName: "other",
      tags: ["tenant-a", "retryable"],
      errorName: "BulkError",
    });
    const base = new Date(Date.now() - 60_000);
    await pool.query(
      `UPDATE workhorse.task_outcome SET finished_at = CASE task_id
         WHEN $1 THEN $4::timestamptz - interval '3 hours'
         WHEN $2 THEN $4::timestamptz - interval '2 hours'
         WHEN $3 THEN $4::timestamptz - interval '1 hour' END
       WHERE task_id = ANY($5::uuid[])`,
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
    const before = await pool.query<{ tasks: number; redrives: number; events: number }>(
      `SELECT (SELECT count(*)::integer FROM workhorse.task) AS tasks,
              (SELECT count(*)::integer FROM workhorse.task_redrive) AS redrives,
              (SELECT count(*)::integer FROM workhorse.task_event) AS events`,
    );
    const listener = await pool.connect();
    const notifications: string[] = [];
    listener.on("notification", (notification) => notifications.push(notification.payload ?? ""));
    await listener.query("LISTEN workhorse_tasks");
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
        await listener.query("UNLISTEN workhorse_tasks");
        listener.release();
      }
    })();
    expect(preview.rows).toMatchObject([
      {
        ordinal: 1,
        status: "eligible",
        source_task_id: oldest,
        target_task_id: null,
        requested_at: null,
      },
      {
        ordinal: 2,
        status: "eligible",
        source_task_id: middle,
        target_task_id: null,
        requested_at: null,
      },
    ]);
    const afterPreview = await pool.query<{ tasks: number; redrives: number; events: number }>(
      `SELECT (SELECT count(*)::integer FROM workhorse.task) AS tasks,
              (SELECT count(*)::integer FROM workhorse.task_redrive) AS redrives,
              (SELECT count(*)::integer FROM workhorse.task_event) AS events`,
    );
    expect(afterPreview.rows).toEqual(before.rows);

    const created = await pool.query(
      "SELECT * FROM workhorse.redrive_many_v1($1, 2, false, 'operator', 'bulk recovery', 'bulk-request') ORDER BY ordinal",
      [filter],
    );
    expect(created.rows).toMatchObject([
      { ordinal: 1, status: "redriven", source_task_id: oldest, target_state: "ready" },
      { ordinal: 2, status: "redriven", source_task_id: middle, target_state: "ready" },
    ]);
    expect(created.rows.some((row) => row.source_task_id === newest)).toBe(false);
    const replay = await pool.query(
      "SELECT * FROM workhorse.redrive_many_v1($1, 2, false, 'operator', 'bulk recovery', 'bulk-request') ORDER BY ordinal",
      [filter],
    );
    expect(replay.rows.map((row) => row.status)).toEqual(["replayed", "replayed"]);
    expect(replay.rows.map((row) => row.target_task_id)).toEqual(
      created.rows.map((row) => row.target_task_id),
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
        await createFailedTask({ type: `bulk-cursor-${index}`, queueName: "bulk-cursor" }),
      );
    }
    const [oldest, ...ties] = sourceIds;
    const boundary = new Date(Date.now() - 60_000);
    await pool.query(
      `UPDATE workhorse.task_outcome
          SET finished_at = CASE WHEN task_id = $1
            THEN $2::timestamptz - interval '1 hour' ELSE $2::timestamptz END
        WHERE task_id = ANY($3::uuid[])`,
      [oldest, boundary, sourceIds],
    );
    const orderedTies = ties[0]! < ties[1]! ? ties : [ties[1]!, ties[0]!];
    const request = {
      actor: "bulk-cursor-operator",
      reason: "drain a bounded backlog",
      requestId: "bulk-cursor-request",
    };

    const first = await admin.redriveMany({ queue: "bulk-cursor" }, request, { limit: 2 });
    expect(first.results.map((result) => result.sourceTaskId)).toEqual([oldest, orderedTies[0]]);
    expect(first.nextCursor).toEqual({ finishedAt: expect.any(String), taskId: orderedTies[0] });

    const replay = await admin.redriveMany({ queue: "bulk-cursor" }, request, { limit: 2 });
    expect(replay.results.map((result) => result.status)).toEqual(["replayed", "replayed"]);
    expect(replay.nextCursor).toEqual(first.nextCursor);

    const second = await admin.redriveMany({ queue: "bulk-cursor" }, request, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.results).toMatchObject([
      { status: "redriven", sourceTaskId: orderedTies[1], targetTaskId: expect.any(String) },
    ]);
    expect(second.nextCursor).toBeNull();
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.task_redrive")).rows[0]!
        .count,
    ).toBe(3);
  });

  it("bounds retained lineage traversal and reports truncation", async () => {
    const source = await createFailedTask({
      type: "bounded-lineage-source",
      queueName: "bounded-lineage",
    });
    const first = await admin.redrive(source, {
      actor: "lineage-operator",
      reason: "first generation",
      requestId: "lineage-first",
    });
    const firstTarget = await queue.claim("bounded-lineage-worker", { queue: "bounded-lineage" });
    expect(firstTarget?.id).toBe(first.targetTaskId);
    expect(
      await queue.fail(firstTarget!, "bounded-lineage-worker", new Error("first target failed")),
    ).toBe("failed");
    const second = await admin.redrive(first.targetTaskId!, {
      actor: "lineage-operator",
      reason: "second generation",
      requestId: "lineage-second",
    });

    expect(await admin.getRedriveLineage(source, 1)).toMatchObject({
      records: [{ sourceTaskId: source, targetTaskId: first.targetTaskId }],
      truncated: true,
    });
    expect(await admin.getRedriveLineage(second.targetTaskId!)).toMatchObject({
      records: [
        { sourceTaskId: first.targetTaskId, targetTaskId: second.targetTaskId },
        { sourceTaskId: source, targetTaskId: first.targetTaskId },
      ],
      truncated: false,
    });
  });

  it("keeps bounded branching lineage as a shared core and dashboard prefix", async () => {
    const source = await createFailedTask({
      type: "branching-lineage-source",
      queueName: "branching-lineage",
    });
    const first = await admin.redrive(source, {
      actor: "lineage-operator",
      reason: "first branch",
      requestId: "lineage-first-branch",
    });
    const second = await admin.redrive(source, {
      actor: "lineage-operator",
      reason: "second branch",
      requestId: "lineage-second-branch",
    });
    const firstTarget = await queue.claim("branching-lineage-worker", {
      queue: "branching-lineage",
    });
    expect(firstTarget?.id).toBe(first.targetTaskId);
    expect(
      await queue.fail(firstTarget!, "branching-lineage-worker", new Error("branch failed")),
    ).toBe("failed");
    const descendant = await admin.redrive(first.targetTaskId!, {
      actor: "lineage-operator",
      reason: "branch descendant",
      requestId: "lineage-branch-descendant",
    });
    await pool.query(
      `UPDATE workhorse.task_redrive
          SET requested_at = CASE target_task_id
            WHEN $1::uuid THEN clock_timestamp() - interval '3 minutes'
            WHEN $2::uuid THEN clock_timestamp() - interval '2 minutes'
            ELSE clock_timestamp() - interval '4 minutes'
          END
        WHERE target_task_id = ANY($3::uuid[])`,
      [
        first.targetTaskId,
        second.targetTaskId,
        [first.targetTaskId, second.targetTaskId, descendant.targetTaskId],
      ],
    );

    const bounded = await admin.getRedriveLineage(source, 2);
    const dashboard = await readDashboardTaskDetail(dashboardDatabase(pool), source);
    expect(bounded.truncated).toBe(true);
    expect(dashboard?.redriveLineage.records.slice(0, 2)).toMatchObject(
      bounded.records.map((edge) => ({
        sourceTaskId: edge.sourceTaskId,
        targetTaskId: edge.targetTaskId,
      })),
    );
  });

  it("protects redrive sources until descendant targets are pruned", async () => {
    const source = await createFailedTask({
      type: "retained-redrive",
      queueName: "retention-redrive",
    });
    const redrive = await pool.query<{ target_task_id: string }>(
      "SELECT target_task_id FROM workhorse.redrive_v1($1, 'operator', 'retention proof', 'retention-request')",
      [source],
    );
    const target = redrive.rows[0]!.target_task_id;
    const targetClaim = await queue.claim("retention-redrive-target", {
      queue: "retention-redrive",
    });
    expect(targetClaim?.id).toBe(target);
    expect(
      await queue.fail(targetClaim!, "retention-redrive-target", new Error("target failed")),
    ).toBe("failed");
    await pool.query("DELETE FROM workhorse.task_event WHERE task_id = ANY($1::uuid[])", [
      [source, target],
    ]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = ANY($1::uuid[])", [
      [source, target],
    ]);
    await pool.query(
      `UPDATE workhorse.task SET created_at = clock_timestamp() - interval '40 days'
        WHERE id = ANY($1::uuid[])`,
      [[source, target]],
    );
    await pool.query(
      `UPDATE workhorse.task_outcome
          SET finished_at = clock_timestamp() - interval '40 days',
              history_through_at = clock_timestamp() - interval '40 days'
        WHERE task_id = ANY($1::uuid[])`,
      [[source, target]],
    );

    await expect(
      pool.query("DELETE FROM workhorse.task WHERE id = $1", [source]),
    ).rejects.toMatchObject({
      code: "23503",
    });
    const first = await pool.query<{ pruned: number }>(
      `SELECT workhorse.prune_terminal_tasks_v1(
         clock_timestamp() - interval '30 days', clock_timestamp() - interval '30 days',
         date_trunc('day', clock_timestamp() - interval '30 days'), 10
       ) AS pruned`,
    );
    expect(first.rows[0]!.pruned).toBe(1);
    expect(
      (await pool.query("SELECT id FROM workhorse.task WHERE id = $1", [source])).rows,
    ).toHaveLength(1);
    expect(
      (await pool.query("SELECT id FROM workhorse.task WHERE id = $1", [target])).rows,
    ).toHaveLength(0);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.task_redrive")).rows[0]!
        .count,
    ).toBe(0);
    const second = await pool.query<{ pruned: number }>(
      `SELECT workhorse.prune_terminal_tasks_v1(
         clock_timestamp() - interval '30 days', clock_timestamp() - interval '30 days',
         date_trunc('day', clock_timestamp() - interval '30 days'), 10
       ) AS pruned`,
    );
    expect(second.rows[0]!.pruned).toBe(1);
    expect(
      (await pool.query("SELECT id FROM workhorse.task WHERE id = $1", [source])).rows,
    ).toHaveLength(0);
  });

  it("installs the routing projection, indexes, functions, and identity triggers", async () => {
    const objects = await pool.query<{
      projection: string | null;
      list_tasks: string | null;
      timeline: string | null;
      projection_has_payload: boolean;
    }>(`SELECT
      to_regclass('workhorse.task_query')::text AS projection,
      to_regprocedure('workhorse.list_tasks_v1(jsonb,integer,timestamp with time zone,uuid,text,jsonb)')::text AS list_tasks,
      to_regprocedure('workhorse.list_task_timeline_v1(uuid,integer,timestamp with time zone,text,uuid)')::text AS timeline,
      EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'workhorse' AND table_name = 'task_query' AND column_name = 'payload'
      ) AS projection_has_payload`);
    expect(objects.rows[0]).toEqual({
      projection: "task_query",
      list_tasks: "list_tasks_v1(jsonb,integer,timestamp with time zone,uuid,text,jsonb)",
      timeline: "list_task_timeline_v1(uuid,integer,timestamp with time zone,text,uuid)",
      projection_has_payload: false,
    });

    const indexes = await pool.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'workhorse'
         AND indexname IN (
           'task_query_created_idx', 'task_query_queue_created_idx',
           'task_query_type_created_idx',
           'attempt_history_task_time_idx'
         ) ORDER BY indexname`);
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "attempt_history_task_time_idx",
      "task_query_created_idx",
      "task_query_queue_created_idx",
      "task_query_type_created_idx",
    ]);

    const triggers = await pool.query<{ tgname: string }>(`
      SELECT tgname FROM pg_trigger
       WHERE tgrelid IN (
         'workhorse.task'::regclass,
         'workhorse.task_runtime'::regclass,
         'workhorse.task_outcome'::regclass
       )
         AND NOT tgisinternal AND tgname LIKE '%query_projection%'
       ORDER BY tgname`);
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      "task_query_projection_insert",
      "task_query_projection_update",
    ]);

    const id = await queue.enqueue("projection-routing", { ignored: true });
    expect(
      (
        await pool.query(
          `SELECT queue_name, task_type, created_at
             FROM workhorse.task_query WHERE task_id = $1`,
          [id],
        )
      ).rows[0],
    ).toMatchObject({ queue_name: "default", task_type: "projection-routing" });
  });

  it("keeps the operator projection immutable across live and terminal transitions", async () => {
    const id = await queue.enqueue(
      "projection-transitions",
      { value: 1 },
      { maxAttempts: 1, priority: 63 },
    );
    const projection = await projectionXmin(id);

    const claimed = await queue.claim("projection-worker");
    expect(claimed?.id).toBe(id);
    await sleep(5);
    expect(await queue.heartbeat(claimed!, "projection-worker", 30_000)).toBe(true);
    expect(await projectionXmin(id)).toBe(projection);

    const requested = await queue.cancel(id, { requestedBy: "operator", reason: "maintenance" });
    expect(requested.status).toBe("cancel_requested");
    expect(await projectionXmin(id)).toBe(projection);
    expect(
      (
        await pool.query("SELECT workhorse.acknowledge_cancel_v1($1, $2, $3) AS accepted", [
          id,
          "projection-worker",
          claimed!.fenceToken.toString(),
        ])
      ).rows[0]?.accepted,
    ).toBe(true);
    expect(await projectionXmin(id)).toBe(projection);
    await expect(admin.getTask(id)).resolves.toMatchObject({ state: "canceled", priority: 63 });
    expect((await admin.getTaskTimeline(id)).items.every((item) => item.priority === 63)).toBe(
      true,
    );
  });

  it("lists mixed live and terminal tasks with every filter and immutable same-time cursors", async () => {
    const createdAt = "2025-01-02T03:04:05.123456Z";
    const ids = [
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002",
      "00000000-0000-0000-0000-000000000003",
    ];
    await pool.query(
      `INSERT INTO workhorse.task(id, queue_name, task_type, payload, tags, max_attempts, created_at)
       VALUES ($1, 'query-a', 'email', '{"n":1}', ARRAY['one'], 3, $4),
              ($2, 'query-a', 'email', '{"n":2}', ARRAY['two'], 3, $4),
              ($3, 'query-b', 'report', '{"n":3}', ARRAY['three'], 3, $4)`,
      [...ids, createdAt],
    );
    await pool.query(
      `INSERT INTO workhorse.task_runtime(
         task_id, queue_name, state, current_attempt, run_at, ready_at, sequence, updated_at
       ) VALUES ($1, 'query-a', 'ready', 1, $2, $2, nextval('workhorse.ready_sequence_seq'), $2)`,
      [ids[0], createdAt],
    );
    await pool.query(
      `INSERT INTO workhorse.task_outcome(
         task_id, state, current_attempt, fence_token, run_at, result, finished_at, updated_at
       ) VALUES
         ($1, 'succeeded', 1, 1, $3, '{}', $3, $3),
         ($2, 'succeeded', 2, 1, $3, '{}', $3, $3)`,
      [ids[1], ids[2], createdAt],
    );

    const filtered = await admin.listTasks({
      queue: "query-a",
      type: "email",
      states: ["ready", "succeeded"],
      createdAfter: new Date("2025-01-02T03:04:05.123Z"),
      createdBefore: new Date("2025-01-02T03:04:05.124Z"),
      limit: 2,
    });
    expect(filtered.items.map((item) => item.id)).toEqual([ids[1], ids[0]]);
    expect(filtered.nextCursor).toBeNull();

    const first = await admin.listTasks({ limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    expect(first.nextCursor).not.toBeNull();
    await pool.query(
      `INSERT INTO workhorse.task(id, queue_name, task_type, payload, max_attempts, created_at)
       VALUES ('00000000-0000-0000-0000-000000000004', 'query-new', 'new', '{}', 1, $1)`,
      [createdAt],
    );
    await pool.query(
      `INSERT INTO workhorse.task_runtime(
         task_id, queue_name, state, run_at, ready_at, sequence, updated_at
       ) VALUES (
         '00000000-0000-0000-0000-000000000004', 'query-new', 'ready', $1, $1,
         nextval('workhorse.ready_sequence_seq'), $1
       )`,
      [createdAt],
    );
    const second = await admin.listTasks({ limit: 2, cursor: first.nextCursor! });
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
        `INSERT INTO workhorse.task(id, queue_name, task_type, payload, max_attempts, created_at)
         VALUES ($1, 'bound', $2, '{"secret":"x"}', 1, '2025-02-01T00:00:00Z')`,
        [id, type],
      );
      await pool.query(
        `INSERT INTO workhorse.task_runtime(
           task_id, queue_name, state, run_at, ready_at, sequence, updated_at
         ) VALUES ($1, 'bound', 'ready', '2025-02-01T00:00:00Z', '2025-02-01T00:00:00Z',
           nextval('workhorse.ready_sequence_seq'), '2025-02-01T00:00:00Z')`,
        [id],
      );
    }
    const first = await admin.listTasks({ type: "bound-a", limit: 1 });
    expect(first.nextCursor?.signature).toMatch(/^[0-9a-f]{16}$/);
    await expect(
      admin.listTasks({ type: "bound-b", limit: 1, cursor: first.nextCursor! }),
    ).rejects.toThrow(/cursor does not match/);
    await expect(
      admin.listTasks({
        type: "bound-a",
        limit: 1,
        cursor: first.nextCursor!,
        payload: { include: true },
      }),
    ).rejects.toThrow(/cursor does not match/);
    await expect(
      pool.query("SELECT * FROM workhorse.list_tasks_v1('{}', 1, now(), NULL, NULL, '{}')"),
    ).rejects.toThrow(/provided together/);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      const timezoneFirst = await client.query<{
        task_id: string;
        cursor_created_at: string;
        cursor_signature: string;
      }>(
        `SELECT task_id, cursor_created_at::text AS cursor_created_at, cursor_signature
           FROM workhorse.list_tasks_v1($1, 1, NULL, NULL, NULL, '{}')`,
        [JSON.stringify({ type: "bound-a", createdAfter: "2025-01-01T00:00:00Z" })],
      );
      await client.query("SET LOCAL TIME ZONE 'Pacific/Honolulu'");
      const timezoneSecond = await client.query(
        `SELECT task_id
           FROM workhorse.list_tasks_v1($1, 1, $2, $3, $4, '{}')`,
        [
          JSON.stringify({ type: "bound-a", createdAfter: "2025-01-01T00:00:00Z" }),
          timezoneFirst.rows[0]!.cursor_created_at,
          timezoneFirst.rows[0]!.task_id,
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
      [() => admin.listTasks(null as never), /listTasks query must be an object/],
      [() => admin.listTasks({ limit: 0 }), /listTasks limit must be an integer between 1 and/],
      [() => admin.listTasks({ createdAfter: invalidDate }), /must be a finite Date/],
      [() => admin.listTasks({ states: ["ready", "ready"] }), /states must be unique: ready/],
      [
        () =>
          admin.listTasks({
            cursor: { createdAt: "now", taskId: "task", signature: "signature", extra: true },
          } as never),
        /listTasks cursor contains unknown field: extra/,
      ],
      [
        () =>
          admin.getTaskTimeline("task-a", {
            cursor: {
              taskId: "task-b",
              occurredAt: "now",
              kind: "event",
              recordId: "record",
            },
          }),
        /cursor taskId must match the requested taskId/,
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
    const omitted = await admin.listTasks({ type: "payload-object" });
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
    const included = await admin.listTasks({
      type: "payload-object",
      payload: { include: true, maxBytes: expectedBytes, redactKeys: ["secret"] },
    });
    expect(included.items[0]).toMatchObject({
      payload: { visible: "ok", nested: { secret: "retained" } },
      payloadStatus: "included",
      payloadBytes: expectedBytes,
    });
    const tooLarge = await admin.listTasks({
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
        await admin.listTasks({
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
        pool.query("SELECT * FROM workhorse.list_tasks_v1('{}', 1, NULL, NULL, NULL, $1)", [
          JSON.stringify(projection),
        ]),
      ).rejects.toThrow(message);
    }
    await expect(admin.listTasks({ unknown: true } as never)).rejects.toThrow(
      /query contains unknown field: unknown/,
    );
    await expect(
      admin.listTasks({ payload: { include: true, unknown: true } } as never),
    ).rejects.toThrow(/payload contains unknown field: unknown/);
  });

  it("uses routing projection indexes and authoritative lifecycle rows for creation scans", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const queries = [
        [
          "task_query_created_idx",
          "SELECT * FROM workhorse.task_query ORDER BY created_at DESC, task_id DESC LIMIT 10",
        ],
        [
          "task_query_queue_created_idx",
          "SELECT * FROM workhorse.task_query WHERE queue_name = 'q' ORDER BY created_at DESC, task_id DESC LIMIT 10",
        ],
        [
          "task_query_type_created_idx",
          "SELECT * FROM workhorse.task_query WHERE task_type = 't' ORDER BY created_at DESC, task_id DESC LIMIT 10",
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
          /task_runtime_(ready|scheduled|expired_active|deadline|timeout)_idx/,
        );
      }
      const combinedPlan = (
        await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (COSTS OFF)
          SELECT query_row.*
            FROM workhorse.task_query query_row
            JOIN LATERAL (
              SELECT runtime.state FROM workhorse.task_runtime runtime
               WHERE runtime.task_id = query_row.task_id
              UNION ALL
              SELECT outcome.state FROM workhorse.task_outcome outcome
               WHERE outcome.task_id = query_row.task_id
            ) lifecycle ON true
           WHERE query_row.queue_name = 'query-a'
             AND query_row.task_type = 'email'
             AND lifecycle.state = ANY (ARRAY['ready', 'succeeded'])
           ORDER BY query_row.created_at DESC, query_row.task_id DESC LIMIT 10`)
      ).rows
        .map((row) => row["QUERY PLAN"])
        .join("\n");
      expect(combinedPlan).toMatch(/task_query_(queue|type)_created_idx/);
      expect(combinedPlan).toMatch(/task_(runtime|outcome)_pkey/);
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("merges retained events and attempts with stable equal-time cursors and exact final pages", async () => {
    const taskId = "20000000-0000-0000-0000-000000000001";
    const sameTime = "2025-03-04T05:06:07.123456Z";
    await pool.query(
      `INSERT INTO workhorse.task(id, queue_name, task_type, payload, max_attempts, created_at)
       VALUES ($1, 'timeline', 'timeline', '{}', 2, '2025-03-01T00:00:00Z')`,
      [taskId],
    );
    await pool.query(
      `INSERT INTO workhorse.task_event(task_id, attempt, event_type, details, occurred_at)
       VALUES ($1, 1, 'older-event', '{"position":"old"}', '2025-03-04T05:06:06Z'),
              ($1, 1, 'same-event', '{"position":"event"}', $2),
              ($1, 2, 'newer-event', '{"position":"new"}', '2025-03-04T05:06:08Z')`,
      [taskId, sameTime],
    );
    await pool.query(
      `INSERT INTO workhorse.attempt_history(
         task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at,
         finished_at, error, occurred_at
       ) VALUES (
         $1, 1, 7, 'timeline-worker', 'retry', '2025-03-04T05:00:00Z',
         '2025-03-04T05:00:01Z', $2, '{"name":"Retry"}', $2
       )`,
      [taskId, sameTime],
    );

    const first = await admin.getTaskTimeline(taskId, { limit: 2 });
    expect(first.items.every((item) => item.priority === 0)).toBe(true);
    expect(
      first.items.map((item) => [item.kind, item.kind === "event" ? item.eventType : item.outcome]),
    ).toEqual([
      ["event", "newer-event"],
      ["event", "same-event"],
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await admin.getTaskTimeline(taskId, { limit: 2, cursor: first.nextCursor! });
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
      pool.query("SELECT * FROM workhorse.list_task_timeline_v1($1, 10, $2, 'unknown', $3)", [
        taskId,
        sameTime,
        first.nextCursor!.recordId,
      ]),
    ).rejects.toThrow(/event or attempt/);
    await expect(
      pool.query("SELECT * FROM workhorse.list_task_timeline_v1($1, 10, $2, NULL, $3)", [
        taskId,
        sameTime,
        first.nextCursor!.recordId,
      ]),
    ).rejects.toThrow(/provided together/);

    await pool.query("DELETE FROM workhorse.task_event WHERE task_id = $1", [taskId]);
    expect((await admin.getTaskTimeline(taskId)).items.map((item) => item.kind)).toEqual([
      "attempt",
    ]);
    await pool.query("DELETE FROM workhorse.attempt_history WHERE task_id = $1", [taskId]);
    expect((await admin.getTaskTimeline(taskId)).items).toEqual([]);
    expect((await admin.getTaskTimeline("20000000-0000-0000-0000-000000000099")).items).toEqual([]);
  });
});
