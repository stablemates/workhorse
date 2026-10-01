import type { Queryable } from "@stablemates/workhorse";
import { describe, expect, it, vi } from "vitest";
import { createDashboardHost } from "../src/server/host.js";
import type { DashboardQueueController } from "../src/server/types.js";
import { PROTOCOL_VERSION, WORKHORSE_SCHEMA_VERSION } from "@stablemates/workhorse";

const ORIGIN = "https://dashboard.test";

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
  const setPaused = vi.fn<NonNullable<DashboardQueueController["setQueuePaused"]>>();
  const host = createDashboardHost({
    database,
    path: "/workhorse",
    authorize: () => ({ actor: "operator" }),
    operator: { mode: "writable" },
    queueController: { setQueuePaused: setPaused },
  });
  // Only the schema compatibility probe may reach the database.
  const routed = () => statements.filter((text) => !/protocol|schema/i.test(text)).length;
  return { host, setPaused, routed };
}

const body = JSON.stringify({
  json: {
    queue: "default",
    paused: true,
    audit: { actor: "operator", reason: "method check", requestId: "request" },
  },
});

describe("dashboard RPC methods", () => {
  // The demo's operator throttles classify only POST as a mutation, so any other method that
  // reached a procedure would bypass them. The contract answers every non-POST method with 405.
  it.each(["OPTIONS", "PUT", "PATCH", "DELETE", "GET", "HEAD"])(
    "answers 405 to a same-origin %s mutation without reaching the controller",
    async (method) => {
      const { host, setPaused, routed } = harness();
      // A GET or HEAD request cannot carry a body, so those two send no envelope.
      const payload = method === "GET" || method === "HEAD" ? {} : { body };

      const response = await host.handle(
        new Request(`${ORIGIN}/workhorse/rpc/dashboard/setQueuePaused`, {
          method,
          headers: { "content-type": "application/json", origin: ORIGIN },
          ...payload,
        }),
      );

      expect(response?.status).toBe(405);
      expect(response?.headers.get("allow")).toBe("POST");
      expect(await response?.json()).toEqual({
        json: {
          defined: false,
          code: "METHOD_NOT_SUPPORTED",
          status: 405,
          message: "Method Not Supported",
        },
      });
      expect(setPaused).not.toHaveBeenCalled();
      expect(routed()).toBe(0);
    },
  );

  it("still dispatches the same mutation as POST", async () => {
    const { host, setPaused } = harness();
    setPaused.mockResolvedValue({ paused: true });

    const response = await host.handle(
      new Request(`${ORIGIN}/workhorse/rpc/dashboard/setQueuePaused`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body,
      }),
    );

    expect(response?.status).toBe(200);
    expect(setPaused).toHaveBeenCalledTimes(1);
  });
});
