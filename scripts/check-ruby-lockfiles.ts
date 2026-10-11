/**
 * Check that each locked Rails gemfile under `ruby/gemfiles/` agrees with `ruby/Gemfile`.
 *
 * A gemfile such as `rails_8_0.gemfile` evaluates `ruby/Gemfile` and adds its own Rails. Dependabot
 * reads only `ruby/Gemfile`, so it updates `ruby/Gemfile.lock` and leaves these lockfiles stale.
 * The job that installs a stale one runs weekly, and its frozen `bundle install` then refuses the
 * lockfile. This check runs on every change, so the pull request that makes a lockfile stale fails.
 *
 * `bundle lock --print` resolves a gemfile against its lockfile and prints the result without
 * writing it. When the lockfile agrees with the gemfile, the output is the same bytes as the file.
 *
 * Usage: tsx scripts/with-env.ts tsx scripts/check-ruby-lockfiles.ts
 */
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const gemDirectory = path.resolve(import.meta.dirname, "..", "ruby");
const gemfilesDirectory = path.join(gemDirectory, "gemfiles");

function lockPrint(gemfile: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bundle", ["lock", "--print"], {
      cwd: gemDirectory,
      env: { ...process.env, BUNDLE_GEMFILE: gemfile },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`bundle lock --print exited with ${code} for ${gemfile}`));
    });
  });
}

const lockfiles = (await readdir(gemfilesDirectory)).filter((name) =>
  name.endsWith(".gemfile.lock"),
);
if (lockfiles.length === 0) throw new Error(`no locked gemfile found in ${gemfilesDirectory}`);

const stale: string[] = [];
for (const lockfile of lockfiles.toSorted()) {
  const gemfile = path.join(gemfilesDirectory, lockfile.slice(0, -".lock".length));
  const committed = await readFile(path.join(gemfilesDirectory, lockfile), "utf8");
  if ((await lockPrint(gemfile)) !== committed) stale.push(lockfile);
}

if (stale.length > 0) {
  console.error("These lockfiles do not agree with ruby/Gemfile:");
  for (const lockfile of stale) {
    console.error(`  ruby/gemfiles/${lockfile}`);
    console.error(
      `    To update it, run in ruby/: BUNDLE_GEMFILE=gemfiles/${lockfile.slice(0, -".lock".length)} bundle lock`,
    );
  }
  process.exitCode = 1;
} else {
  console.log(`Ruby gemfile lockfiles agree with ruby/Gemfile: ${lockfiles.join(", ")}`);
}
