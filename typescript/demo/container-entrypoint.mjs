import { spawn } from "node:child_process";

async function prepareSchema() {
  const child = spawn(process.execPath, ["dist/prepare-schema.js"], {
    env: process.env,
    stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
  if (code !== 0) throw new Error(`Demo schema preparation exited with code ${code}`);
}

try {
  await prepareSchema();
} catch (error) {
  console.error("Could not prepare the demo schema", error);
  process.exitCode = 1;
}

if (process.exitCode) process.exit();

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
