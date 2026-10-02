import { createRequire } from "node:module";

// Load TypeScript in the process the test owns. tsx/cli starts a second Node process,
// which survives SIGKILL of the wrapper and can keep a dashboard or worker running.
export const cliNodeArgs = ["--import", createRequire(import.meta.url).resolve("tsx")];
