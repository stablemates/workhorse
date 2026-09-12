import { setTimeout as sleep } from "node:timers/promises";
import { Admin, Pool, Queue } from "@stablemates/workhorse";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const [command, ...arguments_] = process.argv.slice(2);
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const admin = new Admin(pool);

async function eventually(description, operation, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== undefined) return result;
    } catch (error) {
      last = error;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}`, { cause: last });
}

try {
  switch (command) {
    case "enqueue": {
      const durationMs = Number(arguments_[0]);
      if (!Number.isSafeInteger(durationMs) || durationMs < 1) {
        throw new Error("enqueue requires a positive duration in milliseconds");
      }
      const queue = new Queue(pool);
      const taskId = await queue.enqueue(
        "smoke.drain",
        { durationMs },
        { queue: "kubernetes-smoke" },
      );
      process.stdout.write(`${taskId}\n`);
      break;
    }
    case "wait-active": {
      const taskId = arguments_[0];
      if (!taskId) throw new Error("wait-active requires a task id");
      const workerId = await eventually("an active worker", async () => {
        const task = await admin.getTask(taskId);
        if (task?.state !== "active") return undefined;
        const workers = await admin.listWorkers();
        return workers.find(
          (worker) => worker.activeSlots === 1 && worker.queues.includes("kubernetes-smoke"),
        )?.hostname;
      });
      process.stdout.write(`${workerId}\n`);
      break;
    }
    case "wait-state": {
      const [taskId, expected] = arguments_;
      if (!taskId || !expected) throw new Error("wait-state requires a task id and state");
      await eventually(
        `task ${taskId} to become ${expected}`,
        async () => ((await admin.getTask(taskId))?.state === expected ? true : undefined),
        120_000,
      );
      process.stdout.write(`${expected}\n`);
      break;
    }
    case "probe": {
      const [url, expectedText] = arguments_;
      const expected = Number(expectedText);
      if (!url || !Number.isSafeInteger(expected)) {
        throw new Error("probe requires a URL and expected status");
      }
      await eventually(
        `${url} to return ${expected}`,
        async () => {
          const response = await fetch(url, { redirect: "manual" });
          return response.status === expected ? true : undefined;
        },
        20_000,
      );
      process.stdout.write(`${expected}\n`);
      break;
    }
    case "dashboard": {
      const baseUrl = arguments_[0];
      if (!baseUrl) throw new Error("dashboard requires a base URL");
      await eventually("the dashboard Service", async () => {
        const protectedResponse = await fetch(`${baseUrl}/tasks`, { redirect: "manual" });
        if (
          protectedResponse.status !== 302 ||
          protectedResponse.headers.get("location") !== "/login"
        ) {
          return undefined;
        }
        const loginResponse = await fetch(`${baseUrl}/login`);
        if (!loginResponse.ok || !(await loginResponse.text()).includes("Sign in")) {
          return undefined;
        }
        return true;
      });
      process.stdout.write("protected\n");
      break;
    }
    default:
      throw new Error(`Unknown smoke client command: ${String(command)}`);
  }
} finally {
  await pool.end();
}
