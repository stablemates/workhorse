import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const action = process.argv[2];
if (action !== "add" && action !== "remove") {
  throw new Error("Usage: signoz-portless.ts <add|remove>");
}

const args = action === "add" ? ["alias", "signoz", "3301"] : ["alias", "--remove", "signoz"];

const child = spawn("portless", args, {
  env: {
    ...process.env,
    PORTLESS_PORT: process.env.PORTLESS_PORT ?? "43155",
    PORTLESS_HTTPS: process.env.PORTLESS_HTTPS ?? "0",
    PORTLESS_STATE_DIR: process.env.PORTLESS_STATE_DIR ?? join(homedir(), ".portless-workhorse"),
  },
  stdio: "inherit",
});

const exitCode = await new Promise<number | null>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
process.exitCode = exitCode ?? 1;
