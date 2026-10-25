import type { Queryable } from "@stablemates/workhorse";
import { describe, expect, it } from "vitest";
import { createDashboardHost } from "../src/server/host.js";
import {
  DASHBOARD_BROWSER_MODULES_PLACEHOLDER,
  DASHBOARD_RUNTIME_CONFIG_PLACEHOLDER,
} from "../src/server/html.js";
import { PROTOCOL_VERSION, WORKHORSE_SCHEMA_VERSION } from "@stablemates/workhorse";

const ORIGIN = "https://dashboard.test";
const FOREIGN = "https://partner.example";

const database = {
  query: async () => ({
    rows: [
      { kind: "protocol", version: PROTOCOL_VERSION },
      { kind: "schema", version: WORKHORSE_SCHEMA_VERSION },
    ],
  }),
} as unknown as Queryable;

// Serving the application from the dev hook keeps this test independent of the packaged bundle.
const host = createDashboardHost({
  database,
  path: "/workhorse",
  authorize: () => ({ actor: "operator" }),
  dev: {
    readTemplate: async () =>
      `<script>${DASHBOARD_RUNTIME_CONFIG_PLACEHOLDER}</script>${DASHBOARD_BROWSER_MODULES_PLACEHOLDER}`,
    transformHtml: async (_url: string, html: string) => html,
  },
});

function get(path: string, origin?: string): Promise<Response | null> {
  return host.handle(
    new Request(`${ORIGIN}${path}`, { headers: origin === undefined ? {} : { origin } }),
  );
}

function read(origin?: string): Promise<Response | null> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin !== undefined) headers.origin = origin;
  return host.handle(
    new Request(`${ORIGIN}/workhorse/rpc/dashboard/meta`, { method: "POST", headers, body: "{}" }),
  );
}

// A host CORS policy with credentials would let a foreign page read these responses with the
// operator's cookies. A browser sends Origin on each cross-origin fetch, so the host refuses it.
describe("cross-origin reads", () => {
  it.each([
    ["page", "/workhorse/tasks"],
    ["asset", "/workhorse/assets/index.js"],
    ["mount redirect", "/workhorse"],
  ])("refuses a %s whose Origin names another origin", async (_name, path) => {
    for (const origin of [FOREIGN, "null", "not a url", ""]) {
      const response = await get(path, origin);
      expect({ origin, status: response?.status, body: await response?.json() }).toEqual({
        origin,
        status: 403,
        body: { error: "A same-origin request is required" },
      });
    }
  });

  it("refuses a read procedure whose Origin names another origin", async () => {
    const response = await read(FOREIGN);
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ error: "A same-origin request is required" });
  });

  it("refuses a read whose two Origin headers name the same and another origin", async () => {
    const headers = new Headers({ "content-type": "application/json" });
    headers.append("origin", ORIGIN);
    headers.append("origin", FOREIGN);
    const response = await host.handle(
      new Request(`${ORIGIN}/workhorse/rpc/dashboard/meta`, {
        method: "POST",
        headers,
        body: "{}",
      }),
    );
    expect(response?.status).toBe(403);
  });

  it("refuses an Origin with a path, which also catches two joined Origin headers", async () => {
    for (const origin of [
      `${ORIGIN}/`,
      `${ORIGIN}\\path`,
      `${ORIGIN}/, ${FOREIGN}`,
      `${ORIGIN}, ${FOREIGN}`,
    ]) {
      expect((await read(origin))?.status).toBe(403);
    }
  });

  it("serves a read whose Host has another letter case and the default port", async () => {
    const response = await host.handle(
      new Request("https://DASHBOARD.test:443/workhorse/rpc/dashboard/meta", {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: "{}",
      }),
    );
    expect(response?.status).toBe(200);
  });

  it("refuses a cross-origin read before it checks the body size", async () => {
    const response = await host.handle(
      new Request(`${ORIGIN}/workhorse/rpc/dashboard/meta`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: FOREIGN,
          "content-length": "2097153",
        },
        body: "{}",
      }),
    );
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ error: "A same-origin request is required" });
  });

  it("refuses the workspace redirect and an unknown workspace for another origin", async () => {
    const workspaces = createDashboardHost({
      path: "/workhorse",
      workspaces: { production: { database } },
      authorize: () => ({ actor: "operator" }),
    });
    for (const path of ["/workhorse", "/workhorse/", "/workhorse/unknown/tasks"]) {
      const request = (origin?: string) =>
        new Request(`${ORIGIN}${path}`, { headers: origin === undefined ? {} : { origin } });
      const refused = await workspaces.handle(request(FOREIGN));
      expect(refused?.status).toBe(403);
      expect(await refused?.json()).toEqual({ error: "A same-origin request is required" });
      expect((await workspaces.handle(request()))?.status).not.toBe(403);
      expect((await workspaces.handle(request(ORIGIN)))?.status).not.toBe(403);
    }
  });

  it("keeps the mutation refusal text for a cross-origin mutation", async () => {
    const response = await host.handle(
      new Request(`${ORIGIN}/workhorse/rpc/dashboard/setQueuePaused`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: FOREIGN },
        body: "{}",
      }),
    );
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ error: "A same-origin mutation request is required" });
  });

  it("serves a page and a read without Origin or with the same origin", async () => {
    for (const origin of [undefined, ORIGIN]) {
      const page = await get("/workhorse/tasks", origin);
      expect(page?.status).toBe(200);
      expect(await page?.text()).toContain("window.workhorseDashboard");
      const redirect = await get("/workhorse", origin);
      expect(redirect?.status).toBe(302);
      const response = await read(origin);
      expect(response?.status).toBe(200);
      expect(await response?.json()).toEqual({ json: { environment: "unknown" } });
    }
  });
});
