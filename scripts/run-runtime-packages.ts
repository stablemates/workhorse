import { runtimePackages } from "./package-metadata.js";
import { runCommand } from "./run-command.js";

type RuntimeCommand = "build" | "build:dev" | "typecheck";

async function run(command: RuntimeCommand): Promise<void> {
  if (command === "build:dev") {
    const dashboard = runtimePackages.find(({ name }) => name === "@workhorse/dashboard");
    if (!dashboard) throw new Error("The runtime package list must include @workhorse/dashboard");
    await runCommand("pnpm", ["--filter", dashboard.name, "build:library"]);

    const adapters = runtimePackages.filter(({ name }) => name !== dashboard.name);
    await runCommand("pnpm", adapters.flatMap(({ name }) => ["--filter", name]).concat("build"));
    return;
  }

  await runCommand(
    "pnpm",
    runtimePackages.flatMap(({ name }) => ["--filter", name]).concat(command),
  );
}

const command = process.argv[2];
if (command !== "build" && command !== "build:dev" && command !== "typecheck") {
  throw new Error("Usage: run-runtime-packages.ts <build|build:dev|typecheck>");
}
await run(command);
