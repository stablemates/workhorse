import {
  provisionCheckoutDatabases,
  writeCheckoutDatabaseEnvironment,
} from "./checkout-databases.js";
import { worktreeContext } from "./worktree-resources.js";

const context = worktreeContext();
if (context.linked) {
  throw new Error("Run pnpm worktree:setup when configuring a linked worktree");
}

const configured = await writeCheckoutDatabaseEnvironment(context.worktreeRoot);
const results = await provisionCheckoutDatabases(configured.environment);
const created = results.filter((result) => result.action === "created");

console.log(
  `Configured primary checkout: added ${configured.addedVariables.length} database variable(s) and created ${created.length} missing database(s)`,
);
