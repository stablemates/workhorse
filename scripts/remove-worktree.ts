import { resolve } from "node:path";
import {
  dropWorktreeDatabases,
  git,
  pathExists,
  readResourceRegistry,
  removeResourceRegistry,
  resourceRegistryPath,
  run,
  worktreeContext,
} from "./worktree-resources.js";

const requestedPath = process.argv[2];
if (!requestedPath) throw new Error("Usage: pnpm worktree:remove <path> [--force]");

const context = worktreeContext();
const targetRoot = git(
  context.worktreeRoot,
  "-C",
  resolve(requestedPath),
  "rev-parse",
  "--show-toplevel",
);
const targetGitDirectory = git(targetRoot, "rev-parse", "--path-format=absolute", "--git-dir");
if (targetGitDirectory === context.commonGitDirectory)
  throw new Error("Refusing to remove the primary worktree");

const worktreeId = targetGitDirectory.split("/").at(-1)!;
const registryPath = resourceRegistryPath(context.commonGitDirectory, worktreeId);
const resources = (await pathExists(registryPath))
  ? await readResourceRegistry(registryPath)
  : undefined;
await run(
  "git",
  ["worktree", "remove", ...(process.argv.includes("--force") ? ["--force"] : []), targetRoot],
  {
    cwd: context.worktreeRoot,
  },
);
if (resources) {
  await dropWorktreeDatabases(resources);
  await removeResourceRegistry(registryPath);
}
console.log(`Removed ${targetRoot} and cleaned its worktree databases`);
