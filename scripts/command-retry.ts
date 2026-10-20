import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Run a command, return its standard output, and reject if it exits with a status other than 0.
 * Standard error goes to this process, so a failed attempt shows its own message.
 */
export async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(" ")} exited with ${signal ?? String(code)}`));
    });
  });
}

interface RetryOptions {
  /** The step name in each report, for example `go mod download`. */
  readonly label: string;
  readonly attempts?: number;
  readonly delayMs?: number;
  readonly report?: (message: string) => void;
  readonly wait?: (ms: number) => Promise<void>;
}

/**
 * Run a network step again if it fails.
 *
 * A module proxy, a checksum database, or a release host can reset a stream for a short time
 * (SM-1557). The step runs at most `attempts` times, with `delayMs` between attempts, and each
 * failed attempt is reported. If every attempt fails, the last error is thrown, so a permanent
 * failure fails the caller as before.
 */
export async function retryStep<T>(step: () => Promise<T>, options: RetryOptions): Promise<T> {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 2_000;
  const report = options.report ?? ((message: string) => console.error(message));
  const wait = options.wait ?? ((ms: number) => sleep(ms));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await step();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const failed = `${options.label}: attempt ${attempt} of ${attempts} failed (${reason})`;
      if (attempt >= attempts) {
        report(failed);
        throw error;
      }
      report(`${failed}; retrying in ${delayMs / 1_000} s`);
      await wait(delayMs);
    }
  }
}
