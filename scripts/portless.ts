import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const child = spawn("portless", [], {
  env: {
    ...process.env,
    PORTLESS_PORT: process.env.PORTLESS_PORT ?? "43155",
    PORTLESS_HTTPS: process.env.PORTLESS_HTTPS ?? "0",
    PORTLESS_STATE_DIR: process.env.PORTLESS_STATE_DIR ?? join(homedir(), ".portless-workhorse"),
  },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}

const exitCode = await new Promise<number | null>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
process.exitCode = exitCode ?? 1;
