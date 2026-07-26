import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const repositoryRoot = resolve(import.meta.dirname, "..");
const scratchRoot = process.env.JCODE_SCRATCH_DIR ?? tmpdir();
await mkdir(scratchRoot, { recursive: true });
const checkout = await mkdtemp(join(scratchRoot, "ironshift-demo-smoke-"));
const port = 31_000 + Math.floor(Math.random() * 1_000);
const demoDatabaseUrl =
  process.env.IRONSHIFT_DEMO_DATABASE_URL ??
  "postgresql://ironshift:ironshift@localhost:5432/ironshift_demo";
const derivedCronDatabaseUrl = new URL(demoDatabaseUrl);
derivedCronDatabaseUrl.pathname = "/postgres";
const cronDatabaseUrl = process.env.CRON_DATABASE_URL ?? derivedCronDatabaseUrl.toString();

interface CommandResult {
  code: number;
  output: string;
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv } = { cwd: repositoryRoot },
): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });
    child.once("error", reject);
    child.once("exit", (code) => resolveResult({ code: code ?? 1, output }));
  });
}

async function waitForJob(
  baseUrl: string,
  jobId: string,
  expectedState: "succeeded" | "failed",
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${baseUrl}/jobs/${jobId}`);
    if (response.ok) {
      const body = (await response.json()) as { job: Record<string, unknown> };
      if (body.job.state === expectedState) return body.job;
      if (body.job.state === "succeeded" || body.job.state === "failed") {
        throw new Error(`Job ${jobId} reached unexpected state ${String(body.job.state)}`);
      }
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

let demo: ReturnType<typeof spawn> | undefined;
let demoOutput = "";
let installed = false;
try {
  console.log(
    `JCODE_CHECKPOINT ${JSON.stringify({ message: "Exporting tracked clean checkout" })}`,
  );
  const exported = await run(
    "git",
    ["checkout-index", "--all", "--force", `--prefix=${checkout}/`],
    { cwd: repositoryRoot },
  );
  if (exported.code !== 0) throw new Error(`Failed to export checkout\n${exported.output}`);

  console.log(`JCODE_CHECKPOINT ${JSON.stringify({ message: "Installing clean checkout" })}`);
  const installResult = await run(
    "pnpm",
    ["install", "--frozen-lockfile", "--offline", "--ignore-scripts"],
    {
      cwd: checkout,
    },
  );
  if (installResult.code !== 0) {
    throw new Error(`Clean checkout install failed\n${installResult.output}`);
  }
  installed = true;

  console.log(
    `JCODE_CHECKPOINT ${JSON.stringify({ message: "Starting documented pnpm demo path" })}`,
  );
  demo = spawn("pnpm", ["demo"], {
    cwd: checkout,
    env: {
      ...process.env,
      PORT: String(port),
      IRONSHIFT_API_PORT: String(port + 1),
      DATABASE_URL: demoDatabaseUrl,
      CRON_DATABASE_URL: cronDatabaseUrl,
      IRONSHIFT_WORKER_POLL_MS: "15",
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  demo.stdout!.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    demoOutput += text;
    process.stdout.write(text);
  });
  demo.stderr!.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    demoOutput += text;
    process.stderr.write(text);
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (demo.exitCode !== null) throw new Error(`Demo exited before readiness\n${demoOutput}`);
    try {
      const response = await fetch(`${baseUrl}/api`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Startup includes a clean build, so connection refusal is expected until Hono is listening.
    }
    await sleep(100);
  }
  if (!ready) throw new Error(`Timed out waiting for demo readiness\n${demoOutput}`);

  const dashboard = await fetch(`${baseUrl}/tasks`);
  if (!dashboard.ok || !(await dashboard.text()).includes('<div id="root"></div>')) {
    throw new Error("Dashboard assets were not served from the clean checkout");
  }

  const orderResponse = await fetch(`${baseUrl}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customerEmail: "clean-checkout@example.com",
      description: "Prove the documented demo path",
    }),
  });
  if (orderResponse.status !== 202)
    throw new Error(`Order request returned ${orderResponse.status}`);
  const order = (await orderResponse.json()) as { jobId: string };
  const completedOrder = await waitForJob(baseUrl, order.jobId, "succeeded");
  if (completedOrder.state !== "succeeded") throw new Error("Order worker did not succeed");

  const retryResponse = await fetch(`${baseUrl}/demo/retries`, { method: "POST" });
  if (retryResponse.status !== 202)
    throw new Error(`Retry request returned ${retryResponse.status}`);
  const retry = (await retryResponse.json()) as { jobId: string };
  const completedRetry = await waitForJob(baseUrl, retry.jobId, "succeeded");
  if (completedRetry.currentAttempt !== 2) {
    throw new Error(`Expected retry attempt 2, received ${String(completedRetry.currentAttempt)}`);
  }

  const failureResponse = await fetch(`${baseUrl}/demo/failures`, { method: "POST" });
  if (failureResponse.status !== 202) {
    throw new Error(`Failure request returned ${failureResponse.status}`);
  }
  const failure = (await failureResponse.json()) as { jobId: string };
  const completedFailure = await waitForJob(baseUrl, failure.jobId, "failed");

  const tasksResponse = await fetch(`${baseUrl}/rpc/dashboard/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filter: "all", page: 1, pageSize: 100 }),
  });
  const tasksText = await tasksResponse.text();
  const cronResponse = await fetch(`${baseUrl}/rpc/dashboard/cron`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const cronText = await cronResponse.text();
  if (
    !tasksResponse.ok ||
    !tasksText.includes(order.jobId) ||
    !tasksText.includes(retry.jobId) ||
    !tasksText.includes(failure.jobId) ||
    !cronResponse.ok ||
    !cronText.includes("ironshift-demo")
  ) {
    throw new Error(`Dashboard readers omitted smoke data: ${tasksText}\n${cronText}`);
  }

  console.log(
    `JCODE_CHECKPOINT ${JSON.stringify({
      message: "Clean-checkout demo passed",
      dashboard: true,
      orderState: completedOrder.state,
      retryAttempt: completedRetry.currentAttempt,
      failureState: completedFailure.state,
      recurringSchedule: true,
    })}`,
  );
} finally {
  if (demo?.pid && demo.exitCode === null) {
    const exited = new Promise<void>((resolveExit) => {
      if (demo!.exitCode !== null) resolveExit();
      else demo!.once("exit", () => resolveExit());
    });
    if (process.platform === "win32") demo.kill("SIGTERM");
    else process.kill(-demo.pid, "SIGTERM");

    await Promise.race([
      exited,
      sleep(2_000).then(() => {
        if (demo?.pid && demo.exitCode === null) {
          if (process.platform === "win32") demo.kill("SIGKILL");
          else process.kill(-demo.pid, "SIGKILL");
        }
      }),
    ]);
  }
  if (installed) {
    await run("pnpm", ["db:reset:demo"], { cwd: checkout }).catch(() => undefined);
  }
  await rm(checkout, { recursive: true, force: true });
}
