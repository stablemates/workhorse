import { logs, type LogRecord, type LoggerProvider } from "@opentelemetry/api-logs";
import { registerOpenTelemetry } from "@stablemates/workhorse-otel";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Admin } from "../src/admin.js";
import { Queue } from "../src/queue.js";
import type { Queryable } from "../src/types.js";
import { Worker } from "../src/worker.js";
import { fullTierRead } from "./support/full-tier.js";
import { answerSchemaCheck } from "./support/schema-check.js";
import { unreservedQueue } from "../src/worker-internal.js";

registerOpenTelemetry();
const records: LogRecord[] = [];
// When true, the logger throws for each record, as a failing log exporter can.
let loggerThrows = false;
const provider: LoggerProvider = {
  getLogger: () => ({
    enabled: () => true,
    emit: (record) => {
      if (loggerThrows) throw new Error("the logger failed");
      records.push(record);
    },
  }),
};

function maintenancePhaseRow(name: string, rowsAffected: number, skippedLock = false) {
  return {
    phase: name,
    rows_affected: rowsAffected,
    duration_ms: 1,
    skipped_lock: skippedLock,
    error: null,
    ...(name === "recover" ? { expired_leases: 0, retried: 0, retry_dimensions: [] } : {}),
  };
}

beforeAll(() => {
  logs.setGlobalLoggerProvider(provider);
});

afterAll(() => {
  logs.disable();
});

describe("structured logging", () => {
  it("emits lifecycle records without copying payload values", async () => {
    records.length = 0;
    const database = {
      async query(sql: string) {
        if (sql.includes("enqueue_many_v1")) {
          return {
            rows: [
              {
                ordinal: 1,
                task_id: "00000000-0000-4000-8000-000000000001",
                outcome: "accepted",
              },
            ],
          };
        }
        if (sql.includes("set_queue_paused_v1")) return { rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as Queryable;
    const queue = new Queue(answerSchemaCheck(database), "mail");
    const admin = new Admin(answerSchemaCheck(database), "mail");

    await queue.enqueue("mail.send", {
      recipient: "reader@example.com",
      accessToken: "never-log-this",
    });
    await admin.pauseQueue("mail", {
      actor: "test",
      reason: "logging assertion",
      requestId: "logging-pause",
    });

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventName: "workhorse.task.enqueued",
          severityText: "DEBUG",
          attributes: expect.objectContaining({
            "workhorse.task.id": "00000000-0000-4000-8000-000000000001",
            "workhorse.task.type": "mail.send",
            "workhorse.queue.name": "mail",
          }),
        }),
        expect.objectContaining({
          eventName: "workhorse.queue.paused",
          severityText: "INFO",
        }),
      ]),
    );
    expect(JSON.stringify(records)).not.toContain("never-log-this");
    expect(JSON.stringify(records)).not.toContain("reader@example.com");
  });

  it("logs a queue purge with the count of the tasks that it removed", async () => {
    records.length = 0;
    const database = {
      async query(sql: string) {
        if (sql.includes("purge_queue_v1")) return { rows: [{ deleted_count: 3 }] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as Queryable;
    const admin = new Admin(answerSchemaCheck(database), "mail");

    await admin.purgeQueue("mail", {
      actor: "test",
      reason: "logging assertion",
      requestId: "logging-purge",
    });

    expect(records).toEqual([
      expect.objectContaining({
        eventName: "workhorse.queue.purged",
        severityText: "INFO",
        body: "Queue purged",
        attributes: { "workhorse.queue.name": "mail", "workhorse.task.count": 3 },
      }),
    ]);
  });

  it("returns the purge count when the logger throws", async () => {
    const database = {
      async query(sql: string) {
        if (sql.includes("purge_queue_v1")) return { rows: [{ deleted_count: 3 }] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as Queryable;
    const admin = new Admin(answerSchemaCheck(database), "mail");

    loggerThrows = true;
    try {
      await expect(
        admin.purgeQueue("mail", {
          actor: "test",
          reason: "logging assertion",
          requestId: "logging-purge-failing-logger",
        }),
      ).resolves.toBe(3);
    } finally {
      loggerThrows = false;
    }
  });

  it("does not repeat an unchanged worker registration on every refresh", async () => {
    records.length = 0;
    let registrations = 0;
    const database = {
      async query(sql: string) {
        if (sql.includes("register_worker_v1")) {
          registrations += 1;
          return { rows: [{ paused: false }] };
        }
        if (sql.includes("tick_v1") || sql.includes("run_maintenance_v1")) {
          return { rows: [] };
        }
        const tier = fullTierRead(sql);
        if (tier) return tier as never;
        if (sql.includes("claim_many_v1")) return { rows: [] };
        if (sql.includes("deregister_worker_v1")) return { rows: [{ deregistered: true }] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as Queryable;
    // The fake database has no pool to lend a heartbeat connection from.
    const worker = new Worker(unreservedQueue(new Queue(answerSchemaCheck(database), "mail")), {
      workerId: "worker-registration-log",
      queues: ["mail", "billing"],
      pollMs: 1_000,
      registryIntervalMs: 100,
      maintenanceIntervalMs: 60_000,
      maintenanceRoutinePollMs: 60_000,
    });

    const running = worker.run();
    try {
      await vi.waitFor(() => expect(registrations).toBeGreaterThanOrEqual(3));
      expect(
        records.filter((record) => record.eventName === "workhorse.worker.registered"),
      ).toEqual([
        expect.objectContaining({
          attributes: expect.objectContaining({
            "workhorse.worker.id": "worker-registration-log",
            "workhorse.worker.active_slots": 0,
            "workhorse.worker.queues": ["mail", "billing"],
          }),
        }),
      ]);
    } finally {
      worker.stop();
      await running;
    }
  });

  it("logs a failed worker registration with the worker queues and the error type", async () => {
    records.length = 0;
    const database = {
      async query(sql: string) {
        if (sql.includes("register_worker_v1")) throw new TypeError("never-log-this");
        if (sql.includes("tick_v1") || sql.includes("run_maintenance_v1")) return { rows: [] };
        const tier = fullTierRead(sql);
        if (tier) return tier as never;
        if (sql.includes("claim_many_v1")) return { rows: [] };
        if (sql.includes("deregister_worker_v1")) return { rows: [{ deregistered: true }] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as Queryable;
    const worker = new Worker(unreservedQueue(new Queue(answerSchemaCheck(database), "mail")), {
      workerId: "worker-registration-failure-log",
      queues: ["mail", "billing"],
      pollMs: 1_000,
      registryIntervalMs: 100,
      maintenanceIntervalMs: 60_000,
      maintenanceRoutinePollMs: 60_000,
      onRegistrationError: () => {},
    });

    const running = worker.run();
    try {
      await vi.waitFor(() =>
        expect(
          records.filter((record) => record.eventName === "workhorse.worker.registration_failed"),
        ).not.toHaveLength(0),
      );
      expect(
        records.find((record) => record.eventName === "workhorse.worker.registration_failed"),
      ).toEqual(
        expect.objectContaining({
          severityText: "INFO",
          body: "Worker registration failed",
          attributes: {
            "workhorse.worker.queues": ["mail", "billing"],
            "workhorse.worker.id": "worker-registration-failure-log",
            "error.type": "TypeError",
          },
        }),
      );
      expect(JSON.stringify(records)).not.toContain("never-log-this");
    } finally {
      worker.stop();
      await running;
    }
  });

  it("logs the leases that the recover phase of a tick recovered", async () => {
    records.length = 0;
    let tick = 0;
    const database = {
      async query(sql: string) {
        if (!sql.includes("tick_v1")) throw new Error(`Unexpected query: ${sql}`);
        tick += 1;
        if (tick === 1) {
          return {
            rows: [{ ...maintenancePhaseRow("recover", 3), expired_leases: 2, retried: 1 }],
          };
        }
        return { rows: [{ ...maintenancePhaseRow("recover", 3, true), expired_leases: 2 }] };
      },
    } as unknown as Queryable;
    const queue = new Queue(answerSchemaCheck(database));

    await queue.tick();
    expect(records.filter((record) => record.eventName === "workhorse.leases.recovered")).toEqual([
      expect.objectContaining({
        severityText: "INFO",
        body: "Expired leases recovered",
        attributes: {
          "workhorse.recovery.rows_affected": 3,
          "workhorse.recovery.expired_leases": 2,
          "workhorse.recovery.retried": 1,
        },
      }),
    ]);

    records.length = 0;
    await queue.tick();
    expect(records.filter((record) => record.eventName === "workhorse.leases.recovered")).toEqual(
      [],
    );
  });

  it("omits successful no-op maintenance records", async () => {
    records.length = 0;
    let tick = 0;
    const database = {
      async query(sql: string) {
        if (!sql.includes("tick_v1")) throw new Error(`Unexpected query: ${sql}`);
        tick += 1;
        if (tick === 1)
          return { rows: [maintenancePhaseRow("promote", 0), maintenancePhaseRow("recover", 0)] };
        if (tick === 2)
          return {
            rows: [
              maintenancePhaseRow("promote", 0, true),
              maintenancePhaseRow("recover", 0, true),
            ],
          };
        return {
          rows: [maintenancePhaseRow("promote", 2), maintenancePhaseRow("recover", 0)],
        };
      },
    } as unknown as Queryable;
    const queue = new Queue(answerSchemaCheck(database));

    await queue.tick();
    expect(
      records.filter((record) => record.eventName === "workhorse.maintenance.completed"),
    ).toHaveLength(0);

    await queue.tick();
    expect(
      records.filter((record) => record.eventName === "workhorse.maintenance.completed"),
    ).toHaveLength(0);

    records.length = 0;
    await queue.tick();
    expect(
      records.filter((record) => record.eventName === "workhorse.maintenance.completed"),
    ).toEqual([
      expect.objectContaining({
        severityText: "INFO",
        attributes: expect.objectContaining({ "workhorse.maintenance.rows_affected": 2 }),
      }),
    ]);
  });
});
