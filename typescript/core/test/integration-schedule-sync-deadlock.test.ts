import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { Queue, type ScheduleDefinition } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

// A schedule synchronization and a schedule tick that touch the same namespace must not deadlock,
// whatever order the synchronization lists its definitions in (SM-1075).

const { pool, queue } = createIntegrationTestContext(import.meta.url);

/** A schedule that never fires during the test, so a tick only moves its evaluation position. */
function definition(name: string, timezone = "UTC"): ScheduleDefinition {
  return {
    name,
    schedule: "0 0 1 1 *",
    timezone,
    task: { type: "schedule-sync-deadlock", payload: { name } },
  };
}

async function backendPid(client: PoolClient): Promise<number> {
  return (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
}

async function blocked(pid: number): Promise<boolean> {
  const result = await pool.query<{ blocked: boolean }>(
    "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked",
    [pid],
  );
  return result.rows[0]!.blocked;
}

async function waitUntilBlocked(pid: number): Promise<void> {
  await vi.waitFor(async () => expect(await blocked(pid)).toBe(true), {
    timeout: 10_000,
    interval: 20,
  });
}

/** Wait until `call` settles or its backend waits on another one. */
async function waitUntilSettledOrBlocked(call: Promise<unknown>, pid: number): Promise<void> {
  let settled = false;
  void call.then(
    () => (settled = true),
    () => (settled = true),
  );
  await vi.waitFor(async () => expect(settled || (await blocked(pid))).toBe(true), {
    timeout: 10_000,
    interval: 20,
  });
}

/**
 * Hold row `held` of the namespace with a third transaction while `start` begins on the given
 * connections, then release it and settle every call.
 */
async function raceBehindRowLock(
  namespace: string,
  held: string,
  start: readonly ((client: PoolClient) => Promise<unknown>)[],
): Promise<PromiseSettledResult<unknown>[]> {
  const blocker = await pool.connect();
  const clients: PoolClient[] = [];
  try {
    for (const _ of start) clients.push(await pool.connect());
    await blocker.query("BEGIN");
    await blocker.query(
      `SELECT FROM workhorse.schedule_definition
        WHERE namespace = $1 AND schedule_name = $2 FOR UPDATE`,
      [namespace, held],
    );
    const calls: Promise<unknown>[] = [];
    for (const [index, begin] of start.entries()) {
      const client = clients[index]!;
      const pid = await backendPid(client);
      const call = begin(client);
      // Observe a rejection now; the assertions read it from allSettled below.
      call.catch(() => undefined);
      calls.push(call);
      if (index === 0) await waitUntilBlocked(pid);
      else await waitUntilSettledOrBlocked(call, pid);
    }
    await blocker.query("COMMIT");
    return await Promise.allSettled(calls);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    for (const client of clients) client.release();
  }
}

function rejection(results: readonly PromiseSettledResult<unknown>[]): unknown {
  return results.find((result) => result.status === "rejected")?.reason;
}

describe("schedule synchronization deadlock", () => {
  it("lets a tick pass a namespace whose synchronization waits on a definition row", async () => {
    const namespace = `schedule-sync-deadlock-${randomUUID()}`;
    await queue.syncSchedules(namespace, [definition("a"), definition("b")]);

    // The synchronization lists b before a and waits on b. Before SM-1075 the tick then moved a's
    // evaluation position, waited on b behind the synchronization, and the synchronization waited
    // on a behind the tick.
    const results = await raceBehindRowLock(namespace, "b", [
      (client) =>
        new Queue(client).syncSchedules(namespace, [
          definition("b", "Europe/Berlin"),
          definition("a", "Europe/Berlin"),
        ]),
      (client) => new Queue(client).fireDueSchedules([namespace], new Date(), 10, 60_000),
    ]);

    expect(rejection(results)).toBeUndefined();
    expect((await queue.schedules([namespace])).map((stored) => stored.timezone)).toEqual([
      "Europe/Berlin",
      "Europe/Berlin",
    ]);
  });

  it("serializes two synchronizations that list the same definitions in opposite orders", async () => {
    const namespace = `schedule-sync-deadlock-${randomUUID()}`;
    await queue.syncSchedules(namespace, [definition("a"), definition("b")]);

    const results = await raceBehindRowLock(namespace, "b", [
      (client) =>
        new Queue(client).syncSchedules(namespace, [
          definition("b", "Europe/Berlin"),
          definition("a", "Europe/Berlin"),
        ]),
      (client) =>
        new Queue(client).syncSchedules(namespace, [
          definition("a", "Asia/Tokyo"),
          definition("b", "Asia/Tokyo"),
        ]),
    ]);

    expect(rejection(results)).toBeUndefined();
    expect((await queue.schedules([namespace])).map((stored) => stored.timezone)).toEqual([
      "Asia/Tokyo",
      "Asia/Tokyo",
    ]);
  });
});
