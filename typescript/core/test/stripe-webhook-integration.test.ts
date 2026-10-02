import { request as httpRequest, type Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { Admin, Pool, Queue, Worker } from "@stablemates/workhorse";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptInvoice,
  acceptInvoiceInTransaction,
  fulfillInvoice,
  installStripeRecipe,
  MAX_BODY_BYTES,
  QUEUE_NAME,
  stripeIngress,
  stripeWorker,
  TASK_TYPE,
  verifyInvoice,
  verifyOffline,
} from "../../examples/stripe-invoice-paid.js";
import { createDatabaseTestHarness } from "./support/db.js";
import { invoiceEvent, signedFixture, stripeScope } from "./support/stripe-invoice-fixture.js";

const database = createDatabaseTestHarness(import.meta.url, {
  max: 12,
  extraSchemas: ["stripe_recipe"],
});
const { pool } = database;
let server: Server;
let endpoint: string;

function reference(event = invoiceEvent()) {
  const fixture = signedFixture(event);
  const result = verifyInvoice(fixture.body, fixture.signature, stripeScope);
  if (!result) throw new Error("Expected invoice fixture");
  return result;
}

async function post(event: unknown = invoiceEvent(), overrides: Record<string, string> = {}) {
  const fixture = signedFixture(event);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": fixture.signature,
      ...overrides,
    },
    body: fixture.body,
  });
  await response.text();
  return response.status;
}

async function counts() {
  const result = await pool.query<{
    inbox: string;
    tasks: string;
    grants: string;
    credits: string;
  }>(`
    SELECT (SELECT count(*) FROM stripe_recipe.inbox) AS inbox,
           (SELECT count(*) FROM workhorse.task WHERE task_type = 'stripe.invoice-paid') AS tasks,
           (SELECT count(*) FROM stripe_recipe.invoice_grant) AS grants,
           (SELECT COALESCE(sum(paid_invoice_credits), 0) FROM stripe_recipe.entitlement) AS credits
  `);
  return result.rows[0];
}

beforeAll(async () => {
  await database.setup();
  await installStripeRecipe(pool);
});
beforeEach(async () => {
  await database.reset();
  server = stripeIngress(pool, stripeScope);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  endpoint = `http://127.0.0.1:${address.port}/stripe/invoice-paid`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
});
afterAll(async () => database.teardown());

describe("Stripe durable HTTP acceptance", () => {
  it("ACKs normalized durable acceptance without running the worker in HTTP", async () => {
    expect(await post()).toBe(200);
    expect(await counts()).toEqual({ inbox: "1", tasks: "1", grants: "0", credits: "0" });
    const stored = await pool.query("SELECT * FROM stripe_recipe.inbox");
    expect(JSON.stringify(stored.rows)).not.toMatch(/email|sensitive|Private invoice|https:/);
    const task = await pool.query("SELECT payload FROM workhorse.task");
    expect(task.rows[0].payload).toEqual({ inboxId: stored.rows[0].id });
    await stripeWorker(pool).runOnce();
    expect(await counts()).toEqual({ inbox: "1", tasks: "1", grants: "1", credits: "1" });
  });

  it("rejects bad/stale signatures and unauthorized signed account/mode before persistence", async () => {
    expect(await post(undefined, { "stripe-signature": "t=1,v1=invalid" })).toBe(400);
    const stale = signedFixture(undefined, { timestamp: Math.floor(Date.now() / 1_000) - 301 });
    expect(await post(undefined, { "stripe-signature": stale.signature })).toBe(400);
    expect(await post(invoiceEvent({ account: "acct_wrong" }))).toBe(403);
    expect(await post(invoiceEvent({ livemode: true }))).toBe(403);
    expect(await counts()).toEqual({ inbox: "0", tasks: "0", grants: "0", credits: "0" });
  });

  it("bounds the HTTP body and rejects compressed input, missing signatures and other routes", async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "invalid" },
      body: " ".repeat(MAX_BODY_BYTES + 1),
    });
    expect(response.status).toBe(413);
    await response.text();
    expect(await post(undefined, { "content-encoding": "gzip" })).toBe(400);
    expect(await post(undefined, { "stripe-signature": "" })).toBe(400);
    expect((await fetch(endpoint)).status).toBe(404);
    expect(await counts()).toEqual({ inbox: "0", tasks: "0", grants: "0", credits: "0" });
  });

  it("concurrently acknowledges one scoped event with one inbox and one task", async () => {
    expect(await Promise.all(Array.from({ length: 8 }, () => post()))).toEqual(Array(8).fill(200));
    expect(await counts()).toEqual({ inbox: "1", tasks: "1", grants: "0", credits: "0" });
    expect(await post(invoiceEvent({}, { customer: "cus_substituted" }))).toBe(409);
    expect(await counts()).toEqual({ inbox: "1", tasks: "1", grants: "0", credits: "0" });
  });

  it("bounds chunked bytes without invoking acceptance", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json", "stripe-signature": "invalid" },
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode!));
        },
      );
      request.once("error", reject);
      request.write(Buffer.alloc(MAX_BODY_BYTES));
      request.end(Buffer.from(" "));
    });
    expect(status).toBe(413);
    expect(await counts()).toEqual({ inbox: "0", tasks: "0", grants: "0", credits: "0" });
  });

  it("rejects excess ingress concurrency and recovers after incomplete requests disconnect", async () => {
    const requests: ReturnType<typeof httpRequest>[] = [];
    let arrived = 0;
    let allArrived!: () => void;
    const ready = new Promise<void>((resolve) => {
      allArrived = resolve;
    });
    const observe = () => {
      arrived += 1;
      if (arrived === 32) allArrived();
    };
    server.on("request", observe);
    try {
      for (let index = 0; index < 32; index += 1) {
        const request = httpRequest(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "stripe-signature": "invalid",
            "content-length": "100",
          },
        });
        request.on("error", () => undefined);
        requests.push(request);
        request.flushHeaders();
      }
      await ready;
      expect(await post()).toBe(503);
    } finally {
      server.off("request", observe);
      for (const request of requests) request.destroy();
    }
    let recovered = 503;
    for (let attempt = 0; attempt < 100 && recovered === 503; attempt += 1) {
      await sleep(10);
      recovered = await post();
    }
    expect(recovered).toBe(200);
    expect(await counts()).toEqual({ inbox: "1", tasks: "1", grants: "0", credits: "0" });
  });

  it("times out an incomplete raw body without accepting it", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        endpoint,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "stripe-signature": "invalid",
            "content-length": "100",
          },
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode!));
        },
      );
      request.once("error", reject);
      request.write("{");
    });
    expect(status).toBe(408);
    expect(await counts()).toEqual({ inbox: "0", tasks: "0", grants: "0", credits: "0" });
  });

  it("does not send ACK while acceptance is waiting to commit", async () => {
    const connect = pool.connect.bind(pool);
    let releaseCommit!: () => void;
    const commitAllowed = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let reachedCommit!: () => void;
    const commitReached = new Promise<void>((resolve) => {
      reachedCommit = resolve;
    });
    vi.spyOn(pool, "connect").mockImplementationOnce(async () => {
      const client = await connect();
      const query = client.query.bind(client);
      vi.spyOn(client, "query").mockImplementation((...args: Parameters<typeof client.query>) => {
        if (args[0] === "COMMIT") {
          reachedCommit();
          return commitAllowed.then(() => Reflect.apply(query, client, args));
        }
        return Reflect.apply(query, client, args);
      });
      return client;
    });
    let acknowledged = false;
    const pending = post().then((status) => {
      acknowledged = true;
      return status;
    });
    try {
      await commitReached;
      expect(acknowledged).toBe(false);
      expect(await counts()).toEqual({ inbox: "0", tasks: "0", grants: "0", credits: "0" });
    } finally {
      releaseCommit();
    }
    expect(await pending).toBe(200);
    expect(await counts()).toEqual({ inbox: "1", tasks: "1", grants: "0", credits: "0" });
  });

  it("uses independent scoped event and business identities for changed delivery order", async () => {
    expect(await post(invoiceEvent({ id: "evt_second", created: 1_790_966_500 }))).toBe(200);
    expect(await post(invoiceEvent({ type: "invoice.created", data: {} }))).toBe(200);
    expect(await post(invoiceEvent({ id: "evt_first", created: 1_790_966_300 }))).toBe(200);
    const inbox = await pool.query<{ id: string }>(
      "SELECT id FROM stripe_recipe.inbox ORDER BY event_created",
    );
    await Promise.all(inbox.rows.map(({ id }) => fulfillInvoice(pool, id)));
    expect(await counts()).toEqual({ inbox: "2", tasks: "2", grants: "1", credits: "1" });
    const liveScope = { ...stripeScope, livemode: true };
    const live = signedFixture(invoiceEvent({ livemode: true }, { livemode: true }));
    const liveReference = verifyInvoice(live.body, live.signature, liveScope)!;
    const separate = await acceptInvoice(pool, liveReference);
    await fulfillInvoice(pool, separate.inboxId);
    const otherAccount = await acceptInvoice(pool, { ...reference(), accountId: "acct_other" });
    await fulfillInvoice(pool, otherAccount.inboxId);
    expect(await counts()).toEqual({ inbox: "4", tasks: "4", grants: "3", credits: "3" });
  });

  it("proves shared physical transaction, observer invisibility, savepoint rollback and joint commit", async () => {
    const client = await pool.connect();
    const observer = await pool.connect();
    try {
      await client.query("BEGIN");
      const backend = await client.query("SELECT pg_backend_pid() AS pid");
      const observed = await observer.query("SELECT pg_backend_pid() AS pid");
      expect(backend.rows[0].pid).not.toBe(observed.rows[0].pid);
      await client.query("SAVEPOINT application_acceptance");
      await acceptInvoiceInTransaction(client, reference());
      expect(
        (await client.query("SELECT count(*) AS count FROM workhorse.task")).rows[0].count,
      ).toBe("1");
      expect(
        (await observer.query("SELECT count(*) AS count FROM stripe_recipe.inbox")).rows[0].count,
      ).toBe("0");
      expect(
        (await observer.query("SELECT count(*) AS count FROM workhorse.task")).rows[0].count,
      ).toBe("0");
      await client.query("ROLLBACK TO SAVEPOINT application_acceptance");
      expect(
        (await client.query("SELECT count(*) AS count FROM workhorse.task")).rows[0].count,
      ).toBe("0");
      await acceptInvoiceInTransaction(client, reference());
      await client.query("COMMIT");
      expect(
        (await observer.query("SELECT count(*) AS count FROM stripe_recipe.inbox")).rows[0].count,
      ).toBe("1");
      expect(
        (await observer.query("SELECT count(*) AS count FROM workhorse.task")).rows[0].count,
      ).toBe("1");
    } finally {
      await client.query("ROLLBACK");
      client.release();
      observer.release();
    }
  });

  it("rolls back the inbox when enqueue fails and returns retryable 503", async () => {
    vi.spyOn(Queue.prototype, "enqueue").mockRejectedValueOnce(
      new Error("injected enqueue failure"),
    );
    expect(await post()).toBe(503);
    expect(await counts()).toEqual({ inbox: "0", tasks: "0", grants: "0", credits: "0" });
    expect(await post()).toBe(200);
    expect(await counts()).toEqual({ inbox: "1", tasks: "1", grants: "0", credits: "0" });
  });

  it("never ACKs a failed COMMIT and rolls back both durable rows", async () => {
    await pool.query(`
      CREATE FUNCTION stripe_recipe.reject_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture deferred acceptance failure'; END $$;
      CREATE CONSTRAINT TRIGGER reject_acceptance AFTER INSERT ON stripe_recipe.inbox
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stripe_recipe.reject_commit()
    `);
    try {
      expect(await post()).toBe(503);
      expect(await counts()).toEqual({ inbox: "0", tasks: "0", grants: "0", credits: "0" });
    } finally {
      await pool.query(
        "DROP TRIGGER reject_acceptance ON stripe_recipe.inbox; DROP FUNCTION stripe_recipe.reject_commit()",
      );
    }
    expect(await post()).toBe(200);
  });

  it("recovers redelivery after commit-before-ACK connection loss", async () => {
    const fixture = signedFixture();
    const connect = pool.connect.bind(pool);
    vi.spyOn(pool, "connect").mockImplementationOnce(async () => {
      const client = await connect();
      const query = client.query.bind(client);
      vi.spyOn(client, "query").mockImplementation((...args: Parameters<typeof client.query>) => {
        const result = Reflect.apply(query, client, args);
        if (args[0] === "COMMIT") {
          return Promise.resolve(result).then((committed) => {
            server.closeAllConnections();
            return committed;
          });
        }
        return result;
      });
      return client;
    });
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(
        endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json", "stripe-signature": fixture.signature },
        },
        () => reject(new Error("ACK must be lost")),
      );
      request.once("error", () => resolve());
      request.end(fixture.body);
    });
    vi.restoreAllMocks();
    expect(await counts()).toEqual({ inbox: "1", tasks: "1", grants: "0", credits: "0" });
    expect(await post()).toBe(200);
    expect(await counts()).toEqual({ inbox: "1", tasks: "1", grants: "0", credits: "0" });
  });

  it("retains application dedupe when the queue key expires", async () => {
    const accepted = await acceptInvoice(pool, reference());
    await stripeWorker(pool).runOnce();
    await pool.query(
      "UPDATE workhorse.enqueue_idempotency SET expires_at = clock_timestamp() - interval '1 day'",
    );
    expect(await post()).toBe(200);
    const replay = await acceptInvoice(pool, reference());
    expect(replay).toEqual({ ...accepted, duplicate: true });
    const freshEvent = await acceptInvoice(
      pool,
      reference(invoiceEvent({ id: "evt_afterexpiry" })),
    );
    await fulfillInvoice(pool, freshEvent.inboxId);
    expect(await counts()).toEqual({ inbox: "2", tasks: "2", grants: "1", credits: "1" });
  });

  it("restarts after entitlement commit before task completion without granting twice", async () => {
    const accepted = await acceptInvoice(pool, reference());
    const crashing = new Worker(new Queue(pool, QUEUE_NAME)).handle<{ inboxId: string }>(
      TASK_TYPE,
      async ({ inboxId }) => {
        await fulfillInvoice(pool, inboxId);
        throw new Error("fixture process lost after business commit");
      },
    );
    await crashing.runOnce();
    expect(await counts()).toEqual({ inbox: "1", tasks: "1", grants: "1", credits: "1" });
    await sleep(1_100);
    const restarted = new Pool({ connectionString: database.databaseUrl, max: 8 });
    try {
      await stripeWorker(restarted).runOnce();
      expect((await new Admin(restarted).getTask(accepted.taskId))?.state).toBe("succeeded");
      expect((await fulfillInvoice(restarted, accepted.inboxId)).granted).toBe(false);
    } finally {
      await restarted.end();
    }
    expect(await counts()).toEqual({ inbox: "1", tasks: "1", grants: "1", credits: "1" });
  });

  it("rolls back a partial business grant and refuses a conflicting invoice customer", async () => {
    const accepted = await acceptInvoice(pool, reference());
    await pool.query(
      "ALTER TABLE stripe_recipe.entitlement ADD CONSTRAINT fixture_reject CHECK (paid_invoice_credits < 1)",
    );
    try {
      await expect(fulfillInvoice(pool, accepted.inboxId)).rejects.toThrow("fixture_reject");
      expect(await counts()).toEqual({ inbox: "1", tasks: "1", grants: "0", credits: "0" });
    } finally {
      await pool.query("ALTER TABLE stripe_recipe.entitlement DROP CONSTRAINT fixture_reject");
    }
    await fulfillInvoice(pool, accepted.inboxId);
    const conflicting = await acceptInvoice(
      pool,
      reference(invoiceEvent({ id: "evt_conflict" }, { customer: "cus_other" })),
    );
    await expect(fulfillInvoice(pool, conflicting.inboxId)).rejects.toThrow(
      "operator reconciliation",
    );
    expect(await counts()).toEqual({ inbox: "2", tasks: "2", grants: "1", credits: "1" });
  });

  it("runs the same offline verification entry point as the packed installed consumer", async () => {
    expect(await verifyOffline(pool)).toMatchObject({ status: "verified", outboundCalls: 0 });
  });
});
