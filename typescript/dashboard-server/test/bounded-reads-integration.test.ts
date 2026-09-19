import { gunzipSync } from "node:zlib";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { ORPCError } from "@orpc/server";
import type { RouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { Worker } from "../../core/src/index.js";
import { createIntegrationTestContext } from "../../core/test/support/integration.js";
import { createDashboardHost } from "../src/server/host.js";
import { readDashboardTaskDetail, readDashboardTaskValue } from "../src/server/read-model.js";
import { DashboardReadTimeoutError, dashboardDatabase, sql } from "../src/server/sql.js";
import type { DashboardRouter } from "../src/server/router.js";

const { pool, queue } = createIntegrationTestContext(import.meta.url);

/** Comfortably past the 64 KiB inline bound, and within the default 1 MiB task-value limit. */
function largeValue(marker: string): { marker: string; filler: string } {
  return { marker, filler: "x".repeat(1_000_000) };
}

function dashboardClient(
  host: ReturnType<typeof createDashboardHost>,
  headers: Record<string, string> = {},
): RouterClient<DashboardRouter> {
  return createORPCClient(
    new RPCLink({
      url: "http://dashboard.test/rpc",
      fetch: async (request) => {
        const merged = new Headers(request.headers);
        merged.set("origin", "http://dashboard.test");
        for (const [name, value] of Object.entries(headers)) merged.set(name, value);
        return (
          (await host.handle(new Request(request, { headers: merged }))) ??
          new Response(null, { status: 404 })
        );
      },
    }),
  );
}

/** The procedure this host serves sleeps in the database, standing in for a read that outgrew its
 * bound on a strained database rather than one that is expensive by design. */
function slowly(text: string): string {
  return text.includes("dashboard_task_counts_v1") ? "SELECT pg_sleep(5) AS result" : text;
}

function tasksRequest(acceptEncoding: string | null): Request {
  return new Request("http://dashboard.test/rpc/dashboard/tasks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://dashboard.test",
      ...(acceptEncoding === null ? {} : { "accept-encoding": acceptEncoding }),
    },
    body: JSON.stringify({ json: { pageSize: 100 } }),
  });
}

/** The two reads happened at different instants, so the capture moment is expected to differ. */
function capturedAtRemoved(body: string): unknown {
  const document = JSON.parse(body) as { json: Record<string, unknown> };
  delete document.json.capturedAt;
  return document;
}

describe("bounded dashboard task values", () => {
  it("withholds a payload past the inline bound and serves it whole on demand", async () => {
    const payload = largeValue("payload-marker");
    const id = await queue.enqueue("bounded-payload", payload);
    const database = dashboardDatabase(pool);

    const detail = await readDashboardTaskDetail(database, id);

    expect(detail?.payload).toBeNull();
    expect(detail?.payloadOmitted).toBe(true);
    expect(detail?.payloadBytes).toBeGreaterThan(1_000_000);

    const whole = await readDashboardTaskValue(database, id, "payload");

    expect(whole).toMatchObject({ id, kind: "payload", valueBytes: detail?.payloadBytes });
    expect(whole?.value).toEqual(payload);
  });

  it("withholds a result past the inline bound and serves it whole on demand", async () => {
    const result = largeValue("result-marker");
    const id = await queue.enqueue("bounded-result", {});
    const worker = new Worker(queue, { workerId: "bounded-result-worker" }).handle(
      "bounded-result",
      async () => result,
    );
    expect(await worker.runOnce()).toBe(true);
    const database = dashboardDatabase(pool);

    const detail = await readDashboardTaskDetail(database, id);

    expect(detail?.current.outcome?.result).toBeNull();
    expect(detail?.current.outcome?.resultOmitted).toBe(true);
    expect(detail?.current.outcome?.resultBytes).toBeGreaterThan(1_000_000);

    const whole = await readDashboardTaskValue(database, id, "result");

    expect(whole).toMatchObject({
      id,
      kind: "result",
      valueBytes: detail?.current.outcome?.resultBytes,
    });
    expect(whole?.value).toEqual(result);
  });

  it("carries a small payload and result inline and reports both sizes", async () => {
    const id = await queue.enqueue("bounded-small", { step: 1 });
    const worker = new Worker(queue, { workerId: "bounded-small-worker" }).handle(
      "bounded-small",
      async () => ({ ok: true }),
    );
    expect(await worker.runOnce()).toBe(true);

    const detail = await readDashboardTaskDetail(dashboardDatabase(pool), id);

    expect(detail?.payload).toEqual({ step: 1 });
    expect(detail?.payloadOmitted).toBe(false);
    expect(detail?.payloadBytes).toBe(11);
    expect(detail?.current.outcome?.result).toEqual({ ok: true });
    expect(detail?.current.outcome?.resultOmitted).toBe(false);
    expect(detail?.current.outcome?.resultBytes).toBe(12);
  });

  it("reports a null result of zero bytes for a task that has not finished", async () => {
    const id = await queue.enqueue("bounded-unfinished", {});

    const value = await readDashboardTaskValue(dashboardDatabase(pool), id, "result");

    expect(value).toEqual({ id, kind: "result", value: null, valueBytes: 0 });
  });

  it("answers an unknown task with no row, which the router turns into NOT_FOUND", async () => {
    const database = dashboardDatabase(pool);
    const missing = "00000000-0000-7000-8000-000000000000";

    await expect(readDashboardTaskValue(database, missing, "payload")).resolves.toBeNull();

    const host = createDashboardHost({ database: pool, path: "/", authorize: () => true });

    await expect(
      dashboardClient(host).dashboard.taskValue({ id: missing, kind: "payload" }),
    ).rejects.toThrow(/Task not found/);
  });
});

describe("bounded dashboard read time", () => {
  it("cancels a read past its bound and releases the connection it held", async () => {
    const database = dashboardDatabase(pool, 100);
    const idleBefore = pool.idleCount;

    await expect(database.execute(sql`SELECT pg_sleep(${5}) AS slept`)).rejects.toBeInstanceOf(
      DashboardReadTimeoutError,
    );

    // The connection is back in the pool rather than parked inside an abandoned transaction.
    expect(pool.idleCount).toBe(idleBefore);
    await expect(pool.query("SELECT 1 AS live")).resolves.toMatchObject({
      rows: [{ live: 1 }],
    });
  });

  it("names the bound it exceeded", async () => {
    const database = dashboardDatabase(pool, 50);

    await expect(database.execute(sql`SELECT pg_sleep(${5})`)).rejects.toMatchObject({
      name: "DashboardReadTimeoutError",
      timeoutMs: 50,
    });
  });

  it("refuses a write on the read-only connection a dashboard read runs over", async () => {
    const database = dashboardDatabase(pool);

    await expect(
      database.execute(sql`CREATE TABLE dashboard_read_should_not_write(id integer)`),
    ).rejects.toThrow(/read-only transaction/);
  });

  it("answers a read past its bound with a typed TIMEOUT rather than holding the request", async () => {
    const sleeping = {
      query: (text: string, values?: readonly unknown[]) =>
        pool.query(slowly(text), [...(values ?? [])]),
      async connect() {
        const client = await pool.connect();
        return Object.assign(Object.create(client) as typeof client, {
          query: (text: string, values?: readonly unknown[]) =>
            client.query(slowly(text), values as unknown[]),
          release: (error?: unknown) => client.release(error),
        });
      },
    };
    const host = createDashboardHost({
      database: sleeping as never,
      path: "/",
      statementTimeoutMs: 150,
      authorize: () => true,
    });

    const failure = await dashboardClient(host)
      .dashboard.taskCounts()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ORPCError);
    expect(failure).toMatchObject({ code: "TIMEOUT", status: 408 });
  });
});

describe("compressed dashboard RPC responses", () => {
  it("compresses a JSON answer the caller accepts an encoding for", async () => {
    for (let index = 0; index < 60; index += 1) {
      await queue.enqueue("compression-listing", { index, note: "a task listing row".repeat(8) });
    }
    const host = createDashboardHost({ database: pool, path: "/", authorize: () => true });

    const compressed = await host.handle(tasksRequest("gzip"));
    const plain = await host.handle(tasksRequest(null));

    expect(compressed?.headers.get("content-encoding")).toBe("gzip");
    expect(compressed?.headers.get("vary")).toMatch(/accept-encoding/);
    expect(plain?.headers.get("content-encoding")).toBeNull();
    // The browser still reads the same document; only the bytes on the wire changed. The two reads
    // happened at different instants, so the moment each page was captured is expected to differ.
    const encoded = Buffer.from(await compressed!.arrayBuffer());
    const plainBody = Buffer.from(await plain!.arrayBuffer());
    expect(encoded.byteLength).toBeLessThan(plainBody.byteLength);
    expect(capturedAtRemoved(gunzipSync(encoded).toString("utf8"))).toEqual(
      capturedAtRemoved(plainBody.toString("utf8")),
    );
  });

  it("leaves a body too small to gain from compression alone", async () => {
    const host = createDashboardHost({ database: pool, path: "/", authorize: () => true });

    const response = await host.handle(
      new Request("http://dashboard.test/rpc/dashboard/meta", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://dashboard.test",
          "accept-encoding": "br, gzip",
        },
        body: JSON.stringify({ json: {} }),
      }),
    );

    expect(response?.headers.get("content-encoding")).toBeNull();
    expect(response?.headers.get("vary")).toMatch(/accept-encoding/);
  });
});
