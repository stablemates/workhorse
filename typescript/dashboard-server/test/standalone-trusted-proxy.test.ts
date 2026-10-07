import { scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Queryable } from "@stablemates/workhorse";
import { describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server/standalone.js";
import { PROTOCOL_VERSION, WORKHORSE_SCHEMA_VERSION } from "@stablemates/workhorse";

const database = {
  query: async () => ({
    rows: [
      { kind: "protocol", version: PROTOCOL_VERSION },
      { kind: "schema", version: WORKHORSE_SCHEMA_VERSION },
    ],
  }),
} as Queryable;
const salt = Buffer.from("workhorse-proxy-test-salt");
const authentication = {
  username: "operator",
  passwordHash: `scrypt-v1$${salt.toString("base64url")}$${scryptSync("correct horse", salt, 32).toString("base64url")}`,
};
const loginSuite = existsSync(path.resolve(import.meta.dirname, "../dist/app/login.html"))
  ? describe
  : describe.skip;

async function withListener(
  trustedProxies: readonly string[],
  run: (
    login: (password: string, headers?: Record<string, string>) => Promise<number>,
  ) => Promise<void>,
): Promise<void> {
  const running = await startDashboardServer(database, {
    hostname: "127.0.0.1",
    port: 0,
    allowMutations: false,
    actor: "test",
    authentication,
    trustedProxies,
  });
  try {
    await run(async (password, headers = {}) => {
      const response = await fetch(`${running.url}/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams({ username: "operator", password }),
      });
      await response.body?.cancel();
      return response.status;
    });
  } finally {
    await running.close();
  }
}

describe("standalone dashboard trusted proxies", () => {
  it("refuses a malformed setting and a Unix socket listener before binding", async () => {
    const options = {
      hostname: "127.0.0.1",
      port: 0,
      allowMutations: false,
      actor: "test",
      authentication,
    };
    await expect(
      startDashboardServer(database, { ...options, trustedProxies: ["10.0.0.0/33"] }),
    ).rejects.toThrow(/Invalid dashboard trusted proxy "10\.0\.0\.0\/33"/);
    await expect(
      startDashboardServer(database, {
        ...options,
        socketPath: "/nonexistent/dashboard.sock",
        trustedProxies: ["127.0.0.1"],
      }),
    ).rejects.toThrow(/require a TCP listener/);
  });
});

loginSuite(
  "standalone dashboard login throttling behind a proxy (requires the built bundle)",
  () => {
    it("ignores a spoofed X-Forwarded-For from a peer that is not a trusted proxy", async () => {
      await withListener(["192.0.2.1"], async (login) => {
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          expect(await login("wrong", { "x-forwarded-for": `198.51.100.${String(attempt)}` })).toBe(
            401,
          );
        }
        // Every attempt came from the loopback peer, whatever address it claimed.
        expect(await login("correct horse", { "x-forwarded-for": "203.0.113.50" })).toBe(429);
      });
    });

    it("gives two clients behind a trusted proxy separate windows", async () => {
      await withListener(["127.0.0.1"], async (login) => {
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          expect(await login("wrong", { "x-forwarded-for": "198.51.100.7" })).toBe(401);
        }
        expect(await login("correct horse", { "x-forwarded-for": "198.51.100.7" })).toBe(429);
        // A client cannot escape its window by prepending an address of its own choosing.
        expect(
          await login("correct horse", { "x-forwarded-for": "203.0.113.9, 198.51.100.7" }),
        ).toBe(429);
        expect(await login("correct horse", { "x-forwarded-for": "198.51.100.8" })).toBe(303);
        // The proxy's own requests carry no forwarded hop and keep their own window.
        expect(await login("correct horse")).toBe(303);
      });
    });
  },
);
