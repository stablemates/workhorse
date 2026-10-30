import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import { Admin } from "../src/admin.js";
import { SchemaCompatibilityError } from "../src/errors.js";
import { Queue } from "../src/queue.js";
import {
  assertSchemaCompatible,
  MINIMUM_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  WORKHORSE_SCHEMA_VERSION,
} from "../src/schema.js";
import { SQL_STATEMENTS } from "../src/queue/sql-catalogue.generated.js";
import type { Queryable } from "../src/types.js";
import { Worker } from "../src/worker.js";
import { unreservedQueue } from "../src/worker-internal.js";

const COMPATIBILITY = SQL_STATEMENTS["compatibility_state"];
const AUDIT = { actor: "operator", reason: "schema check", requestId: "schema-check-1" };

/**
 * A database at `schemaVersion` that records each statement. It answers the compatibility query
 * and returns no rows for every other statement, so a call that reaches its own statement does
 * not fail on the fake.
 */
function fakeDatabase(schemaVersion: number, other: () => QueryResultRow[] = () => []) {
  const statements: string[] = [];
  const compatibilityFailures: Error[] = [];
  const database: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<R>> {
      statements.push(text);
      if (text === COMPATIBILITY) {
        const failure = compatibilityFailures.shift();
        if (failure !== undefined) throw failure;
        return result<R>([
          { kind: "schema", version: schemaVersion },
          { kind: "protocol", version: PROTOCOL_VERSION },
        ]);
      }
      return result<R>(other());
    },
  };
  return {
    database,
    statements,
    compatibilityQueries: () => statements.filter((text) => text === COMPATIBILITY).length,
    otherStatements: () => statements.filter((text) => text !== COMPATIBILITY),
    failNextCompatibilityQuery: (failure: Error) => {
      compatibilityFailures.push(failure);
    },
  };
}

function result<R extends QueryResultRow>(rows: QueryResultRow[]): QueryResult<R> {
  return { rows: rows as R[], rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
}

/**
 * A database whose compatibility query waits until the test answers or fails it. Each query takes
 * the next reply, so a test controls each query in turn.
 */
function deferredCompatibility(schemaVersion: number) {
  const waiting: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  let compatibilityQueries = 0;
  const database: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<R>> {
      if (text !== COMPATIBILITY) return result<R>([{ count: 0 }]);
      compatibilityQueries += 1;
      await new Promise<void>((resolve, reject) => {
        waiting.push({ resolve, reject });
      });
      return result<R>([
        { kind: "schema", version: schemaVersion },
        { kind: "protocol", version: PROTOCOL_VERSION },
      ]);
    },
  };
  // A query starts after the caller's first await, so wait for it before the reply.
  const next = async () => {
    await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0));
    return waiting.shift()!;
  };
  return {
    database,
    compatibilityQueries: () => compatibilityQueries,
    answer: () => void next().then((reply) => reply.resolve()),
    fail: (error: Error) => void next().then((reply) => reply.reject(error)),
  };
}

const enqueueRow = () => [{ ordinal: 1, task_id: "task-1", outcome: "accepted" }];

describe("Queue schema compatibility check", () => {
  it("refuses a schema below the floor before it sends the mutation", async () => {
    const fake = fakeDatabase(MINIMUM_SCHEMA_VERSION - 1, enqueueRow);
    const queue = new Queue(fake.database);

    const refusal = await queue.enqueue("email.send", null).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(SchemaCompatibilityError);
    expect(refusal).toMatchObject({ code: "schema-too-old" });
    expect(fake.otherStatements()).toEqual([]);
  });

  it("checks once for each queue and keeps the answer", async () => {
    const fake = fakeDatabase(MINIMUM_SCHEMA_VERSION, enqueueRow);
    const queue = new Queue(fake.database);

    await queue.enqueue("email.send", null);
    await queue.enqueue("email.send", null);
    await queue.cancel("task-1").catch(() => undefined);

    expect(fake.compatibilityQueries()).toBe(1);
    expect(fake.statements[0]).toBe(COMPATIBILITY);
  });

  it("keeps a refusal, so a later call does not query again", async () => {
    const fake = fakeDatabase(MINIMUM_SCHEMA_VERSION - 1);
    const queue = new Queue(fake.database);

    await expect(queue.health()).rejects.toBeInstanceOf(SchemaCompatibilityError);
    await expect(queue.promote()).rejects.toBeInstanceOf(SchemaCompatibilityError);

    expect(fake.statements).toEqual([COMPATIBILITY]);
  });

  it("passes a driver error through unchanged and does not keep it", async () => {
    const fake = fakeDatabase(MINIMUM_SCHEMA_VERSION, enqueueRow);
    const queue = new Queue(fake.database);
    const aborted = Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
    fake.failNextCompatibilityQuery(aborted);

    await expect(queue.enqueue("email.send", null)).rejects.toBe(aborted);

    await queue.enqueue("email.send", null);
    expect(fake.compatibilityQueries()).toBe(2);
  });

  it("runs the check on the caller's transaction", async () => {
    const pool = fakeDatabase(MINIMUM_SCHEMA_VERSION);
    const transaction = fakeDatabase(MINIMUM_SCHEMA_VERSION - 1, enqueueRow);
    const queue = new Queue(pool.database);

    await expect(
      queue.enqueue("email.send", null, {}, transaction.database),
    ).rejects.toBeInstanceOf(SchemaCompatibilityError);

    expect(pool.statements).toEqual([]);
    expect(transaction.statements).toEqual([COMPATIBILITY]);
  });

  it("sends no statement for an empty batch", async () => {
    const fake = fakeDatabase(MINIMUM_SCHEMA_VERSION - 1);
    const queue = new Queue(fake.database);

    await expect(queue.enqueueMany([])).resolves.toEqual([]);
    await expect(queue.enqueueManyWithResults([])).resolves.toEqual([]);

    expect(fake.statements).toEqual([]);
  });

  it("shares one query between overlapping calls on one connection", async () => {
    const reply = deferredCompatibility(MINIMUM_SCHEMA_VERSION);
    const queue = new Queue(reply.database);

    const first = queue.promote();
    const second = queue.promote();
    reply.answer();
    await Promise.all([first, second]);

    expect(reply.compatibilityQueries()).toBe(1);
  });

  it("gives a shared driver error to each overlapping call, and the next call retries", async () => {
    const reply = deferredCompatibility(MINIMUM_SCHEMA_VERSION);
    const queue = new Queue(reply.database);
    const lost = Object.assign(new Error("connection terminated"), { code: "57P01" });

    const first = queue.promote();
    const second = queue.promote();
    reply.fail(lost);
    await expect(first).rejects.toBe(lost);
    await expect(second).rejects.toBe(lost);
    expect(reply.compatibilityQueries()).toBe(1);

    const third = queue.promote();
    reply.answer();
    await third;
    expect(reply.compatibilityQueries()).toBe(2);
  });

  it("does not make a transaction wait for a check on another connection", async () => {
    // The transaction holds the only pooled connection, so the pool's check cannot finish first.
    let lend!: () => void;
    const connectionFree = new Promise<void>((resolve) => {
      lend = resolve;
    });
    const pool = fakeDatabase(MINIMUM_SCHEMA_VERSION);
    const poolQuery = pool.database.query;
    pool.database.query = (async (text: string, values?: readonly unknown[]) => {
      await connectionFree;
      return poolQuery.call(pool.database, text, values);
    }) as Queryable["query"];
    const transaction = fakeDatabase(MINIMUM_SCHEMA_VERSION, enqueueRow);
    const queue = new Queue(pool.database);

    const health = queue.health().catch(() => undefined);
    await expect(queue.enqueue("email.send", null, {}, transaction.database)).resolves.toBe(
      "task-1",
    );

    lend();
    await health;
    expect(transaction.compatibilityQueries()).toBe(1);
  });

  it("shares the answer with a queue bound to a transaction", async () => {
    const fake = fakeDatabase(MINIMUM_SCHEMA_VERSION, enqueueRow);
    const queue = new Queue(fake.database);

    await queue.enqueue("email.send", null);
    await queue.forDatabase(fake.database).enqueue("email.send", null);

    expect(fake.compatibilityQueries()).toBe(1);
  });
});

describe("Admin schema compatibility check", () => {
  it("refuses a schema below the floor before it sends the statement", async () => {
    const fake = fakeDatabase(MINIMUM_SCHEMA_VERSION - 1);
    const admin = new Admin(fake.database);

    await expect(admin.pauseQueue("mail", AUDIT)).rejects.toMatchObject({
      code: "schema-too-old",
    });
    await expect(admin.listTasks()).rejects.toBeInstanceOf(SchemaCompatibilityError);

    expect(fake.statements).toEqual([COMPATIBILITY]);
  });

  it("checks once for each admin", async () => {
    const fake = fakeDatabase(MINIMUM_SCHEMA_VERSION);
    const admin = new Admin(fake.database);

    await admin.pauseQueue("mail", AUDIT);
    await admin.resumeQueue("mail", AUDIT);

    expect(fake.compatibilityQueries()).toBe(1);
    expect(fake.otherStatements()).toHaveLength(2);
  });

  it("validates the arguments before it checks the schema", async () => {
    const fake = fakeDatabase(MINIMUM_SCHEMA_VERSION - 1);
    const admin = new Admin(fake.database);

    await expect(admin.pauseQueue("mail", { ...AUDIT, reason: "" })).rejects.not.toBeInstanceOf(
      SchemaCompatibilityError,
    );
    expect(fake.statements).toEqual([]);
  });
});

describe("Worker schema compatibility check", () => {
  const workerOptions = {
    workerId: "schema-check-worker",
    queues: ["mail"],
    pollMs: 1_000,
  };

  it("refuses a schema below the floor in runOnce before it registers", async () => {
    const fake = fakeDatabase(MINIMUM_SCHEMA_VERSION - 1);
    const worker = new Worker(unreservedQueue(new Queue(fake.database, "mail")), workerOptions);

    await expect(worker.runOnce()).rejects.toMatchObject({ code: "schema-too-old" });
    expect(fake.statements).toEqual([COMPATIBILITY]);
  });

  it("refuses a schema below the floor in run without a reserved heartbeat connection", async () => {
    const fake = fakeDatabase(MINIMUM_SCHEMA_VERSION - 1);
    const worker = new Worker(unreservedQueue(new Queue(fake.database, "mail")), workerOptions);

    await expect(worker.run()).rejects.toMatchObject({ code: "schema-too-old" });
    expect(fake.statements).toEqual([COMPATIBILITY]);
  });
});

const missingRelation = () =>
  Object.assign(new Error('relation "workhorse.schema_version" does not exist'), {
    code: "42P01",
  });

/** A database with no Workhorse schema: the compatibility query fails on a missing relation. */
function emptyDatabase() {
  const fake = fakeDatabase(MINIMUM_SCHEMA_VERSION);
  const query = fake.database.query;
  fake.database.query = (async (text: string, values?: readonly unknown[]) => {
    if (text === COMPATIBILITY) {
      fake.statements.push(text);
      throw missingRelation();
    }
    return query.call(fake.database, text, values);
  }) as Queryable["query"];
  return fake;
}

const notInstalled = (deadline: string) => ({
  name: "SchemaCompatibilityError",
  code: "schema-not-installed",
  installedVersion: null,
  expectedVersion: WORKHORSE_SCHEMA_VERSION,
  message: `Workhorse schema is not installed. Install it with \`workhorse schema install\` or installSchema ${deadline}.`,
});

describe("schema-not-installed message", () => {
  it("names the Queue for an enqueue", async () => {
    const fake = emptyDatabase();

    await expect(new Queue(fake.database).enqueue("email.send", null)).rejects.toMatchObject(
      notInstalled("before you use the Queue"),
    );
    expect(fake.otherStatements()).toEqual([]);
  });

  it("names the Admin for an Admin call", async () => {
    const fake = emptyDatabase();

    await expect(new Admin(fake.database).listTasks()).rejects.toMatchObject(
      notInstalled("before you use the Admin"),
    );
    expect(fake.otherStatements()).toEqual([]);
  });

  it("names the Worker for runOnce", async () => {
    const fake = emptyDatabase();
    const worker = new Worker(unreservedQueue(new Queue(fake.database, "mail")), {
      workerId: "schema-check-worker",
      queues: ["mail"],
    });

    await expect(worker.runOnce()).rejects.toMatchObject(
      notInstalled("before you start the Worker"),
    );
    expect(fake.otherStatements()).toEqual([]);
  });

  it("names the caller of each call when a worker and its queue share one answer", async () => {
    const fake = emptyDatabase();
    const queue = new Queue(fake.database, "mail");
    const worker = new Worker(unreservedQueue(queue), {
      workerId: "schema-check-worker",
      queues: ["mail"],
    });

    await expect(queue.enqueue("email.send", null)).rejects.toMatchObject(
      notInstalled("before you use the Queue"),
    );
    await expect(worker.runOnce()).rejects.toMatchObject(
      notInstalled("before you start the Worker"),
    );
    await expect(queue.health()).rejects.toMatchObject(notInstalled("before you use the Queue"));
    expect(fake.compatibilityQueries()).toBe(1);
  });

  it("names the application by default and the dashboard when the dashboard asks", async () => {
    const fake = emptyDatabase();

    await expect(assertSchemaCompatible(fake.database)).rejects.toMatchObject(
      notInstalled("before the application starts"),
    );
    await expect(
      assertSchemaCompatible(fake.database, { caller: "dashboard" }),
    ).rejects.toMatchObject(notInstalled("before you mount the dashboard"));
  });

  it("does not name the dashboard for a caller other than the dashboard", async () => {
    const fake = emptyDatabase();
    const messages = await Promise.all(
      [
        new Queue(fake.database).enqueue("email.send", null),
        new Admin(fake.database).listTasks(),
        assertSchemaCompatible(fake.database),
        assertSchemaCompatible(fake.database, { caller: "worker" }),
      ].map((call) => call.then(String, (error: Error) => error.message)),
    );

    for (const message of messages) expect(message).not.toMatch(/dashboard/i);
  });

  it("refuses an unknown caller before it sends a statement", async () => {
    const fake = emptyDatabase();

    await expect(
      assertSchemaCompatible(fake.database, { caller: "cron" as "worker" }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fake.statements).toEqual([]);
  });
});
