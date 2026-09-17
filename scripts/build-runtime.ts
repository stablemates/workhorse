import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { corePackage, repositoryRoot, workspacePackages } from "./packages.js";

interface Manifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

const development = process.argv.includes("--dev");
const checkDashboardBundle = process.argv.includes("--check-dashboard-bundle");
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

// Each package build is one TypeScript compiler, and V8 sizes a compiler's heap from the machine
// rather than from how many siblings are already running. Starting more of them than the machine
// has cores therefore buys no throughput and multiplies peak memory, which is what exhausts a
// two-core continuous integration runner. An image build sets BUILD_CONCURRENCY because the
// container sees every core of its host, not the share the build is meant to use.
const requestedConcurrency = Number(process.env.BUILD_CONCURRENCY);
const buildConcurrency = Math.min(
  availableParallelism(),
  requestedConcurrency > 0 ? requestedConcurrency : Number.POSITIVE_INFINITY,
);

async function buildPackages(locations: readonly string[]): Promise<void> {
  const pending = [...locations];
  const workers = Array.from({ length: Math.min(buildConcurrency, pending.length) }, async () => {
    for (let location = pending.shift(); location; location = pending.shift()) {
      await buildPackage(location);
    }
  });
  await Promise.all(workers);
}

async function copyDashboardApplication(): Promise<void> {
  const target = path.join(repositoryRoot, "typescript/dashboard-server/dist/app");
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  if (!development) {
    await cp(path.join(repositoryRoot, "dashboard/app/dist/app"), target, { recursive: true });
  }
  await cp(
    path.join(repositoryRoot, "dashboard/app/browser/login.html"),
    path.join(target, "login.html"),
  );
}

async function buildDashboardApplication(): Promise<void> {
  await buildPackage("dashboard/app");
  if (!development) {
    await run([
      "exec",
      "tsx",
      "scripts/generate-dashboard-bundle.ts",
      ...(checkDashboardBundle ? ["--check"] : []),
    ]);
  }
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
const dashboardContract = packageAt("@stablemates/workhorse-dashboard-contract");
const dashboardServer = packageAt("@stablemates/workhorse-dashboard-server");
const compatibilityFacades = packages.filter(
  (entry) =>
    manifests.get(entry.location)?.dependencies?.["@stablemates/workhorse-dashboard-server"],
);
const adapters = packages.filter((entry) => {
  const manifest = manifests.get(entry.location);
  return (
    manifest?.peerDependencies?.["@stablemates/workhorse"] !== undefined &&
    manifest.dependencies?.["@stablemates/workhorse-dashboard-contract"] === undefined &&
    !compatibilityFacades.includes(entry)
  );
});

if (requestedTarget === "--core") {
  await buildPackage(core.location);
} else if (requestedTarget === "--adapters") {
  await buildPackage(core.location);
  await buildPackages(adapters.map((entry) => entry.location));
} else if (requestedTarget === "--dashboard") {
  await buildPackage(core.location);
  await buildPackage(dashboardContract.location);
  await buildPackage(dashboardServer.location);
  await buildDashboardApplication();
  await buildPackages(compatibilityFacades.map((entry) => entry.location));
  await copyDashboardApplication();
} else {
  await buildPackage(core.location);
  if (!development) await buildPackage(dashboardContract.location);
  await buildPackages([dashboardServer.location, ...adapters.map((entry) => entry.location)]);
  await buildDashboardApplication();
  await buildPackages(compatibilityFacades.map((entry) => entry.location));
  await copyDashboardApplication();
}
