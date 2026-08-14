import { scryptSync } from "node:crypto";
import type { Queryable } from "@workhorse/core";
import { describe, expect, it, vi } from "vitest";
import { createDashboardHost } from "../src/server/host.js";

const salt = Buffer.from("workhorse-auth-test-salt");
const passwordHash = `scrypt-v1$${salt.toString("base64url")}$${scryptSync("correct horse", salt, 32).toString("base64url")}`;

const database = {
  query: async () => ({ rows: [{ version: 26 }] }),
} as unknown as Queryable;

async function login(host: ReturnType<typeof createDashboardHost>): Promise<Response> {
  const response = await host.handle(
    new Request("https://dashboard.test/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "operator", password: "correct horse" }),
    }),
  );
  if (!response) throw new Error("Dashboard did not own its login route");
  return response;
}

describe("dashboard single-admin authentication", () => {
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
});
