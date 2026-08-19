import { spawn } from "node:child_process";

const workerArguments = [
  "--require",
  "./telemetry.cjs",
  "node_modules/@workhorse/core/dist/src/cli/workhorse.js",
  "worker",
  "--config",
  "dist/worker.js",
];

const processes = [
  {
    name: "server",
    arguments: ["--require", "./telemetry.cjs", "dist/index.js"],
    environment: {
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-server",
    },
  },
  {
    name: "default worker",
    arguments: workerArguments,
    environment: {
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-one",
      WORKHORSE_DEMO_WORKER_PROFILE: "default",
    },
  },
  {
    name: "partner API worker",
    arguments: workerArguments,
    environment: {
      WORKHORSE_DEMO_SERVICE_NAME: "workhorse-demo-worker-partner-api",
      WORKHORSE_DEMO_WORKER_PROFILE: "partner-api",
    },
  },
];

const children = processes.map(({ name, arguments: arguments_, environment }) => ({
  name,
  child: spawn(process.execPath, arguments_, {
    env: { ...process.env, ...environment },
    stdio: "inherit",
  }),
}));

let stopping = false;
let shutdownRequested = false;
let forceKillTimer;

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
  }, 5_000);
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
