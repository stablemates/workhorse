import { spawn } from "node:child_process";

const usesProcessGroups = process.platform !== "win32";
const forceKillAfterMs = 5_000;
// How long a process group may outlive the force kill before the supervisor stops waiting for it.
const processGroupGiveUpAfterMs = 1_000;
const processGroupPollMs = 25;

const publicPort = Number(process.env.PORT ?? 3000);
const dashboardDevPort = Number(process.env.WORKHORSE_DASHBOARD_DEV_PORT ?? 4173);
const mode = process.env.WORKHORSE_DEMO_MODE ?? "development";
const serverScript = mode === "production" ? "start" : "dev:server";
const typescriptWorkerScript = mode === "production" ? "start:worker" : "dev:worker";
// `workhorse-source` rather than the conventional `development`: bundlers apply `development`
// on their own, so a published package that named it would send a consumer's dev server to a
// `src/` directory the tarball does not contain. Only this repository asks for this condition.
const nodeOptions = [
  process.env.NODE_OPTIONS,
  ...(mode === "development" ? ["--conditions=workhorse-source"] : []),
]
  .filter((option): option is string => option !== undefined)
  .join(" ");
const commands: Array<{
  command: string;
  arguments: string[];
  env: NodeJS.ProcessEnv;
}> = [
  {
    command: "pnpm",
    arguments: ["--filter", "@stablemates/workhorse-demo", serverScript],
    env: {
      ...process.env,
      PORT: String(publicPort),
      WORKHORSE_DEMO_MODE: mode,
      NODE_OPTIONS: nodeOptions,
    },
  },
  {
    // Each demo worker owns a process and database client. PostgreSQL is their only shared state.
    command: "pnpm",
    arguments: ["--filter", "@stablemates/workhorse-demo", typescriptWorkerScript],
    env: {
      ...process.env,
      WORKHORSE_DEMO_MODE: mode,
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-typescript",
      NODE_OPTIONS: nodeOptions,
    },
  },
  {
    command: "uv",
    arguments: ["run", "--project", "python", "python/examples/demo_worker.py"],
    env: {
      ...process.env,
      WORKHORSE_DEMO_MODE: mode,
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-python",
    },
  },
  {
    command: "go",
    arguments: ["-C", "go", "run", "./examples/demo-worker"],
    env: {
      ...process.env,
      WORKHORSE_DEMO_MODE: mode,
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-go",
    },
  },
  {
    command: "cargo",
    arguments: ["run", "--quiet", "-p", "workhorse-demo-worker"],
    env: {
      ...process.env,
      WORKHORSE_DEMO_MODE: mode,
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-rust",
    },
  },
];

if (process.env.DATABASE_URL_SECONDARY) {
  commands.push({
    command: "pnpm",
    arguments: ["--filter", "@stablemates/workhorse-demo", typescriptWorkerScript],
    env: {
      ...process.env,
      DATABASE_URL_PRIMARY: process.env.DATABASE_URL_SECONDARY,
      WORKHORSE_DEMO_WORKSPACE: "staging",
      WORKHORSE_DEMO_MODE: mode,
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-staging",
      NODE_OPTIONS: nodeOptions,
    },
  });
}

/**
 * Optionally run the dashboard's own UI harness alongside the demo.
 *
 * The demo always serves the packaged bundle on the public port, so this adds a second view rather
 * than replacing the one a consumer would get. It is opt-in because someone looking at the demo
 * should not pay for a Vite dev server, and because two URLs for the same dashboard is a cost worth
 * choosing deliberately.
 */
if (mode === "development" && process.env.WORKHORSE_DEMO_DASHBOARD_DEV === "true") {
  commands.push({
    command: "pnpm",
    arguments: ["--filter", "@stablemates/workhorse-dashboard", "dev"],
    env: {
      ...process.env,
      PORT: String(dashboardDevPort),
      WORKHORSE_DASHBOARD_API: `http://127.0.0.1:${publicPort}`,
      // Match what the demo itself records, so the same action is attributed identically
      // regardless of which of the two views an operator used.
      WORKHORSE_DASHBOARD_ACTOR: "local-demo",
      NODE_OPTIONS: nodeOptions,
    },
  });
}

const children = commands.map(({ command, arguments: arguments_, env }) =>
  spawn(command, arguments_, {
    detached: usesProcessGroups,
    env,
    stdio: "inherit",
  }),
);

console.log(
  process.env.PORTLESS_URL
    ? `Workhorse demo development environment available at ${process.env.PORTLESS_URL}`
    : `Workhorse demo development environment available at http://localhost:${publicPort}`,
);
if (process.env.WORKHORSE_DEMO_DASHBOARD_DEV === "true") {
  console.log(
    `Dashboard UI harness (source, hot reload) at http://localhost:${dashboardDevPort}; the demo above still serves the packaged bundle`,
  );
}

let stopping = false;
let shutdownRequested = false;
let stoppedAt = 0;
let processGroupsLeftRunning = false;
let forceKillTimer: NodeJS.Timeout | undefined;

function killProcessTree(child: (typeof children)[number], signal: NodeJS.Signals): void {
  if (usesProcessGroups && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between the liveness check and the signal.
    }
  }
  child.kill(signal);
}

/**
 * Whether any process is still in the child's process group, including one not yet reaped.
 *
 * A command's own exit does not end its descendants. They share its process group, so the group
 * outlives the command until the last of them is reaped.
 */
function processGroupExists(child: (typeof children)[number]): boolean {
  if (!usesProcessGroups || !child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessGroup(child: (typeof children)[number]): Promise<void> {
  const deadline = stoppedAt + forceKillAfterMs + processGroupGiveUpAfterMs;
  while (processGroupExists(child)) {
    if (Date.now() >= deadline) {
      processGroupsLeftRunning = true;
      console.error(`Process group ${child.pid} still has running processes after SIGKILL`);
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, processGroupPollMs);
    });
  }
}

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  stoppedAt = Date.now();
  for (const child of children) killProcessTree(child, signal);
  forceKillTimer = setTimeout(() => {
    for (const child of children) {
      const running = child.exitCode === null && child.signalCode === null;
      if (running || processGroupExists(child)) killProcessTree(child, "SIGKILL");
    }
  }, forceKillAfterMs);
  forceKillTimer.unref();
}

process.on("SIGINT", () => {
  shutdownRequested = true;
  stop("SIGINT");
});
process.on("SIGTERM", () => {
  shutdownRequested = true;
  stop("SIGTERM");
});

const exitCodes = await Promise.all(
  children.map(
    (child) =>
      new Promise<number>((resolve) => {
        child.once("error", (error) => {
          console.error(error);
          stop("SIGTERM");
          resolve(1);
        });
        child.once("exit", (code, signal) => {
          if (!stopping) stop("SIGTERM");
          // Report the stop only once the command's descendants have exited too.
          void waitForProcessGroup(child).then(() => resolve(code ?? (signal ? 1 : 0)));
        });
      }),
  ),
);

if (forceKillTimer) clearTimeout(forceKillTimer);
if (processGroupsLeftRunning) process.exitCode = 1;
else process.exitCode = shutdownRequested ? 0 : (exitCodes.find((code) => code !== 0) ?? 0);
