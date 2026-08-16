import { spawn } from "node:child_process";
import { cp, readFile } from "node:fs/promises";
import path from "node:path";
import { corePackage, repositoryRoot, workspacePackages } from "./packages.js";

interface Manifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

const development = process.argv.includes("--dev");
const requestedTarget = process.argv.find((argument) =>
  ["--core", "--adapters", "--dashboard"].includes(argument),
);
const script = development ? "build:dev" : "build";

async function run(args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", [...args], { cwd: repositoryRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm ${args.join(" ")} exited with ${signal ?? String(code)}`));
    });
  });
}

async function manifestAt(location: string): Promise<Manifest> {
  return JSON.parse(
    await readFile(path.join(repositoryRoot, location, "package.json"), "utf8"),
  ) as Manifest;
}

async function buildPackage(location: string): Promise<void> {
  await run(["--dir", location, script]);
}

async function copyDashboardApplication(): Promise<void> {
  if (development) return;
  await cp(
    path.join(repositoryRoot, "dashboard/app/dist/app"),
    path.join(repositoryRoot, "typescript/dashboard-server/dist/app"),
    { recursive: true },
  );
}

const core = await corePackage();
const packages = await workspacePackages();
const manifests = new Map(
  await Promise.all(
    packages.map(async (entry) => [entry.location, await manifestAt(entry.location)] as const),
  ),
);
const packageAt = (name: string) => {
  const entry = packages.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`Missing workspace package ${name}`);
  return entry;
};
const dashboardContract = packageAt("@workhorse/dashboard-contract");
const dashboardServer = packageAt("@workhorse/dashboard-server");
const compatibilityFacades = packages.filter(
  (entry) => manifests.get(entry.location)?.dependencies?.["@workhorse/dashboard-server"],
);
const adapters = packages.filter((entry) => {
  const manifest = manifests.get(entry.location);
  return (
    manifest?.peerDependencies?.["@workhorse/core"] !== undefined &&
    manifest.dependencies?.["@workhorse/dashboard-contract"] === undefined &&
    !compatibilityFacades.includes(entry)
  );
});

if (requestedTarget === "--core") {
  await buildPackage(core.location);
} else if (requestedTarget === "--adapters") {
  await buildPackage(core.location);
  await Promise.all(adapters.map((entry) => buildPackage(entry.location)));
} else if (requestedTarget === "--dashboard") {
  await buildPackage(core.location);
  await buildPackage(dashboardContract.location);
  await buildPackage(dashboardServer.location);
  await buildPackage("dashboard/app");
  await Promise.all(compatibilityFacades.map((entry) => buildPackage(entry.location)));
  await copyDashboardApplication();
} else {
  await buildPackage(core.location);
  if (!development) await buildPackage(dashboardContract.location);
  await Promise.all([
    buildPackage(dashboardServer.location),
    ...adapters.map((entry) => buildPackage(entry.location)),
  ]);
  await buildPackage("dashboard/app");
  await Promise.all(compatibilityFacades.map((entry) => buildPackage(entry.location)));
  await copyDashboardApplication();
}
