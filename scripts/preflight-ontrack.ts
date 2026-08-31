import { configureOntrackSession, preflightOntrackSession } from "./ontrack-session.js";
import { worktreeContext } from "./worktree-resources.js";

const context = worktreeContext();
const sessionName = context.linked ? context.worktreeId : "workhorse";
const configured = await configureOntrackSession({
  checkoutRoot: context.worktreeRoot,
  sourceRoot: context.linked ? context.primaryWorktreeRoot : context.worktreeRoot,
  sessionName,
});
const result = await preflightOntrackSession(configured);
console.log(
  `Ontrack preflight passed for Session ${result.sessionName}: Project ${result.projectKey} (${result.projectId})`,
);
