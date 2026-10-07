/* oxlint-disable vitest/no-standalone-expect -- dashboardBrowserTest wraps Vitest callbacks. */
/**
 * Whose login failures the demo's single-admin dashboard counts together.
 *
 * One piece of the demo integration suite. Every piece owns a scratch database, so the pieces run
 * in parallel; see ./support/demo-integration.ts for the harness they share.
 */
import { scryptSync } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect } from "vitest";
import { DemoOperatorRateLimiter } from "../src/operator-rate-limit.js";
import { DemoOperatorMutationGuard } from "../src/request-guards.js";
import { createDemoRequestListener } from "../src/request-listener.js";
import { createDemoIntegrationSuite, dashboardBrowserTest } from "./support/demo-integration.js";

const { createTestApplication } = createDemoIntegrationSuite(import.meta.url);

const salt = Buffer.from("workhorse-demo-login-salt");
const singleAdmin = {
  username: "operator",
  passwordHash: `scrypt-v1$${salt.toString("base64url")}$${scryptSync("correct horse", salt, 32).toString("base64url")}`,
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

/** Serve the demo application through the listener the demo server runs. */
async function serveDemo(): Promise<number> {
  const { app } = createTestApplication({ workers: false, singleAdmin });
  const server = createServer(
    createDemoRequestListener({
      fetch: app.fetch,
      rateLimiter: new DemoOperatorRateLimiter(),
      mutationGuard: new DemoOperatorMutationGuard(),
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

/**
 * Submit one wrong password with the `X-Forwarded-For` chain the deployment proxy forwards.
 *
 * The proxy appends the address it observes, so the chain's last entry is the client and anything
 * before it is whatever the client sent.
 */
function failLogin(port: number, forwardedFor: string): Promise<number> {
  const body = new URLSearchParams({ username: "operator", password: "wrong" }).toString();
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/login",
      method: "POST",
      agent: false,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": Buffer.byteLength(body),
        "x-forwarded-for": forwardedFor,
      },
    });
    request.on("response", (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end(body);
  });
}

const firstClient = "203.0.113.10";
const secondClient = "203.0.113.20";

describe("demo dashboard login throttle", () => {
  dashboardBrowserTest(
    "counts each proxied client's failures in its own window (requires the built dashboard browser bundle)",
    async () => {
      const port = await serveDemo();

      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(await failLogin(port, firstClient)).toBe(401);
      }
      expect(await failLogin(port, firstClient)).toBe(429);

      // Another visitor behind the same proxy still reaches the password check.
      expect(await failLogin(port, secondClient)).toBe(401);
    },
  );

  dashboardBrowserTest(
    "keys the window by the proxy-appended address, not by addresses the client sends (requires the built dashboard browser bundle)",
    async () => {
      const port = await serveDemo();

      // The first client invents a new origin for every attempt; its window still fills.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(await failLogin(port, `198.51.100.${attempt + 1}, ${firstClient}`)).toBe(401);
      }
      expect(await failLogin(port, `198.51.100.99, ${firstClient}`)).toBe(429);

      // The second client claims the first client's address and is still counted as itself.
      expect(await failLogin(port, `${firstClient}, ${secondClient}`)).toBe(401);
    },
  );
});
