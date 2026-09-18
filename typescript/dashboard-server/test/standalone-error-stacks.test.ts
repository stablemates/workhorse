import { scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Queryable } from "@stablemates/workhorse";
import { describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server/standalone.js";
import { PROTOCOL_VERSION, WORKHORSE_SCHEMA_VERSION } from "@stablemates/workhorse";

const salt = Buffer.from("workhorse-stack-test-salt");
const passwordHash = `scrypt-v1$${salt.toString("base64url")}$${scryptSync("correct horse", salt, 32).toString("base64url")}`;
const workerError = {
  name: "Error",
  message: "failed",
  stack: "Error: failed\n    at /app/worker.js:1",
};
const stackDatabase = {
  query: async (text: string) => {
    if (text.includes("dashboard_event_detail_v1")) {
      return { rows: [{ result: { id: "event", error: workerError } }] };
    }
    if (text.includes("dashboard_task_detail_v1")) {
      const detail = {
        identity: { type: "report" },
        payload: {},
        childLineage: { records: [], truncated: false },
        current: { runtime: { error: workerError }, outcome: null, error: workerError },
        batchExecutions: [],
        attempts: [{ error: workerError }],
        events: [],
      };
      return { rows: [{ result: detail }] };
    }
    if (text.includes("queue_health_v1")) return { rows: [{ document: {} }] };
    return {
      rows: [
        { kind: "protocol", version: PROTOCOL_VERSION },
        { kind: "schema", version: WORKHORSE_SCHEMA_VERSION },
      ],
    };
  },
} as Queryable;
const dashboardSessionSuite = existsSync(
  path.resolve(import.meta.dirname, "../dist/app/login.html"),
)
  ? describe
  : describe.skip;

/** A TCP port that was free a moment ago; the listener under test reports only its public origin. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, "0.0.0.0", resolve);
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    probe.close(() => resolve());
  });
  return port;
}

/** Sign in over HTTP and read one task and one event, returning every persisted error they carry. */
async function persistedErrors(port: number): Promise<unknown[]> {
  const send = (requestPath: string, headers: Record<string, string>, body: string) =>
    fetch(`http://127.0.0.1:${port}${requestPath}`, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
    });
  const login = await send(
    "/login",
    { "content-type": "application/x-www-form-urlencoded" },
    new URLSearchParams({ username: "operator", password: "correct horse" }).toString(),
  );
  const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
  const rpc = async (procedure: string, input: unknown) =>
    (
      (await (
        await send(
          `/rpc/dashboard/${procedure}`,
          { "content-type": "application/json", cookie },
          JSON.stringify({ json: input }),
        )
      ).json()) as { json: Record<string, unknown> }
    ).json;
  const task = (await rpc("taskDetail", { id: "00000000-0000-4000-8000-000000000001" })) as {
    current: { runtime: { error: unknown }; error: unknown };
    attempts: { error: unknown }[];
  };
  const event = await rpc("eventDetail", { id: "event:018f0000-0000-7000-8000-000000999999" });
  return [task.current.runtime.error, task.current.error, task.attempts[0]?.error, event.error];
}

dashboardSessionSuite(
  "standalone worker stack exposure (requires the built dashboard browser bundle)",
  () => {
    it("omits worker stacks on a remotely reachable listener unless the operator opts in", async () => {
      const remote = async (revealErrorStacks?: boolean) => {
        // Each listener gets its own port, so no pooled connection reaches a closed one.
        const port = await freePort();
        const running = await startDashboardServer(stackDatabase, {
          hostname: "0.0.0.0",
          port,
          publicOrigin: "https://dashboard.example",
          allowMutations: false,
          actor: "test",
          authentication: { username: "operator", passwordHash },
          ...(revealErrorStacks === undefined ? {} : { revealErrorStacks }),
        });
        try {
          return await persistedErrors(port);
        } finally {
          await running.close();
        }
      };

      expect(await remote()).toEqual(
        Array.from({ length: 4 }, () => ({ name: "Error", message: "failed" })),
      );
      expect(await remote(true)).toEqual(Array.from({ length: 4 }, () => workerError));
    });
  },
);
