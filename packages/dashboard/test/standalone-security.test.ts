import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Queryable } from "@workhorse/core";
import { afterEach, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server/standalone.js";

const database = { query: async () => ({ rows: [{ version: 38 }] }) } as Queryable;
const scratchRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("standalone dashboard listener security", () => {
  it("refuses an unauthenticated listener on a remotely reachable interface", async () => {
    await expect(
      startDashboardServer(database, {
        hostname: "0.0.0.0",
        port: 3000,
        allowMutations: false,
        actor: "test",
      }),
    ).rejects.toThrow(/unauthenticated.*loopback|loopback.*unauthenticated/i);
    await expect(
      startDashboardServer(database, {
        hostname: "127.0.0.1",
        port: 3000,
        publicOrigin: "https://dashboard.example",
        allowMutations: false,
        actor: "test",
      }),
    ).rejects.toThrow(/unauthenticated.*remote public origin/i);
  });

  it("allows the unauthenticated development bypass on a Unix socket", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "workhorse-dashboard-socket-"));
    scratchRoots.push(scratch);
    const socketPath = path.join(scratch, "dashboard.sock");
    const running = await startDashboardServer(database, {
      hostname: "127.0.0.1",
      port: 3000,
      socketPath,
      allowMutations: false,
      actor: "test",
    });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest({ socketPath, path: "/login" }, (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 0));
        });
        request.once("error", reject);
        request.end();
      });
      expect(status).toBe(200);
    } finally {
      await running.close();
    }
  });

  it("requires an HTTPS public origin for an authenticated remote listener", async () => {
    const authentication = {
      username: "operator",
      passwordHash:
        "scrypt-v1$d29ya2hvcnNlLWF1dGgtc2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
    await expect(
      startDashboardServer(database, {
        hostname: "0.0.0.0",
        port: 3000,
        allowMutations: false,
        actor: "test",
        authentication,
      }),
    ).rejects.toThrow(/public origin/i);
    await expect(
      startDashboardServer(database, {
        hostname: "0.0.0.0",
        port: 3000,
        allowMutations: false,
        actor: "test",
        authentication,
        publicOrigin: "http://dashboard.example",
      }),
    ).rejects.toThrow(/HTTPS public origin/i);
    await expect(
      startDashboardServer(database, {
        hostname: "0.0.0.0",
        port: 3000,
        allowMutations: false,
        actor: "test",
        authentication,
        publicOrigin: "http://127.0.0.1",
      }),
    ).rejects.toThrow(/HTTPS public origin/i);
  });
});
