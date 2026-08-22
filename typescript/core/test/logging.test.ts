import { logs, type LogRecord, type LoggerProvider } from "@opentelemetry/api-logs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Queue } from "../src/queue.js";
import type { Queryable } from "../src/types.js";
import { Worker } from "../src/worker.js";

const records: LogRecord[] = [];
const provider: LoggerProvider = {
  getLogger: () => ({
    enabled: () => true,
    emit: (record) => records.push(record),
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
                job_id: "00000000-0000-4000-8000-000000000001",
                outcome: "accepted",
              },
            ],
          };
        }
        if (sql.includes("pause_queue_v1")) return { rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as Queryable;
    const queue = new Queue(database, "mail");

    await queue.enqueue("mail.send", {
      recipient: "reader@example.com",
      accessToken: "never-log-this",
    });
    await queue.pauseQueue();

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventName: "workhorse.job.enqueued",
          severityText: "DEBUG",
          attributes: expect.objectContaining({
            "workhorse.job.id": "00000000-0000-4000-8000-000000000001",
            "workhorse.job.type": "mail.send",
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

  it("does not repeat an unchanged worker registration on every refresh", async () => {
    records.length = 0;
    let registrations = 0;
    const database = {
      async query(sql: string) {
        if (sql.includes("register_worker_v1")) {
          registrations += 1;
          return { rows: [{ paused: false }] };
        }
        if (
          sql.includes("tick_v1") ||
          sql.includes("prepare_history_partitions_v1") ||
          sql.includes("rollup_stats_v1") ||
          sql.includes("retain_history_v1") ||
          sql.includes("prune_terminal_storage_v1")
        ) {
          return { rows: [] };
        }
        if (sql.includes("prune_worker_registry_v1")) return { rows: [{ count: 0 }] };
        if (sql.includes("claim_v1")) return { rows: [] };
        if (sql.includes("deregister_worker_v1")) return { rows: [{ deregistered: true }] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as Queryable;
    const worker = new Worker(new Queue(database, "mail"), {
      workerId: "worker-registration-log",
      queues: ["mail", "billing"],
      pollMs: 1_000,
      registryIntervalMs: 100,
      maintenanceIntervalMs: 60_000,
      maintenanceTaskPollMs: 60_000,
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
    const queue = new Queue(database);

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
