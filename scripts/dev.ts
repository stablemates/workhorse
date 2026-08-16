import { spawn } from "node:child_process";

const usesProcessGroups = process.platform !== "win32";
const forceKillAfterMs = 5_000;

const publicPort = Number(process.env.PORT ?? 3000);
const dashboardDevPort = Number(process.env.WORKHORSE_DASHBOARD_DEV_PORT ?? 4173);
const mode = process.env.WORKHORSE_DEMO_MODE ?? "development";
const serverScript = mode === "production" ? "start" : "dev:server";
const workerScript = mode === "production" ? "start:worker" : "dev:worker";
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
    arguments: ["--filter", "@workhorse/demo", serverScript],
    env: {
      ...process.env,
      PORT: String(publicPort),
      WORKHORSE_DEMO_MODE: mode,
      NODE_OPTIONS: nodeOptions,
    },
  },
  {
    // Each demo worker owns a process and pool. Nothing but PostgreSQL connects it to the server.
    command: "pnpm",
    arguments: ["--filter", "@workhorse/demo", workerScript],
    env: {
      ...process.env,
      WORKHORSE_DEMO_MODE: mode,
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-one",
      WORKHORSE_DEMO_WORKER_PROFILE: "default",
      NODE_OPTIONS: nodeOptions,
    },
  },
  {
    command: "pnpm",
    arguments: ["--filter", "@workhorse/demo", workerScript],
    env: {
      ...process.env,
      WORKHORSE_DEMO_MODE: mode,
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-partner-api",
      WORKHORSE_DEMO_WORKER_PROFILE: "partner-api",
      NODE_OPTIONS: nodeOptions,
    },
  },
];

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
    arguments: ["--filter", "@workhorse/dashboard", "dev"],
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

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) killProcessTree(child, signal);
  forceKillTimer = setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) killProcessTree(child, "SIGKILL");
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
          resolve(code ?? (signal ? 1 : 0));
        });
      }),
  ),
);

if (forceKillTimer) clearTimeout(forceKillTimer);
process.exitCode = shutdownRequested ? 0 : (exitCodes.find((code) => code !== 0) ?? 0);
