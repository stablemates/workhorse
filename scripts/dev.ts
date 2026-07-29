import { spawn } from "node:child_process";

const commands = [
  ["pnpm", ["--filter", "@workhorse/demo", "dev:api"]],
  ["pnpm", ["--filter", "@workhorse/demo", "dev:dashboard"]],
] as const;
const children = commands.map(([command, arguments_]) =>
  spawn(command, arguments_, { env: process.env, stdio: "inherit" }),
);

let stopping = false;
function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

const exitCode = await new Promise<number>((resolve) => {
  for (const child of children) {
    child.once("error", (error) => {
      console.error(error);
      stop("SIGTERM");
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      if (!stopping) stop("SIGTERM");
      resolve(code ?? (signal ? 1 : 0));
    });
  }
});

process.exitCode = exitCode;
