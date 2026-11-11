import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ClaimedTask, Json } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

// SM-1983: fail_v2 and fast_fail_v2 cut the name, the message, and the stack of a failure envelope.
// SM-1982: save_checkpoint_v3 answers value_too_large for a value that PostgreSQL cannot store.
// The first versions keep their answers, so a worker of an earlier release keeps working.

const { pool, queue, admin, adminAudit } = createIntegrationTestContext(import.meta.url);

type MessagePart = string | { repeat: string; count: number } | { unpairedSurrogate: string };

interface EnvelopeFixture {
  id: string;
  error: { message: string | MessagePart[] };
  redactErrorDetails: boolean;
  envelope: { message: string | MessagePart[]; truncated?: boolean };
}

interface Failures {
  envelope: { limits: { name: number; message: number; stack: number } };
  fixtures: EnvelopeFixture[];
}

const failures = JSON.parse(
  await readFile(new URL("../../../protocol/v1/failures.json", import.meta.url), "utf8"),
) as Failures;
const limits = failures.envelope.limits;

/** The text a fixture message describes. */
function fixtureText(message: string | MessagePart[]): string {
  if (typeof message === "string") return message;
  return message
    .map((part) => {
      if (typeof part === "string") return part;
      if ("repeat" in part) return part.repeat.repeat(part.count);
      return String.fromCharCode(Number.parseInt(part.unpairedSurrogate, 16));
    })
    .join("");
}

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

async function bound(envelope: Json): Promise<Json> {
  const result = await pool.query<{ bounded: Json }>(
    "SELECT workhorse.bound_error_envelope_v1($1::jsonb) AS bounded",
    [JSON.stringify(envelope)],
  );
  return result.rows[0]!.bounded;
}

async function claimOne(
  type: string,
  queueName: string,
  maxAttempts: number,
): Promise<ClaimedTask> {
  const id = await queue.enqueue(type, null, {
    queue: queueName,
    maxAttempts,
    retryPolicy: { type: "fixed", delayMs: 0 },
  });
  const task = await queue.claim(`${queueName}-worker`, { queue: queueName, leaseMs: 60_000 });
  expect(task?.id).toBe(id);
  return task!;
}

function leaseArguments(task: ClaimedTask): [string, string, string] {
  return [task.id, `${task.queue}-worker`, task.fenceToken.toString()];
}

describe("failure envelope limits in PostgreSQL", () => {
  // A fixture without redaction gives the bytes that each SDK must send. PostgreSQL must cut the
  // same text to the same bytes, and it must not change the envelope that an SDK already cut.
  it.each(failures.fixtures.filter((fixture) => !fixture.redactErrorDetails))(
    "cuts the message of $id as the SDKs do",
    async (fixture) => {
      // The SDK replaces the text that jsonb cannot store before it sends the envelope.
      const message = fixtureText(fixture.error.message)
        .replaceAll("\u0000", "\ufffd")
        .replaceAll(
          /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
          "\ufffd",
        );
      const expected = fixtureText(fixture.envelope.message);
      const once = await bound({ name: "PaymentDeclined", message, stack: "at fixture" });
      expect(once).toEqual({
        name: "PaymentDeclined",
        message: expected,
        stack: "at fixture",
        ...(fixture.envelope.truncated === true ? { truncated: true } : {}),
      });
      await expect(bound(once)).resolves.toEqual(once);
    },
  );

  it("cuts the name and the stack at their limits without splitting a character", async () => {
    // 1 + 342 * 3 = 1,027 bytes. 341 characters give exactly 1,024 bytes.
    const name = `a${"€".repeat(342)}`;
    // 1 + 16,384 * 4 = 65,537 bytes. 16,383 characters give 65,533 bytes.
    const stack = `a${"\u{1F600}".repeat(16_384)}`;
    const bounded = (await bound({ name, message: "m", stack })) as Record<string, string>;
    expect(bounded["name"]).toBe(`a${"€".repeat(341)}`);
    expect(utf8Bytes(bounded["name"]!)).toBe(limits.name);
    expect(bounded["stack"]).toBe(`a${"\u{1F600}".repeat(16_383)}`);
    expect(utf8Bytes(bounded["stack"]!)).toBe(65_533);
    expect(bounded).toMatchObject({ message: "m", truncated: true });
  });

  it("keeps a value that is not a string, another key, and an envelope that is not an object", async () => {
    const long = "x".repeat(limits.message + 1);
    await expect(bound({ name: 1, message: { long }, stack: null, code: long })).resolves.toEqual({
      name: 1,
      message: { long },
      stack: null,
      code: long,
    });
    await expect(bound(long)).resolves.toBe(long);
    await expect(bound([long])).resolves.toEqual([long]);
    const result = await pool.query("SELECT workhorse.bound_error_envelope_v1(NULL) AS bounded");
    expect(result.rows[0]).toEqual({ bounded: null });
  });

  it("stores the cut envelope in each row of a retry and of a terminal failure", async () => {
    const message = `a${"\u{1F600}".repeat(4096)}`;
    const expected = { name: "Big", message: `a${"\u{1F600}".repeat(4095)}`, stack: null };
    const task = await claimOne("envelope-limit", "envelope-limit", 2);
    const retry = await pool.query<{ state: string }>(
      "SELECT workhorse.fail_v2($1, $2, $3, $4::jsonb, 0) AS state",
      [...leaseArguments(task), JSON.stringify({ name: "Big", message, stack: null })],
    );
    expect(retry.rows).toEqual([{ state: "ready" }]);
    const second = await queue.claim("envelope-limit-worker", {
      queue: "envelope-limit",
      leaseMs: 60_000,
    });
    const failed = await pool.query<{ state: string }>(
      "SELECT workhorse.fail_v2($1, $2, $3, $4::jsonb) AS state",
      [...leaseArguments(second!), JSON.stringify({ name: "Big", message, stack: null })],
    );
    expect(failed.rows).toEqual([{ state: "failed" }]);

    const stored = await pool.query<{ source: string; error: Json }>(
      `SELECT 'history:' || outcome AS source, error FROM workhorse.attempt_history
        WHERE task_id = $1
       UNION ALL
       SELECT 'event:' || event_type, details->'error' FROM workhorse.task_event
        WHERE task_id = $1 AND event_type IN ('retry_scheduled', 'failed')
       UNION ALL
       SELECT 'outcome', error FROM workhorse.task_outcome WHERE task_id = $1
       ORDER BY 1`,
      [task.id],
    );
    const truncated = { ...expected, truncated: true };
    expect(stored.rows).toEqual([
      { source: "event:failed", error: truncated },
      { source: "event:retry_scheduled", error: truncated },
      { source: "history:failed", error: truncated },
      { source: "history:retry", error: truncated },
      { source: "outcome", error: truncated },
    ]);
  });

  it("cuts a fast-tier envelope through fail_v2 and fast_fail_v2", async () => {
    await admin.setQueueTier("envelope-limit-fast", "fast", adminAudit("envelope-limit-fast"));
    const message = `ab${"€".repeat(5461)}`;
    const expected = `ab${"€".repeat(5460)}`;
    for (const statement of [
      "SELECT workhorse.fail_v2($1, $2, $3, $4::jsonb, -1) AS state",
      "SELECT workhorse.fast_fail_v2($1, $2, $3, $4::jsonb, -1) AS state",
    ]) {
      const task = await claimOne("envelope-limit", "envelope-limit-fast", 3);
      const result = await pool.query<{ state: string }>(statement, [
        ...leaseArguments(task),
        JSON.stringify({ name: "Big", message, stack: null }),
      ]);
      expect(result.rows).toEqual([{ state: "failed" }]);
      const outcome = await pool.query<{ error: Json }>(
        "SELECT error FROM workhorse.fast_task_outcome WHERE task_id = $1",
        [task.id],
      );
      expect(outcome.rows).toEqual([
        { error: { name: "Big", message: expected, stack: null, truncated: true } },
      ]);
    }
  });

  // SM-1996 lets a dashboard host withhold `stack`. The withheld envelope keeps `truncated`, so an
  // operator still sees that the message is cut.
  it("keeps the truncated key through the three dashboard reads with and without stack redaction", async () => {
    const message = "x".repeat(limits.message + 10);
    const sent = JSON.stringify({ name: "Big", message, stack: "at handler" });
    const task = await claimOne("envelope-limit-dashboard", "envelope-limit-dashboard", 2);
    await pool.query("SELECT workhorse.fail_v2($1, $2, $3, $4::jsonb, 0)", [
      ...leaseArguments(task),
      sent,
    ]);
    const second = await queue.claim("envelope-limit-dashboard-worker", {
      queue: "envelope-limit-dashboard",
      leaseMs: 60_000,
    });
    await pool.query("SELECT workhorse.fail_v2($1, $2, $3, $4::jsonb)", [
      ...leaseArguments(second!),
      sent,
    ]);
    const read = async (fn: string, input: object): Promise<Record<string, unknown>> => {
      const result = await pool.query<{ result: Record<string, unknown> }>(
        `SELECT workhorse.${fn}($1::jsonb) AS result`,
        [JSON.stringify(input)],
      );
      return result.rows[0]!.result;
    };
    for (const redactErrorStacks of [false, true]) {
      const expected = {
        name: "Big",
        message: "x".repeat(limits.message),
        ...(redactErrorStacks ? {} : { stack: "at handler" }),
        truncated: true,
      };
      const detail = (await read("dashboard_task_detail_v1", {
        id: task.id,
        redactErrorStacks,
      })) as {
        current: { error: unknown };
        attempts: { error: unknown }[];
        events: { type: string; details: { error?: unknown } }[];
      };
      expect(detail.current.error).toEqual(expected);
      expect(detail.attempts.map((attempt) => attempt.error)).toEqual([expected, expected]);
      expect(
        detail.events
          .filter((event) => event.type === "retry_scheduled" || event.type === "failed")
          .map((event) => event.details.error),
      ).toEqual([expected, expected]);
      const page = (await read("dashboard_events_v1", {
        taskId: task.id,
        pageSize: 100,
        redactErrorStacks,
      })) as { events: { id: string; type: string; kind: string; details: { error?: unknown } }[] };
      const failed = page.events.find((row) => row.type === "failed")!;
      expect(failed.details.error).toEqual(expected);
      expect(
        await read("dashboard_event_detail_v1", { id: failed.id, redactErrorStacks }),
      ).toMatchObject({
        details: { error: expected },
      });
      const attempt = page.events.find((row) => row.kind === "attempt")!;
      expect(
        await read("dashboard_event_detail_v1", { id: attempt.id, redactErrorStacks }),
      ).toMatchObject({ error: expected });
    }
  });

  // The first versions keep the text. A worker of an earlier release calls fail_v1, and
  // protocol/v1/failures.json promised that it stores the envelope as it comes.
  it("keeps the whole envelope in fail_v1 and fast_fail_v1", async () => {
    const message = "x".repeat(limits.message + 100);
    const task = await claimOne("envelope-limit-v1", "envelope-limit-v1", 1);
    await expect(
      pool.query("SELECT workhorse.fail_v1($1, $2, $3, $4::jsonb) AS state", [
        ...leaseArguments(task),
        JSON.stringify({ name: "Big", message, stack: null }),
      ]),
    ).resolves.toMatchObject({ rows: [{ state: "failed" }] });
    await admin.setQueueTier("envelope-limit-v1-fast", "fast", adminAudit("envelope-limit-v1"));
    const fast = await claimOne("envelope-limit-v1", "envelope-limit-v1-fast", 1);
    await expect(
      pool.query("SELECT workhorse.fast_fail_v1($1, $2, $3, $4::jsonb, NULL) AS state", [
        ...leaseArguments(fast),
        JSON.stringify({ name: "Big", message, stack: null }),
      ]),
    ).resolves.toMatchObject({ rows: [{ state: "failed" }] });
    const stored = await pool.query<{ error: Json }>(
      `SELECT error FROM workhorse.task_outcome WHERE task_id = $1
       UNION ALL SELECT error FROM workhorse.fast_task_outcome WHERE task_id = $2`,
      [task.id, fast.id],
    );
    expect(stored.rows).toEqual([
      { error: { name: "Big", message, stack: null } },
      { error: { name: "Big", message, stack: null } },
    ]);
  });
});

function save(version: 2 | 3, task: ClaimedTask, name: string, value: string) {
  return pool.query<Record<string, unknown>>(
    `SELECT * FROM workhorse.save_checkpoint_v${String(version)}($1, $2, $3, $4, $5::jsonb, NULL)`,
    [...leaseArguments(task), name, value],
  );
}

describe("checkpoint value limit in PostgreSQL", () => {
  // 349,526 zeros are 699,053 bytes of compact JSON and 1,048,578 bytes of jsonb text, because the
  // jsonb text writes a space after each comma.
  const oversized = JSON.stringify(Array.from({ length: 349_526 }, () => 0));
  const fitting = JSON.stringify(Array.from({ length: 349_525 }, () => 0));

  it("answers value_too_large, stores nothing, and records no event", async () => {
    expect(oversized.length).toBeLessThan(1_048_576);
    const task = await claimOne("checkpoint-limit", "checkpoint-limit", 3);
    const result = await save(3, task, "render", oversized);
    expect(result.rows).toEqual([
      {
        status: "value_too_large",
        checkpoint_value: null,
        attempt: null,
        fence_token: null,
        worker_id: null,
        created_at: null,
        input_fingerprint: null,
        value_bytes: 1_048_578,
        max_bytes: 1_048_576,
      },
    ]);
    const stored = await pool.query(
      `SELECT (SELECT count(*) FROM workhorse.task_checkpoint WHERE task_id = $1)::int AS checkpoints,
              (SELECT count(*) FROM workhorse.task_event
                WHERE task_id = $1 AND event_type = 'checkpoint_saved')::int AS events`,
      [task.id],
    );
    expect(stored.rows).toEqual([{ checkpoints: 0, events: 0 }]);
    await expect(save(3, task, "render", fitting)).resolves.toMatchObject({
      rows: [{ status: "saved", value_bytes: null, max_bytes: null }],
    });
  });

  it("answers stale before the size, and keeps the answers of a stored name", async () => {
    const task = await claimOne("checkpoint-limit", "checkpoint-limit-order", 3);
    await expect(save(3, task, "render", "1")).resolves.toMatchObject({
      rows: [{ status: "saved" }],
    });
    await expect(save(3, task, "render", oversized)).resolves.toMatchObject({
      rows: [{ status: "conflict", checkpoint_value: 1, value_bytes: null }],
    });
    await expect(save(3, task, "render", "1")).resolves.toMatchObject({
      rows: [{ status: "existing", checkpoint_value: 1 }],
    });
    const lost = { ...task, fenceToken: task.fenceToken + 1n };
    await expect(save(3, lost, "other", oversized)).resolves.toMatchObject({
      rows: [{ status: "stale", value_bytes: null, max_bytes: null }],
    });
  });

  // save_checkpoint_v2 keeps its exception, so a worker of an earlier release sees what it saw.
  it("keeps the exception of save_checkpoint_v2", async () => {
    const task = await claimOne("checkpoint-limit", "checkpoint-limit-v2", 3);
    await expect(save(2, task, "render", oversized)).rejects.toThrow(
      "checkpoint_value must be at most 1048576 bytes",
    );
    await expect(save(2, task, "render", fitting)).resolves.toMatchObject({
      rows: [{ status: "saved" }],
    });
  });
});
