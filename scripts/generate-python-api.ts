import { spawn } from "node:child_process";

import { writeOrCheck } from "./api-snapshot.js";
import { repositoryRoot } from "./packages.js";

/**
 * Write or verify `api/python.txt`.
 *
 * `python/tools/api_snapshot.py` does the reading, because only the imported package knows where a
 * re-exported name was defined. This side runs it under the project's environment and shares the
 * reporting the other two language snapshots use.
 */

async function snapshot(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "uv",
      ["run", "--project", "python", "python", "python/tools/api_snapshot.py"],
      { cwd: repositoryRoot, stdio: ["ignore", "pipe", "inherit"] },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`python/tools/api_snapshot.py exited with ${signal ?? String(code)}`));
    });
  });
}

await writeOrCheck(
  {
    path: "api/python.txt",
    generateCommand: "pnpm python-api:generate",
    meaning: "A gone line is a removal, a rename, or a narrowing, and ADR 0054 makes it breaking.",
    goneLabel: "gone",
    arrivedLabel: "arrived",
  },
  await snapshot(),
  process.argv.includes("--check"),
);
