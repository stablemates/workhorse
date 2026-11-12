import type { Queryable } from "@stablemates/workhorse";
import { PROTOCOL_VERSION, WORKHORSE_SCHEMA_VERSION } from "@stablemates/workhorse";
import { describe, expect, it } from "vitest";
import { createDashboardHost } from "../src/server/host.js";

const marker = "driver-marker db.internal:5432";

/** Passes the compatibility check, and fails each other query with a message that names an address. */
const failingReads = {
  query: async (text: string) => {
    if (text.includes("protocol_version") || text.includes("schema_version")) {
      return {
        rows: [
          { kind: "protocol", version: PROTOCOL_VERSION },
          { kind: "schema", version: WORKHORSE_SCHEMA_VERSION },
        ],
      };
    }
    throw new Error(marker);
  },
} as unknown as Queryable;

function post(procedure: string, body: string): Request {
  return new Request(`http://dashboard.test/rpc/dashboard/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("dashboard error answers", () => {
  it("answers an unexpected procedure error with the fixed 500 envelope", async () => {
    const host = createDashboardHost({ database: failingReads, path: "/", authorize: () => true });

    const response = await host.handle(post("queues", '{"json":{}}'));

    expect(response?.status).toBe(500);
    const text = await response?.text();
    expect(text).not.toContain("db.internal");
    expect(JSON.parse(text ?? "")).toEqual({
      json: {
        defined: false,
        code: "INTERNAL_SERVER_ERROR",
        status: 500,
        message: "Internal server error",
      },
    });
  });

  it("answers a body that it cannot decode with a fixed 400 message", async () => {
    const host = createDashboardHost({ database: failingReads, path: "/", authorize: () => true });

    const response = await host.handle(post("queues", '{"json":'));

    expect(response?.status).toBe(400);
    expect(JSON.parse((await response?.text()) ?? "")).toEqual({
      json: {
        defined: false,
        code: "BAD_REQUEST",
        status: 400,
        message:
          "Malformed request. Ensure the request body is properly formatted and the 'Content-Type' header is set correctly.",
      },
    });
  });
});
