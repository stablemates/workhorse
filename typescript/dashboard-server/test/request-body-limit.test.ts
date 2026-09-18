import type { Queryable } from "@stablemates/workhorse";
import { describe, expect, it, vi } from "vitest";
import { createDashboardHost } from "../src/server/host.js";
import type { DashboardTaskController } from "../src/server/types.js";
import { PROTOCOL_VERSION, WORKHORSE_SCHEMA_VERSION } from "@stablemates/workhorse";

const ORIGIN = "https://dashboard.test";
const OVERSIZED = 200 * 1024;

function harness() {
  const statements: string[] = [];
  const database = {
    query: async (text: string) => {
      statements.push(text);
      return {
        rows: [
          { kind: "protocol", version: PROTOCOL_VERSION },
          { kind: "schema", version: WORKHORSE_SCHEMA_VERSION },
        ],
      };
    },
  } as unknown as Queryable;
  const cancelTask = vi.fn<NonNullable<DashboardTaskController["cancelTask"]>>();
  const host = createDashboardHost({
    database,
    path: "/workhorse",
    authorize: () => ({ actor: "operator" }),
    operator: { mode: "writable" },
    taskController: { cancelTask },
  });
  // Only the schema compatibility probe may reach the database.
  const routed = () => statements.filter((text) => !/protocol|schema/i.test(text)).length;
  return { host, cancelTask, routed };
}

function oversizedEnvelope(): string {
  return JSON.stringify({
    json: {
      id: "00000000-0000-4000-8000-000000000001",
      audit: { actor: "operator", reason: "x".repeat(OVERSIZED), requestId: "request" },
    },
  });
}

describe("dashboard RPC request bodies", () => {
  it.each(["cancelTask", "taskDetail", "missingProcedure"])(
    "answers 413 to a 200 KiB POST to %s without reaching the router",
    async (procedure) => {
      const { host, cancelTask, routed } = harness();
      const body = oversizedEnvelope();

      const response = await host.handle(
        new Request(`${ORIGIN}/workhorse/rpc/dashboard/${procedure}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
            origin: ORIGIN,
          },
          body,
        }),
      );

      expect(response?.status).toBe(413);
      expect(cancelTask).not.toHaveBeenCalled();
      expect(routed()).toBe(0);
    },
  );

  it("answers 413 to an oversized body that declares no length", async () => {
    const { host, cancelTask, routed } = harness();
    const bytes = new TextEncoder().encode(oversizedEnvelope());
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 16 * 1024) {
          controller.enqueue(bytes.subarray(offset, offset + 16 * 1024));
        }
        controller.close();
      },
    });

    const response = await host.handle(
      new Request(`${ORIGIN}/workhorse/rpc/dashboard/cancelTask`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );

    expect(response?.status).toBe(413);
    expect(cancelTask).not.toHaveBeenCalled();
    expect(routed()).toBe(0);
  });

  it("rejects an audit reason longer than the database accepts", async () => {
    const { host, cancelTask } = harness();
    const body = JSON.stringify({
      json: {
        id: "00000000-0000-4000-8000-000000000001",
        audit: { actor: "operator", reason: "x".repeat(2_001), requestId: "request" },
      },
    });

    const response = await host.handle(
      new Request(`${ORIGIN}/workhorse/rpc/dashboard/runTaskNow`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body,
      }),
    );

    expect(response?.status).toBe(400);
    expect(cancelTask).not.toHaveBeenCalled();
  });
});
