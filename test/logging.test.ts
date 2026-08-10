import { logs, type LogRecord, type LoggerProvider } from "@opentelemetry/api-logs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Queue } from "../src/queue.js";
import type { Queryable } from "../src/types.js";

const records: LogRecord[] = [];
const provider: LoggerProvider = {
  getLogger: () => ({
    enabled: () => true,
    emit: (record) => records.push(record),
  }),
};

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
                accepted: true,
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
});
