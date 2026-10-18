import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { SnapshotContract } from "./api-snapshot.js";
import { repositoryRoot } from "./packages.js";

/**
 * The two JVM API snapshots of ADR 0103: `api/java.txt` and `api/kotlin.txt`.
 *
 * `jvm/api-snapshot` does the reading. Its `javaApi` task loads the `workhorse` and
 * `workhorse-spring-boot-starter` jars and reads them by reflection, which sees generic signatures
 * and JSpecify nullness. Its `kotlinApi` task parses the `workhorse-kotlin` sources, because only
 * the source holds a default argument. This side runs a task and shares the reporting the other
 * language snapshots use.
 */

const meaning =
  "A gone line is a removal, a rename, or a narrowing, and ADR 0103 makes it breaking.";

export const javaContract: SnapshotContract = {
  path: "api/java.txt",
  generateCommand: "pnpm java-api:generate",
  meaning,
  goneLabel: "gone",
  arrivedLabel: "arrived",
};

export const kotlinContract: SnapshotContract = {
  path: "api/kotlin.txt",
  generateCommand: "pnpm kotlin-api:generate",
  meaning,
  goneLabel: "gone",
  arrivedLabel: "arrived",
};

/** Runs one `jvm/api-snapshot` task and returns the file it wrote. */
export async function readJvmSnapshot(
  task: "javaApi" | "kotlinApi",
  file: string,
): Promise<string> {
  const jvm = path.join(repositoryRoot, "jvm");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("gradle", ["-p", jvm, "--quiet", `:api-snapshot:${task}`], {
      cwd: repositoryRoot,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`gradle :api-snapshot:${task} exited with ${signal ?? String(code)}`));
    });
  });
  return await readFile(path.join(jvm, "api-snapshot", "build", "api", file), "utf8");
}
