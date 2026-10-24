import { spawn } from "node:child_process";
import { createRequire } from "node:module";

// Load TypeScript in the process the test owns. tsx/cli starts a second Node process,
// which survives SIGKILL of the wrapper and can keep a dashboard or worker running.
export const cliNodeArgs = ["--import", createRequire(import.meta.url).resolve("tsx")];

/** The limit for one CLI run. It stays below the 20 s test timeout, so the run fails first. */
const cliRunTimeoutMs = 15_000;

/**
 * Run a TypeScript CLI script in a child Node process and collect its output.
 *
 * A database test must not use `spawnSync` here. `spawnSync` stops the event loop of the test
 * process. If a transaction of that process is open, for example a reset that an earlier hook
 * left, the process cannot send its COMMIT. The CLI then waits for the locks of that
 * transaction, and the test waits for the CLI (SM-1679). This function lets the event loop run,
 * and it stops the child with SIGKILL after the timeout.
 */
export async function runCliScript(
  script: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? cliRunTimeoutMs;
  const child = spawn(process.execPath, [...cliNodeArgs, script, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => resolve(exitCode));
    });
    if (timedOut) {
      throw new Error(
        `The CLI did not exit within ${timeoutMs} ms, so the test stopped it: ` +
          `${[script, ...args].join(" ").replaceAll(/\/\/[^/@\s]*@/g, "//***@")}\nstderr:\n${stderr}`,
      );
    }
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
