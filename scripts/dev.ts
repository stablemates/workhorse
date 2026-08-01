import { spawn } from "node:child_process";

const usesProcessGroups = process.platform !== "win32";
const forceKillAfterMs = 5_000;

const commands = [["pnpm", ["--filter", "@workhorse/demo", "dev"]]] as const;
const children = commands.map(([command, arguments_]) =>
  spawn(command, arguments_, {
    detached: usesProcessGroups,
    env: process.env,
    stdio: "inherit",
  }),
);

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
