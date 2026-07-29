import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  dropWorktreeDatabases,
  pathExists,
  readResourceRegistry,
  removeResourceRegistry,
  worktreeContext,
} from "./worktree-resources.js";

const context = worktreeContext();
const registryDirectory = join(context.commonGitDirectory, "worktree-resources");
let entries: string[];
try {
  entries = await readdir(registryDirectory);
} catch (error) {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
    process.exit(0);
  throw error;
}

for (const entry of entries.filter((name) => name.endsWith(".json"))) {
  const path = join(registryDirectory, entry);
  const resources = await readResourceRegistry(path);
  if (await pathExists(resources.gitDirectory)) continue;
  await dropWorktreeDatabases(resources);
  await removeResourceRegistry(path);
  console.log(`Pruned orphaned resources for ${resources.worktreeId}`);
}
