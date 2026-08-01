import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const repositoryRoot = resolve(import.meta.dirname, "..");
const scratchRoot = process.env.JCODE_SCRATCH_DIR ?? tmpdir();
await mkdir(scratchRoot, { recursive: true });
const checkout = await mkdtemp(join(scratchRoot, "workhorse-demo-smoke-"));
const port = 31_000 + Math.floor(Math.random() * 1_000);
const demoDatabaseUrl =
  process.env.WORKHORSE_DEMO_DATABASE_URL ??
  "postgresql://workhorse:workhorse@localhost:5432/workhorse_demo";

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
      WORKHORSE_API_PORT: String(port + 1),
      DATABASE_URL: demoDatabaseUrl,
      WORKHORSE_DISABLE_PORTLESS: "1",
      WORKHORSE_WORKER_POLL_MS: "15",
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
      const [page, api] = await Promise.all([
        fetch(`${baseUrl}/workhorse/tasks`),
        fetch(`${baseUrl}/workhorse/rpc/dashboard/meta`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      ]);
      if (page.ok && api.ok) {
        ready = true;
        break;
      }
    } catch {
      // Startup includes a clean build, so connection refusal is expected until Hono is listening.
    }
    await sleep(100);
  }
  if (!ready) throw new Error(`Timed out waiting for demo readiness\n${demoOutput}`);

  const dashboard = await fetch(`${baseUrl}/workhorse/tasks`);
  const dashboardHtml = await dashboard.text();
  if (!dashboard.ok || !dashboardHtml.includes('<div id="root"></div>')) {
    throw new Error("Dashboard assets were not served from the clean checkout");
  }
  if (demoOutput.includes("building client environment for production")) {
    throw new Error("The development demo unexpectedly built a production dashboard bundle");
  }
  for (const token of [
    "/workhorse/@vite/client",
    "/workhorse/@react-refresh",
    "/workhorse/src/browser.tsx",
    "react-grab.ts",
  ]) {
    if (!dashboardHtml.includes(token)) {
      throw new Error(`Development dashboard HTML omitted ${token}`);
    }
  }
  if (dashboardHtml.includes("/workhorse/workhorse/") || dashboardHtml.includes("/assets/index-")) {
    throw new Error("Development dashboard HTML used an invalid or production asset path");
  }
  const reactGrabPath = dashboardHtml.match(/src="([^"]*react-grab\.ts)"/)?.[1];
  const reactGrabEntry = reactGrabPath ? await fetch(`${baseUrl}${reactGrabPath}`) : undefined;
  const reactGrabSource = reactGrabEntry ? await reactGrabEntry.text() : "";
  if (!reactGrabEntry?.ok || !reactGrabSource.includes("react-grab")) {
    throw new Error("Demo-owned React Grab source module was not transformed by Vite");
  }
  const dashboardSource = await fetch(`${baseUrl}/workhorse/src/browser.tsx`);
  const dashboardSourceText = await dashboardSource.text();
  if (
    !dashboardSource.ok ||
    !dashboardSourceText.includes("jsxDEV") ||
    !dashboardSourceText.includes("createRoot")
  ) {
    throw new Error("Dashboard source was not served with React development transforms");
  }
  const legacyDashboard = await fetch(`${baseUrl}/tasks?filter=running`, { redirect: "manual" });
  if (
    legacyDashboard.status !== 302 ||
    legacyDashboard.headers.get("location") !== "/workhorse/tasks?filter=running"
  ) {
    throw new Error("Legacy dashboard URLs do not redirect into the Workhorse namespace");
  }

  const tasksResponse = await fetch(`${baseUrl}/workhorse/rpc/dashboard/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ json: { filter: "all", page: 1, pageSize: 100 } }),
  });
  const tasksText = await tasksResponse.text();
  const cronResponse = await fetch(`${baseUrl}/workhorse/rpc/dashboard/cron`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const cronText = await cronResponse.text();
  if (
    !tasksResponse.ok ||
    !tasksText.includes("demo.retry") ||
    !tasksText.includes("demo.durable-timer") ||
    !tasksText.includes("demo.failure") ||
    !tasksText.includes("demo.long-running") ||
    !cronResponse.ok ||
    !cronText.includes("workhorse-demo") ||
    !cronText.includes("demo.long-running")
  ) {
    throw new Error(`Dashboard readers omitted smoke data: ${tasksText}\n${cronText}`);
  }

  console.log(
    `JCODE_CHECKPOINT ${JSON.stringify({
      message: "Clean-checkout demo passed",
      dashboard: true,
      reactGrab: true,
      viteDevelopmentSource: true,
      productionPrebuildSkipped: true,
      representativeJobs: true,
      recurringLongRunningTask: true,
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
