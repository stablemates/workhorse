import { describe, expect, it } from "vitest";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue } = createIntegrationTestContext(import.meta.url);

// "é" is two UTF-8 bytes, so these names test the byte limit, not the character count.
const name256Bytes = "é".repeat(128);
const name257Bytes = `${"é".repeat(128)}q`;
const limitError = "queue name must contain at most 256 UTF-8 bytes";

const rowsFor = async (queueName: string) =>
  (
    await pool.query<{ tasks: number; controls: number }>(
      `SELECT (SELECT count(*)::integer FROM workhorse.task WHERE queue_name = $1) AS tasks,
              (SELECT count(*)::integer FROM workhorse.queue_control WHERE queue_name = $1)
                AS controls`,
      [queueName],
    )
  ).rows[0];

const debounceRequest = (queueName: string) =>
  JSON.stringify([
    {
      queue: queueName,
      type: "queue-name-limit",
      payload: {},
      debounce: { key: "queue-name-early", windowMs: 60_000, schedule: "reset" },
    },
  ]);

const scheduleDefinition = (queueName: string) =>
  JSON.stringify([
    { name: "queue-name-limit", schedule: "* * * * *", queue: queueName, type: "t" },
  ]);

// An enqueue refuses a queue name above the limit of the policy functions (SM-1939).
describe("queue name limit", () => {
  it("accepts a queue name of 256 UTF-8 bytes", async () => {
    const id = await queue.enqueue("queue-name-limit", {}, { queue: name256Bytes });
    const claimed = await queue.claim("queue-name-worker", { queue: name256Bytes });
    expect(claimed?.id).toBe(id);
  });

  it.each([
    ["257 UTF-8 bytes", name257Bytes],
    ["9,000 bytes", "q".repeat(9_000)],
  ])("refuses a queue name of %s before it writes a row", async (_label, queueName) => {
    await expect(queue.enqueue("queue-name-limit", {}, { queue: queueName })).rejects.toThrow(
      limitError,
    );
    for (const isolation of ["READ COMMITTED", "REPEATABLE READ"]) {
      const client = await pool.connect();
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        await expect(
          client.query("SELECT * FROM workhorse.enqueue_many_v1($1::jsonb)", [
            JSON.stringify([{ queue: queueName, type: "queue-name-limit", payload: {} }]),
          ]),
        ).rejects.toMatchObject({ message: limitError });
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    }
    await expect(rowsFor(queueName)).resolves.toEqual({ tasks: 0, controls: 0 });
  });

  it("refuses a long queue name in every enqueue mode", async () => {
    const requests = [
      { queue: name257Bytes, type: "queue-name-limit", payload: {} },
      {
        queue: name257Bytes,
        type: "queue-name-limit",
        payload: {},
        idempotency: { key: "queue-name-limit" },
      },
      {
        queue: name257Bytes,
        type: "queue-name-limit",
        payload: {},
        debounce: { key: "queue-name-limit", windowMs: 1_000, schedule: "reset" },
      },
      {
        queue: name257Bytes,
        type: "queue-name-limit",
        payload: {},
        throttle: { key: "queue-name-limit", windowMs: 1_000 },
      },
    ];
    for (const request of requests) {
      await expect(
        pool.query("SELECT * FROM workhorse.enqueue_many_v1($1::jsonb)", [
          JSON.stringify([request]),
        ]),
      ).rejects.toMatchObject({ message: limitError });
    }
    await expect(rowsFor(name257Bytes)).resolves.toEqual({ tasks: 0, controls: 0 });
  });

  it("refuses a long queue name before a debounce request returns early", async () => {
    const accepted = await pool.query<{ task_id: string }>(
      "SELECT task_id FROM workhorse.enqueue_many_v1($1::jsonb)",
      [debounceRequest("queue-name-debounce")],
    );
    const taskId = accepted.rows[0]!.task_id;
    // An elapsed key of a pending task makes the next same-key request return before it validates
    // the request through enqueue_batch_v1.
    await pool.query(
      `UPDATE workhorse.enqueue_idempotency SET expires_at = clock_timestamp() - interval '1 second'
        WHERE task_id = $1`,
      [taskId],
    );
    await expect(
      pool.query("SELECT * FROM workhorse.enqueue_many_v1($1::jsonb)", [
        debounceRequest(name257Bytes),
      ]),
    ).rejects.toMatchObject({ message: limitError });
    const events = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM workhorse.task_event
        WHERE task_id = $1 AND event_type = 'debounce_rejected'`,
      [taskId],
    );
    expect(events.rows[0]!.count).toBe(0);
  });

  // A schedule fire enqueues its task, so a schedule with a longer queue name could never fire.
  it("refuses a schedule definition with a long queue name", async () => {
    await expect(
      pool.query("SELECT workhorse.sync_schedule_definitions_v2('queue-name-limit', $1::jsonb)", [
        scheduleDefinition(name257Bytes),
      ]),
    ).rejects.toMatchObject({
      message: "schedule queue name must contain at most 256 UTF-8 bytes",
    });
    await expect(
      pool.query("SELECT workhorse.sync_schedule_definitions_v2('queue-name-limit', $1::jsonb)", [
        scheduleDefinition(name256Bytes),
      ]),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  // A task that an earlier release accepted can have a longer queue name. Outside read committed,
  // no queue_control row can protect its tier read, so the tier lock refuses it before any write.
  it("refuses a long queue name in the tier lock outside read committed", async () => {
    const client = await pool.connect();
    try {
      await expect(
        client.query("SELECT workhorse.lock_queue_tiers_v1(ARRAY[$1])", [name257Bytes]),
      ).resolves.toMatchObject({ rows: [{ lock_queue_tiers_v1: [] }] });
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await expect(
        client.query("SELECT workhorse.lock_queue_tiers_v1(ARRAY[$1])", [name257Bytes]),
      ).rejects.toMatchObject({ message: limitError });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    await expect(rowsFor(name257Bytes)).resolves.toEqual({ tasks: 0, controls: 0 });
  });
});
