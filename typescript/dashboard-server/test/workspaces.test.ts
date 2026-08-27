import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { Queryable } from "@stablemates/workhorse";
import { describe, expect, it } from "vitest";
import { createDashboardHost } from "../src/server/host.js";
import {
  DASHBOARD_BROWSER_MODULES_PLACEHOLDER,
  DASHBOARD_RUNTIME_CONFIG_PLACEHOLDER,
} from "../src/server/html.js";
import type { DashboardRouter } from "../src/server/router.js";
import { WORKHORSE_SCHEMA_VERSION } from "@stablemates/workhorse";

const fakeDatabase = (): Queryable =>
  ({
    query: async () => ({ rows: [{ version: WORKHORSE_SCHEMA_VERSION }] }),
  }) as unknown as Queryable;

// Serving the application from the dev hook keeps this test independent of the packaged bundle.
const dev = {
  readTemplate: async () =>
    `<script>${DASHBOARD_RUNTIME_CONFIG_PLACEHOLDER}</script>${DASHBOARD_BROWSER_MODULES_PLACEHOLDER}`,
  transformHtml: async (_url: string, html: string) => html,
};

function createWorkspaceHost(authorized: (workspace: string | null) => void = () => undefined) {
  return createDashboardHost({
    path: "/workhorse",
    workspaces: {
      production: {
        database: fakeDatabase(),
        databaseHost: "db.internal:5432",
        databaseName: "workhorse_demo",
      },
      staging: { database: fakeDatabase(), environment: "staging" },
    },
    authorize: (_request, workspace) => {
      authorized(workspace);
      return { actor: `operator:${workspace ?? "none"}` };
    },
    dev,
  });
}

function get(host: ReturnType<typeof createDashboardHost>, path: string): Promise<Response | null> {
  return host.handle(new Request(`http://dashboard.test${path}`));
}

function rpcClient(
  host: ReturnType<typeof createDashboardHost>,
  rpcUrl: string,
): RouterClient<DashboardRouter> {
  return createORPCClient(
    new RPCLink({
      url: `http://dashboard.test${rpcUrl}`,
      fetch: async (request) =>
        (await host.handle(new Request(request))) ?? new Response(null, { status: 404 }),
    }),
  );
}

describe("dashboard workspaces", () => {
  it("redirects the mount root to the default workspace", async () => {
    const host = createWorkspaceHost();
    for (const path of ["/workhorse", "/workhorse/"]) {
      const response = await get(host, path);
      expect(response?.status).toBe(302);
      expect(response?.headers.get("location")).toBe("/workhorse/production/tasks");
    }
  });

  it("redirects a workspace root to its task listing", async () => {
    const response = await get(createWorkspaceHost(), "/workhorse/staging");
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe("/workhorse/staging/tasks");
  });

  it("renders each workspace with its own base path and the full workspace list", async () => {
    const response = await get(createWorkspaceHost(), "/workhorse/staging/tasks");
    expect(response?.status).toBe(200);
    const html = (await response?.text()) ?? "";
    expect(html).toContain('"basePath":"/workhorse/staging"');
    expect(html).toContain('"rpcUrl":"/workhorse/staging/rpc"');
    expect(html).toContain('"workspace":"staging"');
    expect(html).toContain('"auditActor":"operator:staging"');
    // Production carries its configured database labels; staging configured none, so its
    // link omits the fields rather than inventing values.
    expect(html).toContain(
      '"workspaces":[{"name":"production","url":"/workhorse/production","databaseHost":"db.internal:5432","databaseName":"workhorse_demo"},{"name":"staging","url":"/workhorse/staging"}]',
    );
  });

  it("routes each workspace's endpoint to its own request context", async () => {
    const host = createWorkspaceHost();
    const production = rpcClient(host, "/workhorse/production/rpc");
    const staging = rpcClient(host, "/workhorse/staging/rpc");
    await expect(production.dashboard.meta()).resolves.toMatchObject({ environment: "unknown" });
    await expect(staging.dashboard.meta()).resolves.toMatchObject({ environment: "staging" });
  });

  it("hands the resolved workspace to the authorization boundary", async () => {
    const seen: (string | null)[] = [];
    const host = createWorkspaceHost((workspace) => seen.push(workspace));
    await get(host, "/workhorse/production/tasks");
    await get(host, "/workhorse");
    expect(seen).toEqual(["production", null]);
  });

  it("answers 404 outside every workspace instead of serving the application", async () => {
    const host = createWorkspaceHost();
    const paths = ["/workhorse/unknown/tasks", "/workhorse/rpc/dashboard/meta", "/workhorse/tasks"];
    for (const path of paths) {
      const response = await get(host, path);
      expect(response?.status).toBe(404);
    }
  });

  it("keeps single-database mode on its original URLs with no workspace list", async () => {
    const seen: (string | null)[] = [];
    const host = createDashboardHost({
      path: "/workhorse",
      database: fakeDatabase(),
      authorize: (_request, workspace) => {
        seen.push(workspace);
        return { actor: "operator" };
      },
      dev,
    });
    const redirect = await get(host, "/workhorse");
    expect(redirect?.status).toBe(302);
    expect(redirect?.headers.get("location")).toBe("/workhorse/tasks");
    const response = await get(host, "/workhorse/tasks");
    const html = (await response?.text()) ?? "";
    expect(html).toContain('"workspaces":[]');
    expect(html).toContain('"workspace":null');
    expect(seen).toEqual([null, null]);
  });

  it("rejects invalid workspace configuration before serving anything", () => {
    const database = fakeDatabase();
    const base = { authorize: () => true } as const;
    expect(() => createDashboardHost({ ...base })).toThrow(/exactly one of/);
    expect(() =>
      createDashboardHost({ ...base, database, workspaces: { a: { database } } }),
    ).toThrow(/exactly one of/);
    expect(() => createDashboardHost({ ...base, workspaces: {} })).toThrow(/at least one/);
    expect(() => createDashboardHost({ ...base, workspaces: { rpc: { database } } })).toThrow(
      /Invalid dashboard workspace name/,
    );
    expect(() =>
      createDashboardHost({ ...base, workspaces: { "bad/name": { database } } }),
    ).toThrow(/Invalid dashboard workspace name/);
    expect(() =>
      createDashboardHost({
        ...base,
        workspaces: { production: { database } },
        defaultWorkspace: "missing",
      }),
    ).toThrow(/Unknown default dashboard workspace/);
  });
});
