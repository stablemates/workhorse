import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  copyIgnoredEnvironmentFiles,
  createWorktreeResources,
  dropWorktreeDatabases,
  pathExists,
  parseEnvironment,
  readEnvironment,
  readResourceRegistry,
  resourceEnvironment,
  resourceRegistryPath,
  run,
  updateEnvironment,
  worktreeContext,
  writeResourceRegistry,
} from "./worktree-resources.js";

const context = worktreeContext();
if (!context.linked) {
  console.log("Primary worktree detected; no worktree-specific resources are needed");
  process.exit(0);
}

const copied = await copyIgnoredEnvironmentFiles(context.primaryWorktreeRoot, context.worktreeRoot);
const targetEnvironmentPath = join(context.worktreeRoot, ".env");
let targetEnvironmentContents: string;
try {
  targetEnvironmentContents = await readFile(targetEnvironmentPath, "utf8");
} catch {
  targetEnvironmentContents = await readFile(join(context.worktreeRoot, ".env.example"), "utf8");
}

const primaryEnvironment = {
  ...process.env,
  ...parseEnvironment(targetEnvironmentContents),
  ...(await readEnvironment(join(context.primaryWorktreeRoot, ".env"))),
};
const resources = createWorktreeResources(
  context.worktreeId,
  context.worktreeRoot,
  context.gitDirectory,
  primaryEnvironment,
);
const generatedEnvironment = resourceEnvironment(resources);
const registryPath = resourceRegistryPath(context.commonGitDirectory, context.worktreeId);
if (await pathExists(registryPath)) {
  await dropWorktreeDatabases(await readResourceRegistry(registryPath));
}
await writeFile(
  targetEnvironmentPath,
  updateEnvironment(targetEnvironmentContents, generatedEnvironment),
);
await chmod(targetEnvironmentPath, 0o600);

await writeResourceRegistry(context.commonGitDirectory, resources);
await run("uv", ["sync", "--project", "python", "--frozen"], { cwd: context.worktreeRoot });
await run("go", ["-C", "go", "mod", "download"], { cwd: context.worktreeRoot });
await run("pnpm", ["db:reset:all"], {
  cwd: context.worktreeRoot,
  env: { ...process.env, ...generatedEnvironment },
});

console.log(
  `Configured linked worktree ${context.worktreeId}: copied ${copied.length} env file(s), synchronized language dependencies, and provisioned five databases`,
);
