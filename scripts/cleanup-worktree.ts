import {
  dropWorktreeDatabases,
  readResourceRegistry,
  removeResourceRegistry,
  resourceRegistryPath,
  worktreeContext,
} from "./worktree-resources.js";

const context = worktreeContext();
if (!context.linked) throw new Error("Refusing to clean the primary worktree");

const registryPath = resourceRegistryPath(context.commonGitDirectory, context.worktreeId);
const resources = await readResourceRegistry(registryPath);
await dropWorktreeDatabases(resources);
await removeResourceRegistry(registryPath);
console.log(`Cleaned resources for linked worktree ${context.worktreeId}`);
