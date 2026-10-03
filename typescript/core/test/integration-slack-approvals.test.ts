import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Admin, Queue } from "../src/index.js";
import { createDatabaseTestHarness } from "./support/db.js";
import {
  acknowledgmentBudgetMs,
  approvalQueue,
  approvalTaskType,
  approvalWaitName,
  createApprovalWorker,
  createSlackReceiver,
  installRecipeSchema,
  notifyApprovals,
  settleDecision,
  slackPoster,
  SlackRateLimitError,
  validateScope,
  verifySlackSignature,
  verifyApprovalRecipe,
  type RecipeHooks,
  type SlackScope,
} from "../../examples/slack-approvals.js";

const database = createDatabaseTestHarness(import.meta.url, { extraSchemas: ["slack_recipe"] });
const { pool } = database;
const queue = new Queue(pool, approvalQueue);
const admin = new Admin(pool);
const scope: SlackScope = {
  teamId: "T123",
  appId: "A123",
  channelId: "C123",
  authorizedUsers: ["U123", "U456"],
};
const signingSecret = "local-fixture-signing-secret-not-a-credential";
const servers: Server[] = [];

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

type PostMessage = Parameters<typeof notifyApprovals>[2];

const post = vi.fn<PostMessage>(async (_message) => ({
  channel: scope.channelId,
  ts: "1712345678.000001",
}));

async function register() {
  const taskId = await queue.enqueue(approvalTaskType, {});
  const worker = createApprovalWorker(pool, scope);
  expect(await worker.runOnce()).toBe(true);
  return { taskId, worker };
}

async function prompt() {
  const registered = await register();
  expect(await notifyApprovals(pool, scope, post)).toBe(1);
  const result = await pool.query<{ reference: string }>(
    "SELECT reference FROM slack_recipe.approval",
  );
  return { ...registered, reference: result.rows[0]!.reference };
}

function payload(reference: string, decision = "approve") {
  return {
    type: "block_actions",
    api_app_id: scope.appId,
    team: { id: scope.teamId },
    user: { id: "U123" },
    channel: { id: scope.channelId },
    message: { ts: "1712345678.000001" },
    container: {
      type: "message",
      channel_id: scope.channelId,
      message_ts: "1712345678.000001",
      is_ephemeral: false,
    },
    actions: [
      { action_id: `workhorse-${decision}`, block_id: "workhorse-approval", value: reference },
    ],
    response_url: "https://sensitive.invalid/do-not-store-or-fetch",
  };
}

function formBody(value: unknown) {
  return new URLSearchParams({ payload: JSON.stringify(value) }).toString();
}

function signedHeaders(body: string, timestamp = Math.floor(Date.now() / 1_000).toString()) {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    "X-Slack-Request-Timestamp": timestamp,
    "X-Slack-Signature": `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`,
  };
}

async function receiver(hooks: RecipeHooks = {}) {
  const server = createSlackReceiver(pool, scope, signingSecret, hooks);
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture address");
  const url = `http://127.0.0.1:${address.port}/slack/actions`;
  return {
    url,
    send: async (value: unknown) => {
      const body = formBody(value);
      return fetch(url, { method: "POST", headers: signedHeaders(body), body });
    },
  };
}

beforeAll(async () => {
  await database.setup();
  await installRecipeSchema(pool);
});
beforeEach(async () => {
  await database.reset();
  post.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});
afterAll(() => database.teardown());

describe("signed Slack approval recipe with a real isolated database", () => {
  it("runs the credential-free installed-consumer verification path", async () => {
    expect(await verifyApprovalRecipe(database.databaseUrl)).toMatchObject({
      result: { decision: "approve" },
    });
  });
  it("registers and commits the handler's wait before posting or exposing a reference", async () => {
    const taskId = await queue.enqueue(approvalTaskType, {});
    expect(await notifyApprovals(pool, scope, post)).toBe(0);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const transaction = new Queue(client, approvalQueue);
      const claimed = await transaction.claim("uncommitted-handler");
      expect(claimed?.id).toBe(taskId);
      await transaction.waitForHuman(
        claimed!,
        "uncommitted-handler",
        approvalWaitName,
        { ...scope, prompt: "Approve?" },
        { timeoutMs: 60_000 },
      );
      expect(await notifyApprovals(pool, scope, post)).toBe(0);
      expect(post).not.toHaveBeenCalled();
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(
      await notifyApprovals(pool, scope, async (message) => {
        expect((await admin.listHumanWaits()).items).toContainEqual(
          expect.objectContaining({ taskId }),
        );
        expect(message.blocks).toHaveLength(2);
        return post(message);
      }),
    ).toBe(1);
  });

  it("runs handler, notifier, signed HTTP receiver, durable inbox and separate settlement", async () => {
    const { taskId, worker, reference } = await prompt();
    const http = await receiver();
    const started = performance.now();
    expect((await http.send(payload(reference))).status).toBe(200);
    expect(performance.now() - started).toBeLessThan(3_000);
    const accepted = await pool.query("SELECT * FROM slack_recipe.approval");
    expect(accepted.rows[0]).toMatchObject({
      decision: "approve",
      actor: "slack:T123:U123",
      settlement: null,
    });
    expect(accepted.rows[0].decision_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(accepted.rows)).not.toMatch(
      /response_url|sensitive.invalid|local-fixture-signing-secret/,
    );
    expect((await admin.listHumanWaits()).items).toHaveLength(1);
    expect(await settleDecision(pool)).toBe("completed");
    expect(await worker.runOnce()).toBe(true);
    expect(await admin.getTask(taskId)).toMatchObject({
      state: "succeeded",
      result: { decision: "approve" },
    });
    expect(await settleDecision(pool)).toBeNull();
  });

  it("never acknowledges success before the decision transaction commits", async () => {
    const { reference } = await prompt();
    const entered = gate();
    const commit = gate();
    const http = await receiver({
      beforeAcceptanceCommit: async () => {
        entered.release();
        await commit.promise;
      },
    });
    let responded = false;
    const pending = http.send(payload(reference)).then((response) => {
      responded = true;
      return response;
    });
    await entered.promise;
    const observer = new Pool({ connectionString: database.databaseUrl });
    try {
      expect(
        (await observer.query("SELECT decision FROM slack_recipe.approval")).rows[0].decision,
      ).toBeNull();
      await delay(30);
      expect(responded).toBe(false);
      commit.release();
      expect((await pending).status).toBe(200);
      expect(
        (await observer.query("SELECT decision FROM slack_recipe.approval")).rows[0].decision,
      ).toBe("approve");
    } finally {
      commit.release();
      await observer.end();
    }
  });

  it("returns failure inside Slack's deadline when acceptance cannot commit in time", async () => {
    const { reference } = await prompt();
    const entered = gate();
    const commit = gate();
    const http = await receiver({
      beforeAcceptanceCommit: async () => {
        entered.release();
        await commit.promise;
      },
    });
    const started = performance.now();
    const pending = http.send(payload(reference));
    await entered.promise;
    try {
      expect((await pending).status).toBe(503);
      expect(performance.now() - started).toBeGreaterThanOrEqual(acknowledgmentBudgetMs - 30);
      expect(performance.now() - started).toBeLessThan(3_000);
      expect(
        (await pool.query("SELECT decision FROM slack_recipe.approval")).rows[0].decision,
      ).toBeNull();
    } finally {
      commit.release();
    }
    await delay(30);
    expect(
      (await pool.query("SELECT decision FROM slack_recipe.approval")).rows[0].decision,
    ).toBeNull();
  });

  it("does not acknowledge success after a failed durable write", async () => {
    const { reference } = await prompt();
    const http = await receiver({
      beforeAcceptanceCommit: async () => {
        throw new Error("commit unavailable");
      },
    });
    expect((await http.send(payload(reference))).status).toBe(503);
    expect(
      (await pool.query("SELECT decision FROM slack_recipe.approval")).rows[0].decision,
    ).toBeNull();
    expect(await settleDecision(pool)).toBeNull();
  });

  it("bounds row-lock contention without promising interactive redelivery", async () => {
    const { reference } = await prompt();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT * FROM slack_recipe.approval FOR UPDATE");
      const http = await receiver();
      const started = performance.now();
      expect((await http.send(payload(reference))).status).toBe(503);
      expect(performance.now() - started).toBeLessThan(3_000);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(
      (await pool.query("SELECT decision FROM slack_recipe.approval")).rows[0].decision,
    ).toBeNull();
  });

  it.each([
    [
      "user",
      (value: ReturnType<typeof payload>) => {
        value.user.id = "U999";
      },
    ],
    [
      "workspace",
      (value: ReturnType<typeof payload>) => {
        value.team.id = "T999";
      },
    ],
    [
      "application",
      (value: ReturnType<typeof payload>) => {
        value.api_app_id = "A999";
      },
    ],
    [
      "channel",
      (value: ReturnType<typeof payload>) => {
        value.channel.id = "C999";
        value.container.channel_id = "C999";
      },
    ],
    [
      "message",
      (value: ReturnType<typeof payload>) => {
        value.message.ts = "1712345678.000999";
        value.container.message_ts = value.message.ts;
      },
    ],
    [
      "opaque reference",
      (value: ReturnType<typeof payload>) => {
        value.actions[0]!.value = "f".repeat(64);
      },
    ],
  ])("rejects an authenticated but unauthorized %s binding", async (_name, mutate) => {
    const { reference } = await prompt();
    const value = payload(reference);
    mutate(value);
    const http = await receiver();
    expect((await http.send(value)).status).toBe(403);
    expect(
      (await pool.query("SELECT decision FROM slack_recipe.approval")).rows[0].decision,
    ).toBeNull();
  });

  it("keeps the registered user's authorization, not merely the current workspace allowlist", async () => {
    const { reference } = await prompt();
    await pool.query("UPDATE slack_recipe.approval SET authorized_users=ARRAY['U456']");
    const http = await receiver();
    expect((await http.send(payload(reference))).status).toBe(403);
  });

  it("honors current allowlist revocation", async () => {
    const { reference } = await prompt();
    const server = createSlackReceiver(
      pool,
      { ...scope, authorizedUsers: ["U456"] },
      signingSecret,
    );
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as { port: number };
    const body = formBody(payload(reference));
    expect(
      (
        await fetch(`http://127.0.0.1:${address.port}/slack/actions`, {
          method: "POST",
          headers: signedHeaders(body),
          body,
        })
      ).status,
    ).toBe(403);
  });

  it.each(["signature", "tampered raw body", "old timestamp", "future timestamp"])(
    "rejects %s before application acceptance",
    async (fault) => {
      const { reference } = await prompt();
      const http = await receiver();
      let body = formBody(payload(reference));
      const timestamp =
        Math.floor(Date.now() / 1_000) +
        (fault === "old timestamp" ? -301 : fault === "future timestamp" ? 301 : 0);
      const headers = signedHeaders(body, timestamp.toString());
      if (fault === "signature") headers["X-Slack-Signature"] = `v0=${"0".repeat(64)}`;
      if (fault === "tampered raw body") body += "&extra=changed";
      expect((await fetch(http.url, { method: "POST", headers, body })).status).toBe(401);
      expect(
        (await pool.query("SELECT decision FROM slack_recipe.approval")).rows[0].decision,
      ).toBeNull();
    },
  );

  it("validates signature format, body bytes and replay bounds with the actual verifier", () => {
    const body = "payload=%7B%7D";
    const now = 1_712_345_678_000;
    const headers = signedHeaders(body, "1712345678");
    expect(
      verifySlackSignature(
        Buffer.from(body),
        "1712345678",
        headers["X-Slack-Signature"],
        signingSecret,
        now,
      ),
    ).toBe(true);
    for (const signature of [undefined, "v0=00", `v1=${"0".repeat(64)}`, `v0=${"G".repeat(64)}`]) {
      expect(
        verifySlackSignature(Buffer.from(body), "1712345678", signature, signingSecret, now),
      ).toBe(false);
    }
    expect(
      verifySlackSignature(
        Buffer.from(body),
        "NaN",
        headers["X-Slack-Signature"],
        signingSecret,
        now,
      ),
    ).toBe(false);
    expect(
      verifySlackSignature(Buffer.from(body), "1712345678", headers["X-Slack-Signature"], "", now),
    ).toBe(false);
  });

  it("rejects malformed, oversized and unsupported requests without storing response URLs", async () => {
    const http = await receiver();
    expect((await fetch(http.url)).status).toBe(404);
    expect(
      (
        await fetch(http.url, {
          method: "POST",
          body: "{}",
          headers: { "Content-Type": "application/json" },
        })
      ).status,
    ).toBe(415);
    for (const body of ["payload=not-json", "payload=null", "payload=%7B%7D&payload=%7B%7D"]) {
      expect(
        (await fetch(http.url, { method: "POST", body, headers: signedHeaders(body) })).status,
      ).toBe(400);
    }
    const body = "x".repeat(16_385);
    expect(
      (await fetch(http.url, { method: "POST", body, headers: signedHeaders(body) })).status,
    ).toBe(413);
    const value = payload("a".repeat(64));
    value.container.is_ephemeral = true;
    expect((await http.send(value)).status).toBe(400);
    expect(
      (await http.send({ ...payload("a".repeat(64)), is_enterprise_install: true })).status,
    ).toBe(400);
  });

  it("deduplicates clicks and refuses a different decision or actor after first acceptance", async () => {
    const { reference } = await prompt();
    const http = await receiver();
    const value = payload(reference);
    expect((await http.send(value)).status).toBe(200);
    const key = (await pool.query("SELECT decision_key FROM slack_recipe.approval")).rows[0]
      .decision_key;
    expect((await http.send(value)).status).toBe(200);
    expect((await http.send(payload(reference, "reject"))).status).toBe(409);
    value.user.id = "U456";
    expect((await http.send(value)).status).toBe(409);
    expect(
      (await pool.query("SELECT decision_key FROM slack_recipe.approval")).rows[0].decision_key,
    ).toBe(key);
  });

  it("serializes simultaneous approve/reject clicks into one durable decision", async () => {
    const { reference } = await prompt();
    const http = await receiver();
    const statuses = await Promise.all([
      http.send(payload(reference)),
      http.send(payload(reference, "reject")),
    ]);
    expect(statuses.map((response) => response.status).toSorted()).toEqual([200, 409]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM slack_recipe.approval WHERE decision IS NOT NULL",
        )
      ).rows[0].count,
    ).toBe(1);
    expect(await settleDecision(pool)).toBe("completed");
  });

  it.each(["expired", "canceled", "stale generation", "already completed"])(
    "rejects a first click on an %s wait",
    async (state) => {
      const { reference, taskId } = await prompt();
      if (state === "expired")
        await pool.query(
          "UPDATE slack_recipe.approval SET expires_at=clock_timestamp()-interval '1 second'",
        );
      if (state === "canceled") await queue.cancel(taskId);
      if (state === "stale generation")
        await pool.query("UPDATE slack_recipe.approval SET attempt=attempt+1");
      if (state === "already completed")
        await queue.completeHumanWait(
          taskId,
          approvalWaitName,
          { decision: "reject" },
          { idempotencyKey: "other", requestedBy: "other-operator" },
        );
      const http = await receiver();
      expect((await http.send(payload(reference))).status).toBe(410);
      expect(
        (await pool.query("SELECT decision FROM slack_recipe.approval")).rows[0].decision,
      ).toBeNull();
    },
  );

  it("refuses an actually timed-out Workhorse wait, independently of reference expiry", async () => {
    const taskId = await queue.enqueue(approvalTaskType, {});
    const claimed = await queue.claim("short-wait");
    await queue.waitForHuman(
      claimed!,
      "short-wait",
      approvalWaitName,
      { ...scope, prompt: "Approve?" },
      { timeoutMs: 60_000 },
    );
    expect(await notifyApprovals(pool, scope, post)).toBe(1);
    const reference = (await pool.query("SELECT reference FROM slack_recipe.approval")).rows[0]
      .reference;
    await pool.query(
      "UPDATE slack_recipe.approval SET expires_at=clock_timestamp()+interval '1 hour'",
    );
    await pool.query(
      "UPDATE workhorse.task_runtime SET deadline_at=clock_timestamp()-interval '1 second' WHERE task_id=$1",
      [taskId],
    );
    const http = await receiver();
    expect((await http.send(payload(reference))).status).toBe(410);
    expect((await admin.listHumanWaits()).items[0]?.deadlineAt.getTime()).toBeLessThan(Date.now());
    expect(await admin.getTask(taskId)).toMatchObject({ state: "scheduled" });
  });

  it("recovers posting-before-reference-persistence with a new prompt and rejects the orphan", async () => {
    await register();
    let orphanReference = "";
    const external = vi.fn<PostMessage>(async (message) => {
      const actions = message.blocks[1] as { elements: { value: string }[] };
      orphanReference = actions.elements[0]!.value;
      return post(message);
    });
    await expect(
      notifyApprovals(pool, scope, external, {
        afterPost: async () => {
          throw new Error("process died after Slack success");
        },
      }),
    ).rejects.toThrow("process died");
    expect((await pool.query("SELECT * FROM slack_recipe.approval")).rows).toEqual([]);
    const http = await receiver();
    expect((await http.send(payload(orphanReference))).status).toBe(403);
    expect(await notifyApprovals(pool, scope, post)).toBe(1);
    expect(post).toHaveBeenCalledTimes(2);
    const reference = (await pool.query("SELECT reference FROM slack_recipe.approval")).rows[0]
      .reference;
    expect(reference).not.toBe(orphanReference);
    expect((await http.send(payload(reference))).status).toBe(200);
    expect(await settleDecision(pool)).toBe("completed");
  });

  it("serializes notifier processes without treating outbound effects as exactly once", async () => {
    await register();
    const results = await Promise.all([
      notifyApprovals(pool, scope, post),
      notifyApprovals(pool, scope, post),
    ]);
    expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(await notifyApprovals(pool, scope, post)).toBe(0);
  });

  it("recovers a durable decision after receiver loss and before settlement", async () => {
    const { taskId, worker, reference } = await prompt();
    const http = await receiver();
    expect((await http.send(payload(reference, "reject"))).status).toBe(200);
    const durable = (await pool.query("SELECT decision_key, actor FROM slack_recipe.approval"))
      .rows[0];
    expect((await admin.listHumanWaits()).items).toHaveLength(1);
    const recoveredPool = new Pool({ connectionString: database.databaseUrl });
    try {
      expect(await settleDecision(recoveredPool)).toBe("completed");
    } finally {
      await recoveredPool.end();
    }
    expect(await worker.runOnce()).toBe(true);
    expect(await admin.getTask(taskId)).toMatchObject({ result: { decision: "reject" } });
    expect(
      (await pool.query("SELECT decision_key, actor FROM slack_recipe.approval")).rows[0],
    ).toEqual(durable);
    expect((await http.send(payload(reference, "reject"))).status).toBe(200);
    expect(await settleDecision(pool)).toBeNull();
  });

  it("rolls back settlement and its local receipt together after completeHumanWait", async () => {
    const { reference } = await prompt();
    const http = await receiver();
    expect((await http.send(payload(reference))).status).toBe(200);
    await expect(
      settleDecision(pool, {
        afterComplete: async () => {
          throw new Error("settler crashed");
        },
      }),
    ).rejects.toThrow("settler crashed");
    expect((await admin.listHumanWaits()).items).toHaveLength(1);
    expect(
      (await pool.query("SELECT settlement FROM slack_recipe.approval")).rows[0].settlement,
    ).toBeNull();
    expect(await settleDecision(pool)).toBe("completed");
  });

  it("preserves the registered handler scope when a differently configured worker resumes", async () => {
    const { reference, taskId } = await prompt();
    const http = await receiver();
    expect((await http.send(payload(reference))).status).toBe(200);
    expect(await settleDecision(pool)).toBe("completed");
    const restarted = createApprovalWorker(pool, { ...scope, authorizedUsers: ["U456"] });
    expect(await restarted.runOnce()).toBe(true);
    expect(await admin.getTask(taskId)).toMatchObject({
      state: "succeeded",
      result: { decision: "approve" },
    });
  });

  it("never applies a stored receipt to a different wait generation", async () => {
    const { reference } = await prompt();
    const http = await receiver();
    expect((await http.send(payload(reference))).status).toBe(200);
    await pool.query("UPDATE slack_recipe.approval SET attempt=attempt+1");
    expect(await settleDecision(pool)).toBe("stale");
    expect((await admin.listHumanWaits()).items).toHaveLength(1);
  });

  it("records timeout winning between durable acceptance and settlement", async () => {
    const { reference, taskId } = await prompt();
    const http = await receiver();
    expect((await http.send(payload(reference))).status).toBe(200);
    await pool.query(
      "UPDATE workhorse.task_runtime SET deadline_at=clock_timestamp()-interval '1 second' WHERE task_id=$1",
      [taskId],
    );
    expect(await settleDecision(pool)).toBe("stale");
    expect(
      (await pool.query("SELECT decision, settlement FROM slack_recipe.approval")).rows[0],
    ).toEqual({ decision: "approve", settlement: "stale" });
  });

  it("records a cancellation after acceptance without claiming the task was approved", async () => {
    const { reference, taskId } = await prompt();
    const http = await receiver();
    expect((await http.send(payload(reference))).status).toBe(200);
    await queue.cancel(taskId);
    expect(await settleDecision(pool)).toBe("stale");
    expect(await admin.getTask(taskId)).toMatchObject({ state: "canceled" });
  });

  it("preserves Workhorse authority when a different operator completes before settlement", async () => {
    const { reference, taskId } = await prompt();
    const http = await receiver();
    expect((await http.send(payload(reference))).status).toBe(200);
    await queue.completeHumanWait(
      taskId,
      approvalWaitName,
      { decision: "reject" },
      { idempotencyKey: "operator", requestedBy: "other-operator" },
    );
    expect(await settleDecision(pool)).toBe("already_completed");
    expect(
      await queue.completeHumanWait(
        taskId,
        approvalWaitName,
        { decision: "approve" },
        { idempotencyKey: "probe", requestedBy: "probe" },
      ),
    ).toMatchObject({
      status: "already_completed",
      payload: { decision: "reject" },
      completedBy: "other-operator",
    });
  });

  it("accepts an inbox replay if Workhorse already retained the same decision key and actor", async () => {
    const { reference, taskId } = await prompt();
    const http = await receiver();
    expect((await http.send(payload(reference))).status).toBe(200);
    const row = (await pool.query("SELECT decision_key, actor FROM slack_recipe.approval")).rows[0];
    await queue.completeHumanWait(
      taskId,
      approvalWaitName,
      { decision: "approve" },
      { idempotencyKey: row.decision_key, requestedBy: row.actor },
    );
    expect(await settleDecision(pool)).toBe("duplicate");
  });

  it("uses a fixed Slack endpoint and never follows a sensitive response URL", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, channel: "C123", ts: "1712345678.000001" })),
      );
    expect(
      await slackPoster("local-fixture-bot-token")({
        channel: "C123",
        text: "Approve?",
        blocks: [],
      }),
    ).toEqual({ channel: "C123", ts: "1712345678.000001" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({ Authorization: "Bearer local-fixture-bot-token" }),
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "invalid_auth" })),
    );
    await expect(
      slackPoster("local-fixture-bot-token")({ channel: "C123", text: "Approve?", blocks: [] }),
    ).rejects.toThrow("Slack rejected");
    fetchMock.mockResolvedValueOnce(
      new Response("", { status: 429, headers: { "Retry-After": "7" } }),
    );
    await expect(
      slackPoster("local-fixture-bot-token")({ channel: "C123", text: "Approve?", blocks: [] }),
    ).rejects.toMatchObject({ retryAfterMs: 7_000 });
    expect(new SlackRateLimitError(1_000).message).not.toContain("local-fixture-bot-token");
    expect(() => slackPoster("")).toThrow("SLACK_BOT_TOKEN");
    expect(() => validateScope({ ...scope, authorizedUsers: [] })).toThrow("allowlist");
  });
});
