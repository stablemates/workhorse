import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
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
  // The documented path resets the database, builds the workspace packages, and boots a Vite dev
  // server inside the demo. Readiness has to allow for all of it, or this test reports a timeout as
  // a product failure.
  for (let attempt = 0; attempt < 1_800; attempt += 1) {
    if (demo.exitCode !== null) throw new Error(`Demo exited before readiness\n${demoOutput}`);
    try {
      const [page, api] = await Promise.all([
        fetch(`${baseUrl}/tasks`),
        fetch(`${baseUrl}/rpc/dashboard/meta`, {
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

  const dashboard = await fetch(`${baseUrl}/tasks`);
  const dashboardHtml = await dashboard.text();
  if (!dashboard.ok || !dashboardHtml.includes('<div id="root"></div>')) {
    throw new Error("Dashboard assets were not served from the clean checkout");
  }
  // Development compiles the dashboard from source in the demo's own process, so one origin serves
  // the hot-reloading UI, its modules, and the API. The HTML still comes from `createDashboardHost`,
  // which is what keeps development on the same code path a published consumer runs.
  if (!dashboardHtml.includes("window.workhorseDashboard=")) {
    throw new Error("Demo did not render dashboard HTML through the packaged host");
  }
  // Development compiles the dashboard from source, so building the production browser bundle would
  // be wasted work on every start. This guards the regression directly, because the only symptom is
  // a slower startup and a misleading "building client environment for production" line.
  if (demoOutput.includes("building client environment for production")) {
    throw new Error("The development demo unexpectedly built a production dashboard bundle");
  }
  for (const token of ["/@vite/client", "/src/browser.tsx"]) {
    if (!dashboardHtml.includes(token)) {
      throw new Error(`Development dashboard HTML omitted ${token}`);
    }
  }
  const moduleSource = await fetch(`${baseUrl}/src/browser.tsx`);
  const moduleText = await moduleSource.text();
  if (!moduleSource.ok || !moduleText.includes("createRoot")) {
    throw new Error("Dashboard source modules were not served from the demo's own origin");
  }

  const tasksResponse = await fetch(`${baseUrl}/rpc/dashboard/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ json: { filter: "all", page: 1, pageSize: 100 } }),
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

  // The demo runs its workers as a dedicated process that shares nothing with this server but
  // PostgreSQL. The only way the dashboard can report them is the durable worker registry, so a
  // registered, non-zero-capacity fleet here proves the split topology actually works end to end.
  let workersText = "";
  let registeredWorkers = false;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const workersResponse = await fetch(`${baseUrl}/rpc/dashboard/workers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    workersText = await workersResponse.text();
    if (workersResponse.ok && workersText.includes('"registered":true')) {
      registeredWorkers = true;
      break;
    }
    await sleep(250);
  }
  if (!registeredWorkers) {
    throw new Error(`Out-of-process demo workers never registered: ${workersText}`);
  }

  console.log(
    `JCODE_CHECKPOINT ${JSON.stringify({
      message: "Clean-checkout demo passed",
      outOfProcessWorkersRegistered: true,
      dashboard: true,
      singleOriginHotReload: true,
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
