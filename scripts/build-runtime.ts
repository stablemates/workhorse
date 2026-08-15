import { spawn } from "node:child_process";
import { cp, readFile } from "node:fs/promises";
import path from "node:path";
import { corePackage, repositoryRoot, workspacePackages } from "./packages.js";

interface Manifest {
  readonly dependencies?: Readonly<Record<string, string>>;
}

const development = process.argv.includes("--dev");
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

const core = await corePackage();
await run(["--dir", core.location, script]);

const packages = await workspacePackages();
const manifests = new Map(
  await Promise.all(
    packages.map(async (entry) => [entry.location, await manifestAt(entry.location)] as const),
  ),
);
const compatibilityFacades = packages.filter(
  (entry) => manifests.get(entry.location)?.dependencies?.["@workhorse/dashboard-server"],
);
const implementations = packages.filter((entry) => !compatibilityFacades.includes(entry));

for (const entry of implementations) await run(["--dir", entry.location, script]);
await run(["--dir", "dashboard/app", script]);
for (const entry of compatibilityFacades) await run(["--dir", entry.location, script]);
if (!development) {
  await cp(
    path.join(repositoryRoot, "dashboard/app/dist/app"),
    path.join(repositoryRoot, "typescript/dashboard-server/dist/app"),
    { recursive: true },
  );
}
