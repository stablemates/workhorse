import { spawn } from "node:child_process";
import path from "node:path";

import { writeOrCheck } from "./api-snapshot.js";
import { repositoryRoot } from "./packages.js";

/**
 * Write or verify `api/ruby.txt`.
 *
 * `ruby/tools/api_snapshot.rb` does the reading, because only the loaded gem knows which constants
 * and methods are private, and only its source carries the `:nodoc:` markers. This side runs it
 * under the gem's bundle and shares the reporting the other language snapshots use.
 */

async function snapshot(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("bundle", ["exec", "ruby", "tools/api_snapshot.rb"], {
      cwd: path.join(repositoryRoot, "ruby"),
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`ruby/tools/api_snapshot.rb exited with ${signal ?? String(code)}`));
    });
  });
}

await writeOrCheck(
  {
    path: "api/ruby.txt",
    generateCommand: "pnpm ruby-api:generate",
    meaning: "A gone line is a removal, a rename, or a narrowing, and ADR 0054 makes it breaking.",
    goneLabel: "gone",
    arrivedLabel: "arrived",
  },
  await snapshot(),
  process.argv.includes("--check"),
);
