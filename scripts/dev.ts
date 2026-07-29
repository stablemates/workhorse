import { spawn } from "node:child_process";
import { resolveInternalApiPort } from "./development-port.js";

const apiPort = await resolveInternalApiPort(process.env.WORKHORSE_API_PORT);
const childEnvironment = { ...process.env, WORKHORSE_API_PORT: String(apiPort) };

const commands = [
  ["pnpm", ["--filter", "@workhorse/demo", "dev:api"]],
  ["pnpm", ["--filter", "@workhorse/demo", "dev:dashboard"]],
] as const;
const children = commands.map(([command, arguments_]) =>
  spawn(command, arguments_, { env: childEnvironment, stdio: "inherit" }),
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
