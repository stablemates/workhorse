import { createHmac, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Queue } from "../src/index.js";
import { createDatabaseTestHarness } from "./support/db.js";
import {
  acceptGitHubDelivery,
  createGitHubReceiver,
  createGitHubWorker,
  GitHubApi,
  installGitHubInbox,
  reconcileGitHubIssues,
  verifyGitHubRecipe,
  type GitHubScope,
} from "../../examples/github-triage.js";

const database = createDatabaseTestHarness(import.meta.url, {
  max: 8,
  extraSchemas: ["github_triage", "public"],
});
const scope: GitHubScope = {
  appId: 1,
  installationId: 2,
  repositoryId: 3,
  owner: "fixture",
  repository: "issues",
  label: "triage",
  secret: "fixture-only-secret",
};
const payload = {
  action: "opened",
  repository: { id: 3, full_name: "fixture/issues" },
  installation: { id: 2 },
  issue: { id: 4, number: 5, title: "雪" },
};

function signed(value: unknown = payload, changes: Record<string, string> = {}) {
  const body = Buffer.from(JSON.stringify(value));
  return {
    body,
    signature: `sha256=${createHmac("sha256", scope.secret).update(body).digest("hex")}`,
    event: "issues",
    delivery: randomUUID(),
    ...changes,
  };
}

async function counts() {
  const observed = await database.pool.query<{
    inbox: number;
    intents: number;
    tasks: number;
  }>(`SELECT
    (SELECT count(*)::int FROM github_triage.inbox) inbox,
    (SELECT count(*)::int FROM github_triage.intent) intents,
    (SELECT count(*)::int FROM workhorse.task) tasks`);
  return observed.rows[0];
}

beforeAll(async () => {
  await database.setup();
  await installGitHubInbox(database.pool);
  await database.pool.query(`
    CREATE TABLE public.transaction_evidence (source text, pid integer, xid bigint);
    CREATE FUNCTION public.record_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO public.transaction_evidence VALUES (TG_TABLE_NAME, pg_backend_pid(), txid_current());
      RETURN NEW;
    END $$;
    CREATE TRIGGER record_inbox AFTER INSERT ON github_triage.inbox FOR EACH ROW EXECUTE FUNCTION public.record_transaction();
    CREATE TRIGGER record_task AFTER INSERT ON workhorse.task FOR EACH ROW EXECUTE FUNCTION public.record_transaction();
  `);
});
beforeEach(async () => {
  await database.reset();
});
afterAll(async () => {
  await database.teardown();
});

describe("GitHub durable ingress and desired label state", () => {
  it("runs the packed consumer's offline verification without any vendor credential", async () => {
    expect(await verifyGitHubRecipe(database.databaseUrl)).toEqual({
      state: "succeeded",
      labels: ["keep-human-label", "triage"],
    });
    expect(await counts()).toEqual({ inbox: 2, intents: 1, tasks: 1 });
  });
  it("commits the normalized inbox reference and task on the same physical transaction", async () => {
    const accepted = await acceptGitHubDelivery(database.pool, scope, signed());
    expect(accepted.status).toBe(202);
    expect(await counts()).toEqual({ inbox: 1, intents: 1, tasks: 1 });
    const task = await database.pool.query(
      "SELECT payload, concurrency_key FROM workhorse.task WHERE id = $1",
      [accepted.taskId],
    );
    expect(task.rows[0]).toEqual({
      payload: { inboxId: accepted.inboxId },
      concurrency_key: "1/2/3/issue/4",
    });
    const evidence = await database.pool.query("SELECT * FROM public.transaction_evidence");
    expect(evidence.rows.map((row) => row.source).toSorted()).toEqual(["inbox", "task"]);
    expect(new Set(evidence.rows.map((row) => row.pid)).size).toBe(1);
    expect(new Set(evidence.rows.map((row) => row.xid)).size).toBe(1);
  });

  it.each([
    ["bad signature", () => signed(payload, { signature: `sha256=${"0".repeat(64)}` }), 401],
    ["altered event header", () => signed(payload, { event: "push" }), 400],
    ["invalid delivery header", () => signed(payload, { delivery: "not-a-guid" }), 400],
    [
      "repository id",
      () => signed({ ...payload, repository: { ...payload.repository, id: 999 } }),
      403,
    ],
    [
      "repository name",
      () => signed({ ...payload, repository: { ...payload.repository, full_name: "other/repo" } }),
      403,
    ],
    ["installation id", () => signed({ ...payload, installation: { id: 999 } }), 403],
    [
      "pull request",
      () => signed({ ...payload, issue: { ...payload.issue, pull_request: {} } }),
      400,
    ],
  ] as const)("rejects %s with no durable or external effect", async (_name, request, status) => {
    await expect(acceptGitHubDelivery(database.pool, scope, request())).rejects.toMatchObject({
      status,
    });
    expect(await counts()).toEqual({ inbox: 0, intents: 0, tasks: 0 });
  });

  it("ignores unknown signed actions without inventing a triage task", async () => {
    expect(
      await acceptGitHubDelivery(
        database.pool,
        scope,
        signed({ ...payload, action: "future-action" }),
      ),
    ).toEqual({ status: 204 });
    expect(await counts()).toEqual({ inbox: 0, intents: 0, tasks: 0 });
  });

  it("coalesces concurrent duplicate GUIDs persistently", async () => {
    const request = signed();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => acceptGitHubDelivery(database.pool, scope, request)),
    );
    expect(new Set(results.map((result) => result.taskId)).size).toBe(1);
    expect(new Set(results.map((result) => result.inboxId)).size).toBe(1);
    expect(await counts()).toEqual({ inbox: 1, intents: 1, tasks: 1 });
  });

  it("prevents an altered unsigned delivery GUID from repeating the business operation", async () => {
    const request = signed();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        acceptGitHubDelivery(database.pool, scope, { ...request, delivery: randomUUID() }),
      ),
    );
    expect(new Set(results.map((result) => result.taskId)).size).toBe(1);
    expect(await counts()).toEqual({ inbox: 6, intents: 1, tasks: 1 });
  });

  it("rejects changed raw bytes under an already accepted GUID even when newly signed", async () => {
    const request = signed();
    await acceptGitHubDelivery(database.pool, scope, request);
    const changed = signed(
      { ...payload, issue: { ...payload.issue, title: "changed" } },
      { delivery: request.delivery },
    );
    await expect(acceptGitHubDelivery(database.pool, scope, changed)).rejects.toMatchObject({
      status: 409,
    });
    expect(await counts()).toEqual({ inbox: 1, intents: 1, tasks: 1 });
  });

  it("keeps identical delivery GUIDs independent across authenticated installation/repository scopes", async () => {
    const request = signed();
    await acceptGitHubDelivery(database.pool, scope, request);
    const other = { ...scope, repositoryId: 6, installationId: 7, owner: "other" };
    const otherPayload = {
      ...payload,
      repository: { id: 6, full_name: "other/issues" },
      installation: { id: 7 },
    };
    await acceptGitHubDelivery(
      database.pool,
      other,
      signed(otherPayload, { delivery: request.delivery }),
    );
    expect(await counts()).toEqual({ inbox: 2, intents: 2, tasks: 2 });
  });

  it("rolls inbox, intent and enqueue back together when enqueue fails", async () => {
    await database.pool
      .query(`CREATE FUNCTION public.fail_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced enqueue failure'; END $$;
      CREATE TRIGGER fail_enqueue BEFORE INSERT ON workhorse.task FOR EACH ROW EXECUTE FUNCTION public.fail_enqueue()`);
    try {
      await expect(acceptGitHubDelivery(database.pool, scope, signed())).rejects.toThrow(
        "forced enqueue failure",
      );
      expect(await counts()).toEqual({ inbox: 0, intents: 0, tasks: 0 });
      expect(
        (await database.pool.query("SELECT * FROM public.transaction_evidence")).rowCount,
      ).toBe(0);
    } finally {
      await database.pool.query(
        "DROP TRIGGER fail_enqueue ON workhorse.task; DROP FUNCTION public.fail_enqueue()",
      );
    }
  });

  it.each([false, true])(
    "keeps writes invisible before commit and safely handles lost acknowledgment=%s",
    async (loseAck) => {
      const blocker = await database.pool.connect();
      await blocker.query("SELECT pg_advisory_lock(1121001)");
      await database.pool
        .query(`CREATE FUNCTION public.pause_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(1121001); RETURN NEW; END $$;
      CREATE TRIGGER pause_acceptance AFTER INSERT ON github_triage.inbox FOR EACH ROW EXECUTE FUNCTION public.pause_acceptance()`);
      const server = createGitHubReceiver(database.pool, scope);
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/github`;
      const request = signed();
      const controller = new AbortController();
      let acknowledged = false;
      const response = fetch(url, {
        method: "POST",
        body: request.body,
        headers: {
          "X-Hub-Signature-256": request.signature,
          "X-GitHub-Event": request.event,
          "X-GitHub-Delivery": request.delivery,
        },
        signal: controller.signal,
      }).then(
        (result) => {
          acknowledged = true;
          return result.status;
        },
        () => -1,
      );
      try {
        await expect
          .poll(
            async () =>
              (
                await database.pool.query(
                  "SELECT count(*)::int count FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'",
                )
              ).rows[0].count,
          )
          .toBe(1);
        expect(acknowledged).toBe(false);
        expect(await counts()).toEqual({ inbox: 0, intents: 0, tasks: 0 });
        if (loseAck) controller.abort();
        await blocker.query("SELECT pg_advisory_unlock(1121001)");
        expect(await response).toBe(loseAck ? -1 : 202);
        await expect.poll(counts).toEqual({ inbox: 1, intents: 1, tasks: 1 });
        const retry = await acceptGitHubDelivery(database.pool, scope, request);
        expect(retry.status).toBe(202);
        expect(await counts()).toEqual({ inbox: 1, intents: 1, tasks: 1 });
      } finally {
        await blocker.query("SELECT pg_advisory_unlock_all()");
        blocker.release();
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        await database.pool.query(
          "DROP TRIGGER pause_acceptance ON github_triage.inbox; DROP FUNCTION public.pause_acceptance()",
        );
      }
    },
  );

  it("retains business deduplication after queue-key expiration and a successful task", async () => {
    const request = signed();
    const accepted = await acceptGitHubDelivery(database.pool, scope, request);
    const transport = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("/fixture/issues")
        ? Response.json({ id: 3 })
        : Response.json({ id: 4, number: 5, state: "open", labels: [{ name: "triage" }] }),
    );
    await createGitHubWorker(
      database.pool,
      scope,
      new GitHubApi(async () => "installation-token", transport),
    ).runOnce();
    await database.pool.query(
      "UPDATE workhorse.enqueue_idempotency SET expires_at = now() - interval '1 second'",
    );
    const replay = await acceptGitHubDelivery(database.pool, scope, {
      ...request,
      delivery: randomUUID(),
    });
    expect(replay.taskId).toBe(accepted.taskId);
    expect(await counts()).toEqual({ inbox: 2, intents: 1, tasks: 1 });
    expect(
      (await database.pool.query("SELECT applied_at FROM github_triage.intent")).rows[0].applied_at,
    ).toBeInstanceOf(Date);
  });

  it("restarts after external label success but lost receipt/checkpoint without duplicating label state", async () => {
    const accepted = await acceptGitHubDelivery(database.pool, scope, signed());
    const labels = new Set(["keep-human-label"]);
    const requestedLabels: unknown[] = [];
    const transport = vi.fn<typeof fetch>(async (input, options) => {
      expect(options?.headers).toMatchObject({ Authorization: "Bearer installation-token" });
      if (String(input).endsWith("/fixture/issues")) return Response.json({ id: 3 });
      if (options?.method === "POST") {
        requestedLabels.push(JSON.parse(String(options.body)));
        labels.add("triage");
        return Response.json([...labels].map((name) => ({ name })));
      }
      return Response.json({
        id: 4,
        number: 5,
        state: "open",
        labels: [...labels].map((name) => ({ name })),
      });
    });
    await database.pool
      .query(`CREATE FUNCTION public.lose_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt storage unavailable'; END $$;
      CREATE TRIGGER lose_receipt BEFORE UPDATE ON github_triage.intent FOR EACH ROW EXECUTE FUNCTION public.lose_receipt()`);
    const api = new GitHubApi(async () => "installation-token", transport);
    try {
      await createGitHubWorker(database.pool, scope, api).runOnce();
      expect(labels.has("triage")).toBe(true);
      expect(
        (await database.pool.query("SELECT applied_at FROM github_triage.intent")).rows[0]
          .applied_at,
      ).toBeNull();
      expect(
        (
          await database.pool.query("SELECT * FROM workhorse.task_checkpoint WHERE task_id = $1", [
            accepted.taskId,
          ])
        ).rowCount,
      ).toBe(0);
    } finally {
      await database.pool.query(
        "DROP TRIGGER lose_receipt ON github_triage.intent; DROP FUNCTION public.lose_receipt()",
      );
    }
    await database.pool.query(
      "UPDATE workhorse.task_runtime SET run_at = now() WHERE task_id = $1",
      [accepted.taskId],
    );
    await new Queue(database.pool, "github-triage").tick();
    await createGitHubWorker(database.pool, scope, api).runOnce();
    expect(transport.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(
      1,
    );
    expect(requestedLabels).toEqual([{ labels: ["triage"] }]);
    expect([...labels].toSorted()).toEqual(["keep-human-label", "triage"]);
    expect(
      (
        await database.pool.query("SELECT * FROM workhorse.task_checkpoint WHERE task_id = $1", [
          accepted.taskId,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it("reconciles paginated current resources after a long outage using the same persistent operation identity", async () => {
    const accepted = await acceptGitHubDelivery(database.pool, scope, signed());
    const transport = vi.fn<typeof fetch>(async (input, options) => {
      expect(options?.headers).toMatchObject({ Authorization: "Bearer installation-token" });
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/issues")) throw new Error("Wrong resource endpoint");
      if (!url.search) return Response.json({ id: 3 });
      if (url.searchParams.has("page"))
        return Response.json([
          { id: 8, number: 9, state: "open" },
          { id: 10, number: 11, state: "open", pull_request: {} },
        ]);
      return Response.json([{ id: 4, number: 5, state: "open" }], {
        headers: {
          Link: '<https://api.github.com/repos/fixture/issues/issues?state=open&per_page=100&page=2>; rel="next"',
        },
      });
    });
    const api = new GitHubApi(async () => "installation-token", transport);
    const first = await reconcileGitHubIssues(database.pool, scope, api);
    expect(first[0]).toBe(accepted.taskId);
    expect(await reconcileGitHubIssues(database.pool, scope, api)).toEqual(first);
    expect(await counts()).toEqual({ inbox: 3, intents: 2, tasks: 2 });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int count FROM github_triage.inbox WHERE source = 'reconciliation'",
        )
      ).rows[0].count,
    ).toBe(2);
  });

  it("does not let per-issue concurrency pretend to be enqueue deduplication", async () => {
    const queue = new Queue(database.pool, "negative-control");
    await queue.enqueue("example", {}, { concurrencyKey: "same-issue" });
    await queue.enqueue("example", {}, { concurrencyKey: "same-issue" });
    expect((await counts())?.tasks).toBe(2);
  });
});
