import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { assertSchemaCompatible, Queue, Worker } from "@workhorse-js/core";
import { Pool } from "pg";

const PARENT_QUEUE = "agentic-flow";
const TOOL_QUEUE = "agentic-tools";
const POLICY_NAMESPACE = "agentic-flow-example";

const progressOrder = new Map([
  ["planned", 1],
  ["tools-complete", 2],
  ["awaiting-approval", 3],
  ["finalizing", 4],
]);

async function reportProgress(context, stage) {
  const current = await context.getProgress();
  const currentOrder = progressOrder.get(current?.value?.stage) ?? 0;
  const nextOrder = progressOrder.get(stage);
  if (nextOrder === undefined) throw new Error(`Unknown progress stage ${stage}`);
  if (currentOrder >= nextOrder) return;
  await context.setProgress({ stage });
}

function defaultEffects() {
  return {
    async callModel({ phase, prompt, tools, idempotencyKey }) {
      if (phase === "plan") {
        return {
          idempotencyKey,
          steps: ["research the request", "calculate supporting evidence"],
        };
      }
      return {
        idempotencyKey,
        text: `Approved answer for ${prompt}: ${tools.research.summary}; total=${tools.calculate.total}`,
      };
    },
    async callTool({ tool, input, idempotencyKey }) {
      if (tool === "research") {
        return { idempotencyKey, summary: `durable context for ${input}` };
      }
      return { idempotencyKey, total: input.length };
    },
  };
}

export function createAgenticWorkers(queue, effects = defaultEffects(), cooldownMs = 10) {
  const parent = new Worker(queue, {
    queue: PARENT_QUEUE,
    workerId: "agentic-flow-parent",
    pollMs: 1,
  }).handle("agent.loop", async (payload, context) => {
    const plan = await context.checkpoint("plan", () =>
      effects.callModel({
        phase: "plan",
        prompt: payload.prompt,
        idempotencyKey: `${context.job.id}:plan`,
      }),
    );
    await reportProgress(context, "planned");

    const toolResults = await context.runChildren([
      {
        name: "research",
        type: "agent.tool",
        payload: { tool: "research", input: payload.prompt },
        options: { queue: TOOL_QUEUE, concurrencyKey: payload.conversationId },
      },
      {
        name: "calculate",
        type: "agent.tool",
        payload: { tool: "calculate", input: payload.prompt },
        options: { queue: TOOL_QUEUE, concurrencyKey: payload.conversationId },
      },
    ]);
    await reportProgress(context, "tools-complete");

    await context.sleep("model-cooldown", cooldownMs);
    await reportProgress(context, "awaiting-approval");
    const approval = await context.waitForSignal("approval");
    if (approval.approved !== true) return { status: "rejected", plan, tools: toolResults };

    await reportProgress(context, "finalizing");
    const response = await context.checkpoint("final-response", () =>
      effects.callModel({
        phase: "answer",
        prompt: payload.prompt,
        tools: toolResults,
        idempotencyKey: `${context.job.id}:final-response`,
      }),
    );
    return { status: "completed", plan, tools: toolResults, response };
  });

  const toolWorker = new Worker(queue, {
    concurrency: 2,
    queue: TOOL_QUEUE,
    workerId: "agentic-flow-tools",
    pollMs: 1,
  }).handle("agent.tool", async (payload, context) => {
    const result = await context.checkpoint("tool-call", () =>
      effects.callTool({
        ...payload,
        idempotencyKey: `${context.job.id}:tool-call`,
      }),
    );
    await reportProgress(context, "planned");
    return result;
  });

  return { parentWorker: parent, toolWorker };
}

export async function runAgenticFlowExample({
  database,
  conversationId = "conversation-example",
  prompt = "Explain durable agent execution",
  cooldownMs = 10,
  effects,
}) {
  await assertSchemaCompatible(database);
  const queue = new Queue(database);
  await queue.syncRateLimitPolicies(
    POLICY_NAMESPACE,
    [
      {
        queue: TOOL_QUEUE,
        rate: { limit: 100, intervalMs: 1_000, burst: 100 },
        perKey: { limit: 10, intervalMs: 1_000, burst: 10 },
      },
    ],
    { prune: false },
  );

  const workers = createAgenticWorkers(queue, effects, cooldownMs);
  const jobId = await queue.enqueue(
    "agent.loop",
    { conversationId, prompt },
    {
      queue: PARENT_QUEUE,
      idempotency: { key: `agentic-flow:${conversationId}` },
    },
  );

  let approvalDelivered = false;
  for (let pass = 0; pass < 100; pass += 1) {
    await workers.parentWorker.runOnce();
    await workers.toolWorker.runOnce();

    if (!approvalDelivered) {
      const delivery = await queue.sendSignal(
        jobId,
        "approval",
        { approved: true },
        {
          idempotencyKey: `agentic-flow:${conversationId}:approval`,
          requestedBy: "agentic-flow-example",
        },
      );
      approvalDelivered = delivery.status === "delivered" || delivery.status === "duplicate";
    }

    const snapshot = await queue.getJob(jobId);
    if (snapshot?.state === "succeeded") {
      return { jobId, result: snapshot.result, progress: snapshot.progress?.value ?? null };
    }
    if (snapshot?.state === "failed" || snapshot?.state === "canceled") {
      throw new Error(`Agentic flow finished in ${snapshot.state} state`);
    }
    await delay(20);
  }

  throw new Error(`Agentic flow ${jobId} did not finish within the bounded example loop`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const outcome = await runAgenticFlowExample({ database: pool });
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}
