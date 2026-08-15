import { scryptSync } from "node:crypto";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { Queryable } from "@workhorse/core";
import { describe, expect, it, vi } from "vitest";
import { createDashboardHost } from "../src/server/host.js";
import type { DashboardRouter } from "../src/server/router.js";
import type { DashboardAuditContext } from "../src/server/types.js";

const salt = Buffer.from("workhorse-auth-test-salt");
const passwordHash = `scrypt-v1$${salt.toString("base64url")}$${scryptSync("correct horse", salt, 32).toString("base64url")}`;

const database = {
  query: async () => ({ rows: [{ version: 40 }] }),
} as unknown as Queryable;

async function login(
  host: ReturnType<typeof createDashboardHost>,
  password = "correct horse",
): Promise<Response> {
  const response = await host.handle(
    new Request("https://dashboard.test/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "operator", password }),
    }),
  );
  if (!response) throw new Error("Dashboard did not own its login route");
  return response;
}

function mutationClient(
  host: ReturnType<typeof createDashboardHost>,
  headers: HeadersInit,
): RouterClient<DashboardRouter> {
  return createORPCClient(
    new RPCLink({
      url: "https://dashboard.test/rpc",
      fetch: async (request) => {
        const forwarded = new Request(request, { headers: new Headers(request.headers) });
        for (const [name, value] of new Headers(headers)) forwarded.headers.set(name, value);
        return (await host.handle(forwarded)) ?? new Response(null, { status: 404 });
      },
    }),
  );
}

describe("dashboard single-admin authentication", () => {
  it("requires a bounded absolute cutoff when a previous password is configured", () => {
    expect(() =>
      createDashboardHost({
        database,
        singleAdmin: { username: "operator", passwordHash, previousPasswordHash: passwordHash },
      }),
    ).toThrow("previous password hash and expiry");
    expect(() =>
      createDashboardHost({
        database,
        singleAdmin: {
          username: "operator",
          passwordHash,
          previousPasswordHash: passwordHash,
          previousPasswordHashExpiresAt: "tomorrow",
        },
      }),
    ).toThrow("ISO 8601 timestamp");
  });

  it("rejects a host that combines application authorization with built-in credentials", () => {
    expect(() =>
      createDashboardHost({
        database,
        authorize: () => true,
        singleAdmin: { username: "operator", passwordHash },
      }),
    ).toThrow("Configure exactly one dashboard authorization mode");
  });

  it("prevents unauthenticated requests from reading application, asset, and RPC routes", async () => {
    const host = createDashboardHost({
      database,
      path: "/",
      singleAdmin: { username: "operator", passwordHash },
    });

    const application = await host.handle(new Request("https://dashboard.test/tasks"));
    const asset = await host.handle(new Request("https://dashboard.test/assets/index.js"));
    const rpc = await host.handle(new Request("https://dashboard.test/rpc/dashboard/meta"));

    expect(application?.status).toBe(302);
    expect(application?.headers.get("location")).toBe("/login");
    expect(asset?.status).toBe(401);
    expect(rpc?.status).toBe(401);
  });

  it("returns one generic failure and no cookie for invalid credentials", async () => {
    const host = createDashboardHost({
      database,
      path: "/",
      singleAdmin: { username: "operator", passwordHash },
    });

    const response = await host.handle(
      new Request("https://dashboard.test/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: "operator", password: "wrong password" }),
      }),
    );

    expect(response?.status).toBe(401);
    expect(response?.headers.has("set-cookie")).toBe(false);
    expect(await response?.text()).toContain("Invalid username or password");
  });

  it("creates a bounded secure server-side session after a valid login", async () => {
    const host = createDashboardHost({
      database,
      path: "/",
      singleAdmin: { username: "operator", passwordHash },
    });
    const loginResponse = await login(host);

    expect(loginResponse.status).toBe(303);
    expect(loginResponse.headers.get("location")).toBe("/");
    const setCookie = loginResponse.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(
      /^__Host-workhorse-dashboard-session=[A-Za-z0-9_-]+; Path=\/; Max-Age=28800; HttpOnly; Secure; SameSite=Strict$/,
    );
    expect(setCookie).not.toContain("correct horse");

    const cookie = setCookie.split(";", 1)[0];
    const application = await host.handle(
      new Request("https://dashboard.test/", { headers: { cookie } }),
    );
    expect(application?.status).toBe(302);
    expect(application?.headers.get("location")).toBe("/tasks");
  });

  it("invalidates the server-side session on logout", async () => {
    const host = createDashboardHost({
      database,
      path: "/",
      singleAdmin: { username: "operator", passwordHash },
    });
    const loginResponse = await login(host);
    const cookie = (loginResponse.headers.get("set-cookie") ?? "").split(";", 1)[0];

    const logout = await host.handle(
      new Request("https://dashboard.test/logout", {
        method: "POST",
        headers: { cookie },
      }),
    );
    const application = await host.handle(
      new Request("https://dashboard.test/tasks", { headers: { cookie } }),
    );

    expect(logout?.status).toBe(303);
    expect(logout?.headers.get("location")).toBe("/login");
    expect(logout?.headers.get("set-cookie")).toBe(
      "__Host-workhorse-dashboard-session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict",
    );
    expect(application?.status).toBe(302);
    expect(application?.headers.get("location")).toBe("/login");
  });

  it("rejects an expired session even when the browser still presents its cookie", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const host = createDashboardHost({
        database,
        path: "/",
        singleAdmin: { username: "operator", passwordHash, sessionTtlSeconds: 60 },
      });
      const loginResponse = await login(host);
      const cookie = (loginResponse.headers.get("set-cookie") ?? "").split(";", 1)[0];
      now.mockReturnValue(1_060_001);

      const application = await host.handle(
        new Request("https://dashboard.test/tasks", { headers: { cookie } }),
      );

      expect(application?.status).toBe(302);
      expect(application?.headers.get("location")).toBe("/login");
    } finally {
      now.mockRestore();
    }
  });

  it("bounds a previous password and every session created with it by the rotation cutoff", async () => {
    const previousSalt = Buffer.from("workhorse-previous-auth-salt");
    const previousPasswordHash = `scrypt-v1$${previousSalt.toString("base64url")}$${scryptSync("previous horse", previousSalt, 32).toString("base64url")}`;
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const host = createDashboardHost({
        database,
        path: "/",
        singleAdmin: {
          username: "operator",
          passwordHash,
          previousPasswordHash,
          previousPasswordHashExpiresAt: new Date(1_030_000).toISOString(),
        },
      });
      const previousLogin = await login(host, "previous horse");
      const previousCookie = (previousLogin.headers.get("set-cookie") ?? "").split(";", 1)[0];
      const currentLogin = await login(host);
      const currentCookie = (currentLogin.headers.get("set-cookie") ?? "").split(";", 1)[0];

      expect(previousLogin.headers.get("set-cookie")).toContain("Max-Age=30");
      now.mockReturnValue(1_030_001);

      expect((await login(host, "previous horse")).status).toBe(401);
      const previousSession = await host.handle(
        new Request("https://dashboard.test/tasks", { headers: { cookie: previousCookie } }),
      );
      const currentSession = await host.handle(
        new Request("https://dashboard.test/", { headers: { cookie: currentCookie } }),
      );
      expect(previousSession?.headers.get("location")).toBe("/login");
      expect(currentSession?.headers.get("location")).toBe("/tasks");
    } finally {
      now.mockRestore();
    }
  });

  it("throttles repeated login failures in a deterministic bounded window", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const host = createDashboardHost({
        database,
        path: "/",
        singleAdmin: { username: "operator", passwordHash },
      });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await login(host, "wrong password")).status).toBe(401);
      }
      const throttled = await login(host);
      expect(throttled.status).toBe(429);
      expect(throttled.headers.get("retry-after")).toBe("60");

      now.mockReturnValue(1_060_001);
      expect((await login(host)).status).toBe(303);
    } finally {
      now.mockRestore();
    }
  });

  it("reserves throttle capacity before concurrent password checks begin", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const host = createDashboardHost({
        database,
        path: "/",
        singleAdmin: { username: "operator", passwordHash },
      });

      const responses = await Promise.all(
        Array.from({ length: 6 }, () => login(host, "wrong password")),
      );
      expect(responses.map(({ status }) => status).toSorted()).toEqual([
        401, 401, 401, 401, 401, 429,
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it("bounds retained sessions by evicting the oldest successful login", async () => {
    const host = createDashboardHost({
      database,
      path: "/",
      singleAdmin: { username: "operator", passwordHash },
    });
    const cookies: string[] = [];
    for (let index = 0; index < 17; index += 1) {
      const response = await login(host);
      cookies.push((response.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "");
    }

    const oldest = await host.handle(
      new Request("https://dashboard.test/tasks", { headers: { cookie: cookies[0] ?? "" } }),
    );
    const newest = await host.handle(
      new Request("https://dashboard.test/", { headers: { cookie: cookies.at(-1) ?? "" } }),
    );

    expect(oldest?.status).toBe(302);
    expect(oldest?.headers.get("location")).toBe("/login");
    expect(newest?.status).toBe(302);
    expect(newest?.headers.get("location")).toBe("/tasks");
  });

  it("requires a same-origin session mutation and replaces forged browser attribution", async () => {
    const audits: DashboardAuditContext[] = [];
    const host = createDashboardHost({
      database,
      path: "/",
      singleAdmin: { username: "operator", passwordHash },
      operator: { mode: "local" },
      queueController: {
        setQueuePaused: async (_queue, paused, audit) => {
          audits.push(audit);
          return { paused };
        },
      },
    });
    const loginResponse = await login(host);
    const cookie = (loginResponse.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const input = {
      queue: "payments",
      paused: true,
      audit: { actor: "forged-browser-actor", reason: "deploy", requestId: "request-1" },
    };

    await expect(mutationClient(host, { cookie }).dashboard.setQueuePaused(input)).rejects.toThrow(
      /Forbidden|same-origin/i,
    );
    await expect(
      mutationClient(host, { cookie, origin: "https://attacker.test" }).dashboard.setQueuePaused(
        input,
      ),
    ).rejects.toThrow(/Forbidden|same-origin/i);
    await expect(
      mutationClient(host, { cookie, origin: "https://dashboard.test" }).dashboard.setQueuePaused(
        input,
      ),
    ).resolves.toEqual({ paused: true });

    expect(audits).toEqual([
      expect.objectContaining({
        actor: "operator",
        reason: "deploy",
        requestId: "request-1",
        occurredAt: expect.any(String),
      }),
    ]);
  });

  it("preserves embedded authorization while deriving audit identity on the server", async () => {
    const audits: DashboardAuditContext[] = [];
    const host = createDashboardHost({
      database,
      path: "/workhorse",
      authorize: () => ({ actor: "application-admin" }),
      operator: { mode: "local" },
      queueController: {
        setQueuePaused: async (_queue, paused, audit) => {
          audits.push(audit);
          return { paused };
        },
      },
    });
    const client = createORPCClient<RouterClient<DashboardRouter>>(
      new RPCLink({
        url: "https://dashboard.test/workhorse/rpc",
        fetch: async (request) => {
          const forwarded = new Request(request, { headers: new Headers(request.headers) });
          forwarded.headers.set("origin", "https://dashboard.test");
          return (await host.handle(forwarded)) ?? new Response(null, { status: 404 });
        },
      }),
    );

    await client.dashboard.setQueuePaused({
      queue: "payments",
      paused: false,
      audit: { actor: "forged-browser-actor", reason: "deploy", requestId: "request-2" },
    });

    expect(audits[0]?.actor).toBe("application-admin");
  });
});
