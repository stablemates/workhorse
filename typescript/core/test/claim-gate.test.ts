import type { QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import { holdHeartbeatConnection, withClaimGate } from "../src/heartbeat-connection.js";
import { createProviderQueryable, Queue, type Queryable } from "../src/index.js";
import type { ClaimedTask } from "../src/types.js";
import { answerSchemaCheck } from "./support/schema-check.js";

// ADR 0071, rule 6, for the TypeScript claim path (SM-1575). A claim or a fused completion reads
// the heartbeat gate after it has its connection and immediately before each attempt. The fakes
// hold each acquisition until the test lets it go, so every step happens at a checkpoint.

const FUSED = "workhorse.complete_many_and_claim_v1(";
const CLAIM_MANY = "workhorse.claim_many_v1(";

type Sent = { text: string; values: readonly unknown[] };

function result(rows: object[]): QueryResult {
  return { command: "", rowCount: rows.length, oid: 0, fields: [], rows };
}

// One row of complete_many_and_claim_v1 that accepts the completion and claims nothing.
function fusedRow(task: ClaimedTask) {
  return { accepted: [task.id], task_id: null };
}

function claimedTask(id: string): ClaimedTask {
  return {
    id,
    queue: "gate",
    type: "gate.task",
    priority: 0,
    payload: null,
    contractVersion: null,
    resultMaxBytes: 1_048_576,
    redactErrorDetails: false,
    traceContext: null,
    attempt: 1,
    maxAttempts: 1,
    retryPolicy: null,
    deadlineAt: null,
    executionTimeoutMs: null,
    attemptTimeoutAt: null,
    fenceToken: 1n,
    leaseExpiresAt: new Date(Date.now() + 30_000),
  };
}

function emptyAnswer(): QueryResult {
  return result([]);
}

/**
 * A node-postgres-like pool whose connect() and claim statements a test controls. `held` holds the
 * resolvers of the acquisitions that wait, `sent` records each statement a client received, and
 * `answer` gives the rows of a statement.
 */
function controlledPool(options: { holdConnects?: boolean } = {}) {
  const held: Array<() => void> = [];
  const sent: Sent[] = [];
  const releases: Array<Error | boolean | undefined> = [];
  let answer: (text: string, values: readonly unknown[]) => QueryResult | Promise<QueryResult> =
    emptyAnswer;
  const client = {
    query: vi.fn<(text: string, values?: readonly unknown[]) => Promise<QueryResult>>(
      async (text, values = []) => {
        sent.push({ text, values });
        return answer(text, values);
      },
    ),
    release: (error?: Error | boolean) => {
      releases.push(error);
    },
  };
  const pool = {
    options: { max: 10 },
    query: vi.fn<(text: string, values?: readonly unknown[]) => Promise<QueryResult>>(
      async (text, values = []) => {
        sent.push({ text, values });
        return answer(text, values);
      },
    ),
    connect: vi.fn<() => Promise<unknown>>(async () => {
      if (options.holdConnects === true) {
        await new Promise<void>((resolve) => {
          held.push(resolve);
        });
      }
      return client;
    }),
  };
  return {
    pool,
    client,
    held,
    sent,
    releases,
    answerWith(next: typeof answer) {
      answer = next;
    },
  };
}

/**
 * An ORM adapter queryable whose executor waits, for each claim statement, until the test lets it
 * go, as an ORM waits for a pooled connection. Its attached pool is `pool`.
 */
function adapterOn(pool: ReturnType<typeof controlledPool>) {
  const held: Array<() => void> = [];
  const executed: Sent[] = [];
  const queryable = createProviderQueryable({
    execute: async (statement, values) => {
      if (statement.includes(CLAIM_MANY) || statement.includes(FUSED)) {
        await new Promise<void>((resolve) => {
          held.push(resolve);
        });
      }
      executed.push({ text: statement, values });
      return [];
    },
    wrapError: (_statement, cause) => cause as Error,
    connectionPool: pool.pool,
  });
  return { queryable, held, executed };
}

describe("claim gate on an ORM adapter", () => {
  it("runs no claim whose connection arrived after the heartbeat connection was lost", async () => {
    const attached = controlledPool({ holdConnects: true });
    const adapter = adapterOn(attached);
    const queue = new Queue(answerSchemaCheck(adapter.queryable));
    let open = true;

    const claim = withClaimGate(
      () => open,
      () => queue.claimMany("worker-1", 3, { queue: "gate" }),
    );
    // 1. The claim waits for its connection.
    await vi.waitFor(() => expect(attached.held.length + adapter.held.length).toBe(1));
    // 2. The heartbeat connection is lost.
    open = false;
    // 3. The connection arrives.
    for (const lend of [...attached.held.splice(0), ...adapter.held.splice(0)]) lend();

    await expect(claim).rejects.toThrow(/no usable heartbeat connection/);
    const claims = [...attached.sent, ...adapter.executed].filter((statement) =>
      statement.text.includes(CLAIM_MANY),
    );
    expect(claims).toEqual([]);
  });

  it("sends a fused completion whose connection arrived after the loss with a claim limit of zero", async () => {
    const attached = controlledPool({ holdConnects: true });
    const task = claimedTask("00000000-0000-4000-8000-000000000001");
    attached.answerWith((text) => result(text.includes(FUSED) ? [fusedRow(task)] : []));
    const adapter = adapterOn(attached);
    const queue = new Queue(answerSchemaCheck(adapter.queryable));
    let open = true;

    const completion = withClaimGate(
      () => open,
      () => queue.completeAndClaim(task, "worker-1", { ok: true }, { queue: "gate", limit: 2 }),
    );
    await vi.waitFor(() => expect(attached.held.length + adapter.held.length).toBe(1));
    open = false;
    for (const lend of [...attached.held.splice(0), ...adapter.held.splice(0)]) lend();
    await completion.catch(() => undefined);

    const fused = [...attached.sent, ...adapter.executed].filter((statement) =>
      statement.text.includes(FUSED),
    );
    expect(fused).toHaveLength(1);
    expect(fused[0]!.values[5]).toBe(0);
  });
});

describe("claim gate around a fused completion", () => {
  it("reads the gate after the completion waited for its batch", async () => {
    const pool = controlledPool();
    const task = claimedTask("00000000-0000-4000-8000-000000000002");
    pool.answerWith((text) => result(text.includes(FUSED) ? [fusedRow(task)] : []));
    const queue = new Queue(answerSchemaCheck(pool.pool as unknown as Queryable));
    let open = true;

    // The completion collects in its batch until the current turn of the event loop ends, and
    // setImmediate schedules the batch. The heartbeat connection is lost while the batch waits.
    const schedule = globalThis.setImmediate;
    const scheduled = vi.spyOn(globalThis, "setImmediate").mockImplementation(((
      callback: () => void,
    ) => {
      open = false;
      return schedule(callback);
    }) as typeof setImmediate);
    let completion: Promise<unknown>;
    try {
      completion = withClaimGate(
        () => open,
        () => queue.completeAndClaim(task, "worker-1", { ok: true }, { queue: "gate", limit: 2 }),
      );
      await vi.waitFor(() => expect(scheduled).toHaveBeenCalled());
    } finally {
      scheduled.mockRestore();
    }

    await expect(completion).resolves.toEqual({ accepted: true, claimed: [] });
    const fused = pool.sent.filter((statement) => statement.text.includes(FUSED));
    expect(fused).toHaveLength(1);
    expect(fused[0]!.values[5]).toBe(0);
  });

  it("reads the gate again before the resend of a deadlocked fused completion", async () => {
    const pool = controlledPool();
    const task = claimedTask("00000000-0000-4000-8000-000000000003");
    let open = true;
    let attempts = 0;
    pool.answerWith((text) => {
      if (!text.includes(FUSED)) return result([]);
      attempts += 1;
      if (attempts === 1) {
        // PostgreSQL rolls back the first attempt with 40P01. The heartbeat connection is lost
        // before the resend.
        open = false;
        throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      }
      return result([fusedRow(task)]);
    });
    const queue = new Queue(answerSchemaCheck(pool.pool as unknown as Queryable));

    await expect(
      withClaimGate(
        () => open,
        () => queue.completeAndClaim(task, "worker-1", { ok: true }, { queue: "gate", limit: 2 }),
      ),
    ).resolves.toEqual({ accepted: true, claimed: [] });
    const fused = pool.sent.filter((statement) => statement.text.includes(FUSED));
    expect(fused.map((statement) => statement.values[5])).toEqual([2, 0]);
  });
});

/** A pool whose connects wait until the test resolves them, with the client each one lends. */
function stalledPool() {
  const arrivals: Array<() => void> = [];
  const clients: Array<{ query: () => Promise<QueryResult>; release: ReturnType<typeof vi.fn> }> =
    [];
  const pool = {
    options: { max: 10 },
    query: vi.fn<() => Promise<QueryResult>>(async () => result([])),
    connect: vi.fn<() => Promise<unknown>>(async () => {
      const client = {
        query: async () => result([]),
        release: vi.fn<(error?: Error | boolean) => void>(),
      };
      clients.push(client);
      await new Promise<void>((resolve) => {
        arrivals.push(resolve);
      });
      return client;
    }),
  };
  return { pool, arrivals, clients };
}

describe("late ordinary borrows", () => {
  // Validator round 2 on 84f0a4ce: the connect settles before the aborted wait resumes.
  it("returns a connection that arrived just before its borrow was aborted", async () => {
    // connect() returns the controlled promise itself, so the connect settles in the same
    // microtasks as the abort, before the aborted wait resumes.
    const client = { query: async () => result([]), release: vi.fn<() => void>() };
    let arrive!: () => void;
    const pool = {
      options: { max: 10 },
      query: vi.fn<() => Promise<QueryResult>>(async () => result([])),
      connect: vi.fn<() => Promise<unknown>>(
        () =>
          new Promise((resolve) => {
            arrive = () => resolve(client);
          }),
      ),
    };
    const hold = holdHeartbeatConnection(pool as unknown as Queryable, 100)!;
    const controller = new AbortController();
    const operation = vi.fn<() => Promise<string>>(async () => "checked");
    const waiting = hold.borrow(1_000, controller.signal, operation);
    await vi.waitFor(() => expect(pool.connect).toHaveBeenCalledTimes(1));

    arrive();
    controller.abort();
    await expect(waiting).resolves.toBe("aborted");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await hold.close();

    expect(operation).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("returns a connection that arrives at once for a borrow whose signal was already aborted", async () => {
    const client = { query: async () => result([]), release: vi.fn<() => void>() };
    const pool = {
      options: { max: 10 },
      query: vi.fn<() => Promise<QueryResult>>(async () => result([])),
      connect: vi.fn<() => Promise<unknown>>(async () => client),
    };
    const hold = holdHeartbeatConnection(pool as unknown as Queryable, 100)!;
    const operation = vi.fn<() => Promise<string>>(async () => "checked");

    await expect(hold.borrow(1_000, AbortSignal.abort(), operation)).resolves.toBe("aborted");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await hold.close();

    expect(operation).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("returns each connection of two concurrent borrows that ended before it arrived", async () => {
    const { pool, arrivals, clients } = stalledPool();
    const hold = holdHeartbeatConnection(pool as unknown as Queryable, 100)!;
    const aborted = AbortSignal.abort();
    const operation = vi.fn<() => Promise<string>>(async () => "checked");
    const first = hold.borrow(1_000, aborted, operation);
    const second = hold.borrow(1_000, aborted, operation);
    await expect(Promise.all([first, second])).resolves.toEqual(["aborted", "aborted"]);
    await vi.waitFor(() => expect(arrivals).toHaveLength(2));

    for (const arrive of arrivals.splice(0)) arrive();
    await vi.waitFor(() =>
      expect(clients.map((client) => client.release.mock.calls.length)).toEqual([1, 1]),
    );
    expect(operation).not.toHaveBeenCalled();
    await hold.close();
  });

  it("gives a parked connection to the next borrow, and returns the other one", async () => {
    const { pool, arrivals, clients } = stalledPool();
    const hold = holdHeartbeatConnection(pool as unknown as Queryable, 100)!;
    const operation = vi.fn<() => Promise<string>>(async () => "checked");
    const aborted = AbortSignal.abort();
    await expect(
      Promise.all([hold.borrow(1_000, aborted, operation), hold.borrow(1_000, aborted, operation)]),
    ).resolves.toEqual(["aborted", "aborted"]);
    await vi.waitFor(() => expect(arrivals).toHaveLength(2));

    // The next borrow takes the oldest parked connect and starts no new one.
    const third = hold.borrow(1_000, undefined, operation);
    for (const arrive of arrivals.splice(0)) arrive();
    await expect(third).resolves.toEqual({ value: "checked" });
    expect(pool.connect).toHaveBeenCalledTimes(2);
    await vi.waitFor(() =>
      expect(clients.map((client) => client.release.mock.calls.length)).toEqual([1, 1]),
    );
    await hold.close();
  });
});
