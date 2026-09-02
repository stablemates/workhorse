import { spawn } from "node:child_process";

// This entry point starts processes and installs nothing.
//
// It used to run `dist/prepare-schema.js` first, which made every container its own migrator. That
// is the one thing ADR 0053 rules out: no component migrates on start, because no component is a
// singleton. The demo runs on one node today, so the old shape was harmless — and it was the
// product's own showcase doing the opposite of what the product documents.
//
// The schema step now runs once from the deployment pipeline, in this same image, before any
// container boots. `.kamal/hooks/pre-deploy` runs it. A deployment that skips it leaves the server
// refusing to start with the message `assertSchemaCompatible` throws, which is the designed
// failure rather than a surprise.

const workerArguments = [
  "--require",
  "./telemetry.cjs",
  "node_modules/@stablemates/workhorse/dist/src/cli/workhorse.js",
  "worker",
  "--config",
  "dist/worker.js",
];

const processes = [
  {
    name: "server",
    command: process.execPath,
    arguments: ["--require", "./telemetry.cjs", "dist/index.js"],
    environment: {
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-server",
    },
  },
  {
    name: "TypeScript worker",
    command: process.execPath,
    arguments: workerArguments,
    environment: {
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-typescript",
    },
  },
  {
    name: "Python worker",
    command: "python3",
    arguments: ["/opt/workhorse-python-worker.py"],
    environment: {
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-python",
      PYTHONPATH: "/opt/workhorse-python",
    },
  },
  {
    name: "Go worker",
    command: "/usr/local/bin/workhorse-go-demo-worker",
    arguments: [],
    environment: {
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-go",
    },
  },
];

const children = processes.map(({ name, command, arguments: arguments_, environment }) => ({
  name,
  child: spawn(command, arguments_, {
    env: { ...process.env, ...environment },
    stdio: "inherit",
  }),
}));

let stopping = false;
let shutdownRequested = false;
let forceKillTimer;
const shutdownGraceMs = Number(process.env.WORKHORSE_DEMO_SHUTDOWN_GRACE_MS ?? 30_000);
if (!Number.isFinite(shutdownGraceMs) || shutdownGraceMs < 0) {
  throw new Error("WORKHORSE_DEMO_SHUTDOWN_GRACE_MS must be a non-negative number");
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
  forceKillTimer = setTimeout(() => {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, shutdownGraceMs);
  forceKillTimer.unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    shutdownRequested = true;
    stop(signal);
  });
}

const exitCodes = await Promise.all(
  children.map(
    ({ name, child }) =>
      new Promise((resolve) => {
        child.once("error", (error) => {
          console.error(`Could not start the demo ${name}`, error);
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
