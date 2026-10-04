// A signed Slack approval recipe over Workhorse human waits: committed registration, durable
// acceptance of the interaction, and separate settlement.
//
// Documentation: https://workhorse.run/docs/slack-approvals

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Pool, type PoolClient } from "pg";
import {
  Admin,
  Queue,
  Worker,
  type ExternalWaitCursor,
  type HumanWait,
  type Json,
} from "@stablemates/workhorse";

export const approvalTaskType = "slack.approval";
export const approvalQueue = "slack-approvals";
export const approvalWaitName = "approval";
export const acknowledgmentBudgetMs = 2_500;
const maximumBodyBytes = 16_384;
const scanPages = 10;

export interface SlackScope {
  teamId: string;
  appId: string;
  channelId: string;
  authorizedUsers: string[];
}

type ApprovalContext = SlackScope & { prompt: string };
type PostedMessage = { channel: string; ts: string };
type PostMessage = (message: {
  channel: string;
  text: string;
  blocks: Json[];
}) => Promise<PostedMessage>;

interface ApprovalRow {
  task_id: string;
  wait_name: string;
  wait_created_at: Date;
  attempt: number;
  reference: string;
  team_id: string;
  app_id: string;
  channel_id: string;
  authorized_users: string[];
  message_ts: string;
  expires_at: Date;
  decision: "approve" | "reject" | null;
  decision_key: string | null;
  actor: string | null;
  settlement: string | null;
}

export interface RecipeHooks {
  afterPost?: () => Promise<void>;
  beforeAcceptanceCommit?: () => Promise<void>;
  afterComplete?: () => Promise<void>;
}

export function validateScope(scope: SlackScope): void {
  if (
    !/^T[A-Z0-9]{1,31}$/.test(scope.teamId) ||
    !/^A[A-Z0-9]{1,31}$/.test(scope.appId) ||
    !/^[CG][A-Z0-9]{1,31}$/.test(scope.channelId) ||
    scope.authorizedUsers.length === 0 ||
    scope.authorizedUsers.length > 100 ||
    scope.authorizedUsers.some((user) => !/^U[A-Z0-9]{1,31}$/.test(user))
  ) {
    throw new Error("Configure one Slack workspace, app, channel and explicit user allowlist");
  }
}

export function createApprovalWorker(pool: Pool, scope: SlackScope): Worker {
  validateScope(scope);
  return new Worker(new Queue(pool, approvalQueue), {
    queue: approvalQueue,
    workerId: `slack-handler-${randomUUID()}`,
  }).handle(approvalTaskType, async (_payload, context) => {
    const registeredScope = await context.checkpoint("slack-scope", async () => ({ ...scope }));
    const outcome = await context.waitForHuman(
      approvalWaitName,
      { ...registeredScope, prompt: "Approve this demonstration task?" },
      { timeoutMs: 30 * 60 * 1_000 },
    );
    return outcome;
  });
}

export async function installRecipeSchema(pool: Pool): Promise<void> {
  await pool.query(await readFile(new URL("./slack-approvals.sql", import.meta.url), "utf8"));
}

function approvalContext(
  wait: HumanWait,
  scope: SlackScope,
  constrainUsers = true,
): ApprovalContext | null {
  if (
    wait.queue !== approvalQueue ||
    wait.taskType !== approvalTaskType ||
    wait.name !== approvalWaitName
  ) {
    return null;
  }
  const context = wait.context as ApprovalContext | null;
  if (
    context === null ||
    typeof context !== "object" ||
    context.teamId !== scope.teamId ||
    context.appId !== scope.appId ||
    context.channelId !== scope.channelId ||
    typeof context.prompt !== "string" ||
    context.prompt.length > 500 ||
    !Array.isArray(context.authorizedUsers) ||
    context.authorizedUsers.length === 0 ||
    context.authorizedUsers.some(
      (user) =>
        typeof user !== "string" || (constrainUsers && !scope.authorizedUsers.includes(user)),
    )
  ) {
    return null;
  }
  return context;
}

async function committedWaits(admin: Admin): Promise<HumanWait[]> {
  const waits: HumanWait[] = [];
  let cursor: ExternalWaitCursor | undefined;
  for (let page = 0; page < scanPages; page += 1) {
    const result = await admin.listHumanWaits({ limit: 100, cursor });
    waits.push(...result.items);
    if (result.nextCursor === null) return waits;
    cursor = result.nextCursor;
  }
  throw new Error("Recipe scan bound exceeded; partition this application's wait discovery");
}

async function liveWait(client: PoolClient, row: ApprovalRow, scope: SlackScope): Promise<boolean> {
  const admin = new Admin(client);
  const waits = await committedWaits(admin);
  const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
  return waits.some(
    (wait) =>
      wait.taskId === row.task_id &&
      wait.name === row.wait_name &&
      wait.attempt === row.attempt &&
      wait.createdAt.getTime() === row.wait_created_at.getTime() &&
      wait.deadlineAt.getTime() > clock.rows[0]!.now.getTime() &&
      approvalContext(wait, scope, false) !== null,
  );
}

export async function notifyApprovals(
  pool: Pool,
  scope: SlackScope,
  post: PostMessage,
  hooks: RecipeHooks = {},
): Promise<number> {
  validateScope(scope);
  const waits = await committedWaits(new Admin(pool));
  let posted = 0;
  for (const wait of waits) {
    const context = approvalContext(wait, scope);
    if (context === null) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
        [`slack-recipe:${wait.taskId}:${wait.name}`],
      );
      if (!lock.rows[0]?.acquired) {
        await client.query("ROLLBACK");
        continue;
      }
      const existing = await client.query(
        `SELECT 1 FROM slack_recipe.approval
         WHERE task_id = $1 AND wait_name = $2 AND wait_created_at = $3 AND attempt = $4`,
        [wait.taskId, wait.name, wait.createdAt, wait.attempt],
      );
      if (existing.rowCount) {
        await client.query("ROLLBACK");
        continue;
      }
      const reference = randomBytes(32).toString("hex");
      const candidate: ApprovalRow = {
        task_id: wait.taskId,
        wait_name: wait.name,
        wait_created_at: wait.createdAt,
        attempt: wait.attempt,
        reference,
        team_id: scope.teamId,
        app_id: scope.appId,
        channel_id: scope.channelId,
        authorized_users: context.authorizedUsers,
        message_ts: "",
        expires_at: wait.deadlineAt,
        decision: null,
        decision_key: null,
        actor: null,
        settlement: null,
      };
      if (!(await liveWait(client, candidate, scope))) {
        await client.query("ROLLBACK");
        continue;
      }
      const message = await post({
        channel: scope.channelId,
        text: context.prompt,
        blocks: [
          { type: "section", text: { type: "plain_text", text: context.prompt } },
          {
            type: "actions",
            block_id: "workhorse-approval",
            elements: ["approve", "reject"].map((decision) => ({
              type: "button",
              action_id: `workhorse-${decision}`,
              value: reference,
              text: { type: "plain_text", text: decision === "approve" ? "Approve" : "Reject" },
            })),
          },
        ],
      });
      if (message.channel !== scope.channelId || !/^\d+\.\d+$/.test(message.ts)) {
        throw new Error("Slack returned an unexpected message binding");
      }
      await hooks.afterPost?.();
      await client.query(
        `INSERT INTO slack_recipe.approval
         (task_id, wait_name, wait_created_at, attempt, reference, team_id, app_id,
          channel_id, authorized_users, message_ts, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          wait.taskId,
          wait.name,
          wait.createdAt,
          wait.attempt,
          reference,
          scope.teamId,
          scope.appId,
          scope.channelId,
          context.authorizedUsers,
          message.ts,
          wait.deadlineAt,
        ],
      );
      await client.query("COMMIT");
      posted += 1;
      return posted;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return posted;
}

export function verifySlackSignature(
  rawBody: Buffer,
  timestamp: string | undefined,
  signature: string | undefined,
  signingSecret: string,
  nowMs = Date.now(),
): boolean {
  if (
    !signingSecret ||
    !timestamp ||
    !/^\d{10}$/.test(timestamp) ||
    !signature ||
    !/^v0=[0-9a-f]{64}$/.test(signature) ||
    Math.abs(nowMs / 1_000 - Number(timestamp)) > 300
  )
    return false;
  const expected = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:`)
    .update(rawBody)
    .digest("hex")}`;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

type Click = {
  reference: string;
  decision: "approve" | "reject";
  teamId: string;
  appId: string;
  channelId: string;
  messageTs: string;
  userId: string;
};

function parseClick(rawBody: Buffer): Click | null {
  const form = new URLSearchParams(rawBody.toString("utf8"));
  if (form.getAll("payload").length !== 1) return null;
  const payload = JSON.parse(form.get("payload")!) as {
    type?: string;
    api_app_id?: string;
    is_enterprise_install?: boolean;
    enterprise?: { id?: string };
    team?: { id?: string };
    user?: { id?: string };
    channel?: { id?: string };
    message?: { ts?: string };
    container?: { type?: string; is_ephemeral?: boolean; channel_id?: string; message_ts?: string };
    actions?: { block_id?: string; value?: string; action_id?: string }[];
  };
  const action = payload.actions?.[0];
  if (
    payload.type !== "block_actions" ||
    !Array.isArray(payload.actions) ||
    payload.actions.length !== 1 ||
    payload.is_enterprise_install === true ||
    payload.enterprise?.id ||
    payload.container?.type !== "message" ||
    payload.container?.is_ephemeral !== false ||
    payload.container?.channel_id !== payload.channel?.id ||
    payload.container?.message_ts !== payload.message?.ts ||
    action?.block_id !== "workhorse-approval" ||
    !/^[a-f0-9]{64}$/.test(action?.value ?? "") ||
    !["workhorse-approve", "workhorse-reject"].includes(action?.action_id ?? "")
  )
    return null;
  const click = {
    reference: action.value,
    decision: action.action_id === "workhorse-approve" ? "approve" : "reject",
    teamId: payload.team?.id,
    appId: payload.api_app_id,
    channelId: payload.channel?.id,
    messageTs: payload.message?.ts,
    userId: payload.user?.id,
  };
  if (Object.values(click).some((value) => typeof value !== "string")) return null;
  return click as Click;
}

async function acceptDecision(
  pool: Pool,
  scope: SlackScope,
  click: Click,
  deadline: number,
  hooks: RecipeHooks = {},
): Promise<number> {
  if (
    click.teamId !== scope.teamId ||
    click.appId !== scope.appId ||
    click.channelId !== scope.channelId ||
    !scope.authorizedUsers.includes(click.userId)
  )
    return 403;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '350ms'");
    await client.query("SET LOCAL lock_timeout = '100ms'");
    const result = await client.query<ApprovalRow>(
      "SELECT * FROM slack_recipe.approval WHERE reference = $1 FOR UPDATE",
      [click.reference],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.team_id !== click.teamId ||
      row.app_id !== click.appId ||
      row.channel_id !== click.channelId ||
      row.message_ts !== click.messageTs ||
      !row.authorized_users.includes(click.userId)
    ) {
      await client.query("ROLLBACK");
      return 403;
    }
    if (row.decision !== null) {
      await client.query("ROLLBACK");
      return row.decision === click.decision &&
        row.actor === `slack:${click.teamId}:${click.userId}`
        ? 200
        : 409;
    }
    const clock = await client.query<{ expired: boolean }>(
      "SELECT clock_timestamp() >= $1::timestamptz AS expired",
      [row.expires_at],
    );
    if (clock.rows[0]?.expired || !(await liveWait(client, row, scope))) {
      await client.query("ROLLBACK");
      return 410;
    }
    await client.query(
      `UPDATE slack_recipe.approval SET decision=$2, decision_key=$3, actor=$4,
       accepted_at=clock_timestamp() WHERE reference=$1`,
      [click.reference, click.decision, randomUUID(), `slack:${click.teamId}:${click.userId}`],
    );
    await hooks.beforeAcceptanceCommit?.();
    if (performance.now() >= deadline - 100) throw new Error("Acceptance deadline exhausted");
    await client.query("COMMIT");
    return 200;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function settleDecision(pool: Pool, hooks: RecipeHooks = {}): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<ApprovalRow>(
      `SELECT * FROM slack_recipe.approval WHERE decision IS NOT NULL AND settlement IS NULL
       ORDER BY accepted_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    const row = result.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    const currentWait = (await committedWaits(new Admin(client))).find(
      (wait) => wait.taskId === row.task_id && wait.name === row.wait_name,
    );
    const differentGeneration =
      currentWait &&
      (currentWait.attempt !== row.attempt ||
        currentWait.createdAt.getTime() !== row.wait_created_at.getTime());
    const completion = differentGeneration
      ? { status: "stale" }
      : await new Queue(client).completeHumanWait(
          row.task_id,
          row.wait_name,
          { decision: row.decision },
          { idempotencyKey: row.decision_key!, requestedBy: row.actor! },
        );
    await hooks.afterComplete?.();
    await client.query(
      `UPDATE slack_recipe.approval SET settlement=$2, settled_at=clock_timestamp()
       WHERE reference=$1`,
      [row.reference, completion.status],
    );
    await client.query("COMMIT");
    return completion.status;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function createSlackReceiver(
  pool: Pool,
  scope: SlackScope,
  signingSecret: string,
  hooks: RecipeHooks = {},
) {
  validateScope(scope);
  if (!signingSecret) throw new Error("SLACK_SIGNING_SECRET is required");
  return createServer((request, response) => {
    void receive(request, response, pool, scope, signingSecret, hooks);
  });
}

async function receive(
  request: IncomingMessage,
  response: ServerResponse,
  pool: Pool,
  scope: SlackScope,
  signingSecret: string,
  hooks: RecipeHooks,
): Promise<void> {
  const deadline = performance.now() + acknowledgmentBudgetMs;
  const reply = (status: number) => {
    if (!response.writableEnded && !response.destroyed) {
      response.writeHead(status, { "Cache-Control": "no-store" });
      response.end();
    }
  };
  const timeout = setTimeout(() => reply(503), acknowledgmentBudgetMs);
  try {
    if (request.method !== "POST" || request.url !== "/slack/actions") return reply(404);
    if (request.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded")
      return reply(415);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maximumBodyBytes) return reply(413);
      chunks.push(Buffer.from(chunk));
      if (response.writableEnded) return;
    }
    const rawBody = Buffer.concat(chunks);
    const timestamp = request.headers["x-slack-request-timestamp"];
    const signature = request.headers["x-slack-signature"];
    if (
      typeof timestamp !== "string" ||
      typeof signature !== "string" ||
      !verifySlackSignature(rawBody, timestamp, signature, signingSecret)
    )
      return reply(401);
    let click;
    try {
      click = parseClick(rawBody);
    } catch {
      return reply(400);
    }
    if (!click) return reply(400);
    reply(await acceptDecision(pool, scope, click, deadline, hooks));
  } catch {
    reply(503);
  } finally {
    clearTimeout(timeout);
  }
}

export class SlackRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("Slack rate limited the notifier");
    this.retryAfterMs = retryAfterMs;
  }
}

export function slackPoster(botToken: string): PostMessage {
  if (!botToken) throw new Error("SLACK_BOT_TOKEN is required only by the notifier");
  return async (message) => {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      throw new SlackRateLimitError(
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 60_000,
      );
    }
    if (!response.ok)
      throw new Error("Slack posting failed; inspect rate limits without logging credentials");
    const body = (await response.json()) as { ok?: boolean; channel?: string; ts?: string };
    if (body.ok !== true || typeof body.channel !== "string" || typeof body.ts !== "string") {
      throw new Error("Slack rejected the message");
    }
    return { channel: body.channel, ts: body.ts };
  };
}

export async function verifyApprovalRecipe(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 250 });
  const scope: SlackScope = {
    teamId: "TLOCAL",
    appId: "ALOCAL",
    channelId: "CLOCAL",
    authorizedUsers: ["ULOCAL"],
  };
  const secret = randomBytes(32).toString("hex");
  const messageTs = `${Math.floor(Date.now() / 1_000)}.000001`;
  const server = createSlackReceiver(pool, scope, secret);
  try {
    await installRecipeSchema(pool);
    const queue = new Queue(pool, approvalQueue);
    const taskId = await queue.enqueue(approvalTaskType, {});
    const worker = createApprovalWorker(pool, scope);
    if (!(await worker.runOnce()))
      throw new Error("Verification handler did not register its wait");
    await notifyApprovals(pool, scope, async () => ({ channel: scope.channelId, ts: messageTs }));
    const prompt = await pool.query<{ reference: string }>(
      "SELECT reference FROM slack_recipe.approval WHERE task_id=$1",
      [taskId],
    );
    if (!prompt.rows[0]) throw new Error("Verification notifier did not persist its reference");
    await new Promise<void>((ready) => {
      server.listen(0, "127.0.0.1", ready);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Verification receiver did not start");
    const rawBody = new URLSearchParams({
      payload: JSON.stringify({
        type: "block_actions",
        api_app_id: scope.appId,
        team: { id: scope.teamId },
        user: { id: "ULOCAL" },
        channel: { id: scope.channelId },
        message: { ts: messageTs },
        container: {
          type: "message",
          channel_id: scope.channelId,
          message_ts: messageTs,
          is_ephemeral: false,
        },
        actions: [
          {
            action_id: "workhorse-approve",
            block_id: "workhorse-approval",
            value: prompt.rows[0].reference,
          },
        ],
      }),
    }).toString();
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
    const response = await fetch(`http://127.0.0.1:${address.port}/slack/actions`, {
      method: "POST",
      body: rawBody,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature": signature,
      },
    });
    if (response.status !== 200)
      throw new Error("Verification decision was not durably acknowledged");
    if ((await settleDecision(pool)) !== "completed")
      throw new Error("Verification settlement did not complete");
    await worker.runOnce();
    const task = await new Admin(pool).getTask(taskId);
    if (task?.state !== "succeeded") throw new Error("Verification task did not resume");
    return { taskId, result: task.result };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((closed) => {
      server.close(() => closed());
    });
    await pool.end();
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--verify")) {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL must name a disposable verification database");
    console.log(JSON.stringify(await verifyApprovalRecipe(process.env.DATABASE_URL)));
    return;
  }
  const mode = process.argv[2];
  if (!process.env.DATABASE_URL_PRIMARY) throw new Error("DATABASE_URL_PRIMARY is required");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL_PRIMARY,
    max: 5,
    connectionTimeoutMillis: 250,
  });
  const scope: SlackScope = {
    teamId: process.env.SLACK_TEAM_ID ?? "",
    appId: process.env.SLACK_APP_ID ?? "",
    channelId: process.env.SLACK_CHANNEL_ID ?? "",
    authorizedUsers: (process.env.SLACK_AUTHORIZED_USERS ?? "").split(",").filter(Boolean),
  };
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  process.once("SIGTERM", () => abort.abort());
  try {
    if (mode === "schema") return await installRecipeSchema(pool);
    if (mode === "enqueue") {
      console.log(await new Queue(pool, approvalQueue).enqueue(approvalTaskType, {}));
      return;
    }
    validateScope(scope);
    if (mode === "receiver") {
      const server = createSlackReceiver(pool, scope, process.env.SLACK_SIGNING_SECRET ?? "");
      await new Promise<void>((ready) => {
        server.listen(3_010, "127.0.0.1", ready);
      });
      await new Promise<void>((stopped) => {
        abort.signal.addEventListener("abort", () => server.close(() => stopped()), { once: true });
      });
    } else if (["worker", "notifier", "decision-worker"].includes(mode ?? "")) {
      const worker = mode === "worker" ? createApprovalWorker(pool, scope) : null;
      const post = mode === "notifier" ? slackPoster(process.env.SLACK_BOT_TOKEN ?? "") : null;
      while (!abort.signal.aborted) {
        try {
          if (worker) await worker.runOnce();
          else if (post) await notifyApprovals(pool, scope, post);
          else await settleDecision(pool);
        } catch (error) {
          process.stderr.write("Recipe pass failed; retrying without logging request or secrets\n");
          if (error instanceof SlackRateLimitError) {
            await delay(error.retryAfterMs, undefined, { signal: abort.signal }).catch(
              () => undefined,
            );
          }
        }
        await delay(1_000, undefined, { signal: abort.signal }).catch(() => undefined);
      }
    } else throw new Error("Choose schema, enqueue, worker, notifier, receiver or decision-worker");
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
