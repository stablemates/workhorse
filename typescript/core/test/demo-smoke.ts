import { randomUUID } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fullBuildOutputDirectories } from "../../../scripts/test-build-outputs.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const scratchRoot = process.env.JCODE_SCRATCH_DIR ?? tmpdir();
await mkdir(scratchRoot, { recursive: true });
const checkout = await mkdtemp(join(scratchRoot, "workhorse-demo-smoke-"));
const port = 31_000 + Math.floor(Math.random() * 1_000);
const demoDatabaseUrl =
  process.env.DATABASE_URL_PRIMARY ??
  "postgresql://workhorse:workhorse@localhost:5432/workhorse_dev_primary";
const reuseBuild = process.argv.includes("--reuse-build");
// The demo supervisor starts each worker in its own process group, so a signal to the demo's group
// does not reach them. Every process the demo starts inherits this token, which lets the teardown
// find them all and wait for them before it removes the checkout.
const demoProcessToken = randomUUID();
// The supervisor force-kills its workers after 5 s and waits 1 s more for their process groups.
const demoStopTimeoutMs = 10_000;
const demoKillTimeoutMs = 5_000;

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
let passed = false;

/**
 * The live processes that carry this run's exact token.
 *
 * Other checkouts on the same host run processes with the same names, so the token is the only
 * selector. Only Linux exposes process environments in `/proc`. On other platforms this list is
 * empty, and the teardown waits only for the demo's own process group.
 */
async function demoProcesses(): Promise<number[]> {
  if (process.platform !== "linux") return [];
  const marker = `WORKHORSE_DEMO_SMOKE_TOKEN=${demoProcessToken}`;
  const pids: number[] = [];
  for (const entry of await readdir("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    const environment = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
    if (environment.split("\0").includes(marker)) pids.push(pid);
  }
  return pids;
}

async function describeProcess(pid: number): Promise<string> {
  const commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
  // The process group is the fifth field of `stat`, after the command name in parentheses.
  const status = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  const group = status.slice(status.lastIndexOf(")") + 2).split(" ")[2] ?? "?";
  const command = commandLine.split("\0").join(" ").trim() || "(exited)";
  return `pid=${pid} pgid=${group} command=${command}`;
}

function demoGroupExists(pid: number): boolean {
  if (process.platform === "win32") return demo!.exitCode === null && demo!.signalCode === null;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalDemo(pid: number, signal: NodeJS.Signals, others: number[]): void {
  for (const target of process.platform === "win32" ? [] : [-pid, ...others]) {
    try {
      process.kill(target, signal);
    } catch {
      // The process exited after the last check.
    }
  }
  if (process.platform === "win32") demo!.kill(signal);
}

/** Wait until the demo's process group and every process with this run's token have exited. */
async function waitForDemoExit(pid: number, timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const running = await demoProcesses();
    if (!demoGroupExists(pid) && running.length === 0) return [];
    if (Date.now() >= deadline) return running;
    await sleep(100);
  }
}

/**
 * Stop the demo and every process it started.
 *
 * The outer `pnpm` process exits as soon as it gets SIGTERM, but the supervisor and its workers
 * stop later. A worker that still runs can write into the checkout while the teardown removes it,
 * and a Rust worker that still compiles writes to `target/debug/deps`. Only the demo's group gets
 * SIGTERM, so the supervisor stops its workers in its usual sequence. A process that remains after
 * the timeout, for example a worker that the supervisor does not signal, gets SIGKILL.
 */
async function stopDemo(pid: number): Promise<void> {
  signalDemo(pid, "SIGTERM", []);
  let running = await waitForDemoExit(pid, demoStopTimeoutMs);
  if (running.length === 0 && !demoGroupExists(pid)) return;
  // A process can start a child after a scan, so each pass scans again and kills new processes.
  const killed = new Set<number>();
  const deadline = Date.now() + demoKillTimeoutMs;
  for (;;) {
    const found = running.filter((target) => !killed.has(target));
    const descriptions = (await Promise.all(found.map(describeProcess))).join("\n");
    if (killed.size === 0) {
      console.error(
        `Demo processes still ran ${demoStopTimeoutMs} ms after SIGTERM; sending SIGKILL to group ${pid} and:\n${descriptions}`,
      );
    } else if (found.length > 0) {
      console.error(`Demo processes started during SIGKILL; sending SIGKILL:\n${descriptions}`);
    }
    for (const target of [pid, ...found]) killed.add(target);
    signalDemo(pid, "SIGKILL", running);
    await sleep(100);
    running = await demoProcesses();
    if (running.length === 0 && !demoGroupExists(pid)) return;
    if (Date.now() >= deadline) {
      const survivors = await Promise.all(running.map(describeProcess));
      console.error(`Demo processes survived SIGKILL:\n${survivors.join("\n")}`);
      return;
    }
  }
}

try {
  console.log(
    `JCODE_CHECKPOINT ${JSON.stringify({ message: "Exporting tracked clean checkout" })}`,
  );
  if (reuseBuild) {
    const verified = await run("pnpm", ["build:check"]);
    if (verified.code !== 0)
      throw new Error(`Cannot reuse stale build artifacts\n${verified.output}`);
  }
  // Export the working sources that produced the verified build, including uncommitted edits.
  const sourceFiles = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repositoryRoot, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  for (const file of new Set(sourceFiles)) {
    await mkdir(dirname(join(checkout, file)), { recursive: true });
    await cp(join(repositoryRoot, file), join(checkout, file)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  }
  // The isolated source build uses Git's ignore rules for its source fingerprint too.
  const initialized = await run("git", ["init", "--quiet"], {
    cwd: checkout,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  });
  if (initialized.code !== 0)
    throw new Error(`Failed to initialize checkout\n${initialized.output}`);

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

  if (reuseBuild) {
    console.log(
      `JCODE_CHECKPOINT ${JSON.stringify({ message: "Copying verified build artifacts" })}`,
    );
    for (const directory of fullBuildOutputDirectories) {
      await cp(join(repositoryRoot, directory), join(checkout, directory), { recursive: true });
    }
  } else {
    console.log(`JCODE_CHECKPOINT ${JSON.stringify({ message: "Building clean checkout" })}`);
    const buildResult = await run("pnpm", ["build"], { cwd: checkout });
    if (buildResult.code !== 0)
      throw new Error(`Clean checkout build failed\n${buildResult.output}`);
  }
  const buildCheck = await run("pnpm", ["test:build-check"], { cwd: checkout });
  if (buildCheck.code !== 0)
    throw new Error(`Clean checkout build output is incomplete\n${buildCheck.output}`);

  console.log(
    `JCODE_CHECKPOINT ${JSON.stringify({ message: "Starting documented pnpm demo path" })}`,
  );
  demo = spawn("pnpm", ["demo"], {
    cwd: checkout,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL_PRIMARY: demoDatabaseUrl,
      // The smoke test asserts the documented single-workspace URLs, so a provisioned staging
      // workspace database in the ambient environment must not switch the demo into multi-workspace
      // mode here. The empty string means "not configured".
      DATABASE_URL_SECONDARY: "",
      WORKHORSE_DISABLE_PORTLESS: "1",
      WORKHORSE_WORKER_POLL_MS: "15",
      WORKHORSE_DEMO_SMOKE_TOKEN: demoProcessToken,
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
  // The clean checkout builds before this command starts. The demo now only starts its server,
  // workers, and dashboard Vite middleware, so readiness measures that path rather than compilation.
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
      // Hono is not listening yet.
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
  const themeModule = await fetch(`${baseUrl}/src/theme.tsx`);
  const themeModuleText = await themeModule.text();
  // Vite serves the runtime either as the bare specifier (react/jsx-dev-runtime) or, once its
  // dependency optimizer has pre-bundled it, as .vite/deps/react_jsx-dev-runtime.js.
  if (!themeModule.ok || !/react[/_]jsx(-dev)?-runtime/.test(themeModuleText)) {
    throw new Error("Dashboard TSX modules did not use the automatic JSX runtime");
  }

  const representativeTaskTypes = [
    "demo.retry",
    "demo.durable-timer",
    "demo.failure",
    "demo.long-running",
  ];
  const taskResults = await Promise.all(
    representativeTaskTypes.map(async (taskType) => {
      const response = await fetch(`${baseUrl}/rpc/dashboard/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: { filter: "all", taskType, page: 1, pageSize: 100 },
        }),
      });
      return { taskType, ok: response.ok, text: await response.text() };
    }),
  );
  const cronResponse = await fetch(`${baseUrl}/rpc/dashboard/cron`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const cronText = await cronResponse.text();
  if (
    taskResults.some(({ taskType, ok, text }) => !ok || !text.includes(taskType)) ||
    !cronResponse.ok ||
    !cronText.includes("workhorse-demo") ||
    !cronText.includes("demo.long-running")
  ) {
    throw new Error(
      `Dashboard readers omitted smoke data: ${JSON.stringify(taskResults)}\n${cronText}`,
    );
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

  passed = true;
  console.log(
    `JCODE_CHECKPOINT ${JSON.stringify({
      message: "Clean-checkout demo passed",
      outOfProcessWorkersRegistered: true,
      dashboard: true,
      singleOriginHotReload: true,
      representativeTasks: true,
      recurringLongRunningTask: true,
      recurringSchedule: true,
    })}`,
  );
} finally {
  // The teardown reports its own errors, so they cannot replace the result of the checks.
  if (demo?.pid) {
    await stopDemo(demo.pid).catch((error: unknown) => {
      console.error(`The teardown could not stop the demo: ${String(error)}`);
    });
  }
  if (installed) {
    await run("pnpm", ["db:reset:dev-primary"], { cwd: checkout }).catch(() => undefined);
  }
  // Node retries ENOTEMPTY and EBUSY with a linear backoff, for about 5 s in total.
  const removal = await rm(checkout, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  // A failed removal is a warning. If a check failed, its error still ends the run.
  if (removal !== undefined) {
    const result = passed ? "The demo smoke checks passed" : "The demo smoke checks failed";
    const message = `${result}, but the teardown could not remove the scratch checkout ${checkout}: ${String(removal)}`;
    console.error(process.env.GITHUB_ACTIONS === "true" ? `::warning::${message}` : message);
  }
}
