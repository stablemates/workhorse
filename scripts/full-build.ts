import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sourceFingerprint, treeFingerprint } from "./build-fingerprint.js";
import { fullBuildOutputDirectories, requiredTestBuildOutputs } from "./test-build-outputs.js";

const root = path.resolve(import.meta.dirname, "..");
const stamp = path.join(root, ".build/full-build.json");

async function outputFingerprint(): Promise<string> {
  for (const file of requiredTestBuildOutputs) await access(path.join(root, file));
  return treeFingerprint(root, fullBuildOutputDirectories);
}

if (process.argv.includes("--check")) {
  const recorded = JSON.parse(
    await readFile(stamp, "utf8").catch(() => {
      throw new Error("No full build is recorded. Run pnpm build first.");
    }),
  ) as { source: string; output: string };
  if (
    recorded.source !== (await sourceFingerprint(root)) ||
    recorded.output !== (await outputFingerprint())
  ) {
    throw new Error("Full build artifacts are stale. Run pnpm build first.");
  }
} else {
  await rm(stamp, { force: true });
  const source = await sourceFingerprint(root);
  for (const args of [
    [
      "exec",
      "tsx",
      "scripts/build-runtime.ts",
      ...(process.argv.includes("--verify-bundle") ? ["--check-dashboard-bundle"] : []),
    ],
    ["docs:build"],
    ["--filter", "@stablemates/workhorse-demo", "build"],
    ["python:build"],
  ]) {
    const result = spawnSync("pnpm", args, { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  if (source !== (await sourceFingerprint(root)))
    throw new Error("Sources changed during the full build. Run pnpm build again.");
  await mkdir(path.dirname(stamp), { recursive: true });
  await writeFile(stamp, JSON.stringify({ source, output: await outputFingerprint() }));
}
