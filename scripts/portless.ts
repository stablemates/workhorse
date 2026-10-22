import { type ChildProcess, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// Portless starts the demo in its own process group, so a signal to this script's group reaches the
// demo through Portless or this forward only. This script listens before it starts the child.
// `package.json` starts it with `node --import tsx`, not the `tsx` CLI: the CLI sends SIGKILL to a
// script that does not acknowledge a signal within about 60 ms.
let child: ChildProcess | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child?.kill(signal));
}

const bypassPortless = process.env.WORKHORSE_DISABLE_PORTLESS === "1";
const started = spawn(
  bypassPortless ? "pnpm" : "portless",
  bypassPortless ? ["run", "demo:app"] : ["run", "--name", "workhorse", "pnpm", "run", "demo:app"],
  {
    env: {
      ...process.env,
      PORTLESS_PORT: process.env.PORTLESS_PORT ?? "43155",
      PORTLESS_HTTPS: process.env.PORTLESS_HTTPS ?? "0",
      PORTLESS_STATE_DIR: process.env.PORTLESS_STATE_DIR ?? join(homedir(), ".portless-workhorse"),
    },
    stdio: "inherit",
  },
);

child = started;

const exitCode = await new Promise<number | null>((resolve, reject) => {
  started.once("error", reject);
  started.once("exit", resolve);
});
process.exitCode = exitCode ?? 1;
