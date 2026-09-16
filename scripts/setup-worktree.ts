import { join } from "node:path";
import {
  provisionCheckoutDatabases,
  writeCheckoutDatabaseEnvironment,
} from "./checkout-databases.js";
import { describeUnscopedDatabases, unscopedDatabases } from "./worktree-identity.js";
import {
  copyIgnoredEnvironmentFiles,
  createWorktreeResources,
  dropWorktreeDatabases,
  pathExists,
  readEnvironment,
  readResourceRegistry,
  resourceEnvironment,
  resourceRegistryPath,
  run,
  worktreeContext,
  writeResourceRegistry,
} from "./worktree-resources.js";

const context = worktreeContext();
if (!context.linked) {
  console.log("Primary worktree detected; no worktree-specific resources are needed");
  process.exit(0);
}

const copied = await copyIgnoredEnvironmentFiles(context.primaryWorktreeRoot, context.worktreeRoot);
const primaryEnvironment = {
  ...process.env,
  ...(await readEnvironment(join(context.worktreeRoot, ".env"))),
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
await writeCheckoutDatabaseEnvironment(context.worktreeRoot, {
  databaseEnvironment: generatedEnvironment,
  overwriteExisting: true,
});

// Re-read what landed on disk rather than trusting the values handed to the writer: the whole
// point is that this worktree must never be left pointing at another checkout's databases.
const written = await readEnvironment(join(context.worktreeRoot, ".env"));
const unscoped = unscopedDatabases(written, context.worktreeId);
if (unscoped.length > 0) {
  throw new Error(describeUnscopedDatabases(context.worktreeId, context.worktreeRoot, unscoped));
}

await writeResourceRegistry(context.commonGitDirectory, resources);
await run("uv", ["sync", "--project", "python", "--frozen"], { cwd: context.worktreeRoot });
await run("go", ["-C", "go", "mod", "download"], { cwd: context.worktreeRoot });
await provisionCheckoutDatabases(generatedEnvironment, { resetExisting: true });

console.log(
  `Configured linked worktree ${context.worktreeId}: copied ${copied.length} env file(s), synchronized language dependencies, and provisioned five databases`,
);
