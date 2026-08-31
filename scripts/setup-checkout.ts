import {
  provisionCheckoutDatabases,
  writeCheckoutDatabaseEnvironment,
} from "./checkout-databases.js";
import { configureOntrackSession, preflightOntrackSession } from "./ontrack-session.js";
import { worktreeContext } from "./worktree-resources.js";

const context = worktreeContext();
if (context.linked) {
  throw new Error("Run pnpm worktree:setup when configuring a linked worktree");
}

const ontrack = await configureOntrackSession({
  checkoutRoot: context.worktreeRoot,
  sessionName: "workhorse",
});
const preflight = await preflightOntrackSession(ontrack);
const configured = await writeCheckoutDatabaseEnvironment(context.worktreeRoot);
const results = await provisionCheckoutDatabases(configured.environment);
const created = results.filter((result) => result.action === "created");

console.log(
  `Configured primary checkout and Ontrack Session ${preflight.sessionName} for Project ${preflight.projectKey} (${preflight.projectId}): added ${configured.addedVariables.length} database variable(s) and created ${created.length} missing database(s)`,
);
