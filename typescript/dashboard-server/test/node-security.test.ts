import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { dashboardNodeMiddleware } from "../src/server/node.js";
import type { DashboardHost } from "../src/server/host.js";

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.clear();
});

async function observedUrl(publicOrigin?: string, path = "/tasks?queue=payments"): Promise<string> {
  const host: DashboardHost = {
    basePath: "",
    owns: () => true,
    handle: (request) => Promise.resolve(Response.json({ url: request.url })),
  };
  const middleware = dashboardNodeMiddleware(host, { publicOrigin });
  const server = createServer((request, response) => middleware(request, response, () => {}));
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return new Promise<string>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        headers: { host: "internal.test", "x-forwarded-proto": "https" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { url: string };
          resolve(body.url);
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function observedClientAddress(
  trustedProxies: readonly string[] | undefined,
  headers: Record<string, string>,
): Promise<string | undefined> {
  let observed: string | undefined;
  const host: DashboardHost = {
    basePath: "",
    owns: () => true,
    handle: (_request, context) => {
      observed = context?.clientAddress;
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  };
  const middleware = dashboardNodeMiddleware(host, { trustedProxies });
  const server = createServer((request, response) => middleware(request, response, () => {}));
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path: "/", headers }, (response) => {
      response.resume();
      response.once("end", resolve);
    });
    request.once("error", reject);
    request.end();
  });
  return observed;
}

describe("dashboard Node transport security", () => {
  it("ignores untrusted forwarded protocol headers", async () => {
    await expect(observedUrl()).resolves.toBe("http://internal.test/tasks?queue=payments");
  });

  it("uses one explicit public origin behind a TLS-terminating proxy", async () => {
    await expect(observedUrl("https://dashboard.example")).resolves.toBe(
      "https://dashboard.example/tasks?queue=payments",
    );
  });

  it.each([
    "https://attacker.example/tasks?queue=payments",
    "//attacker.example/tasks?queue=payments",
  ])("does not let the request target replace the public origin: %s", async (path) => {
    await expect(observedUrl("https://dashboard.example", path)).resolves.toBe(
      "https://dashboard.example/tasks?queue=payments",
    );
  });

  it("passes the socket peer and ignores forwarding headers from an untrusted peer", async () => {
    await expect(
      observedClientAddress(undefined, { "x-forwarded-for": "198.51.100.4" }),
    ).resolves.toBe("127.0.0.1");
    // A configured proxy that is not this peer leaves the spoofed header unread.
    await expect(
      observedClientAddress(["192.0.2.1"], {
        "x-forwarded-for": "198.51.100.4",
      }),
    ).resolves.toBe("127.0.0.1");
  });

  it("passes the rightmost untrusted hop from a trusted proxy", async () => {
    await expect(
      observedClientAddress(["127.0.0.1"], { "x-forwarded-for": "192.0.2.66, 198.51.100.4" }),
    ).resolves.toBe("198.51.100.4");
    await expect(
      observedClientAddress(["127.0.0.0/8"], { forwarded: "for=198.51.100.5" }),
    ).resolves.toBe("198.51.100.5");
  });

  it("refuses a malformed trusted proxy when the middleware is created", () => {
    const host: DashboardHost = {
      basePath: "",
      owns: () => true,
      handle: () => Promise.resolve(null),
    };
    expect(() => dashboardNodeMiddleware(host, { trustedProxies: ["10.0.0.1/8"] })).toThrow(
      /Invalid dashboard trusted proxy "10\.0\.0\.1\/8"/,
    );
  });
});
