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

/** One `public record` header line of `api/java.txt`, split around its component list. */
interface RecordHeader {
  /** The text before the component list, for example `@NullMarked public record run.workhorse.X`. */
  readonly head: string;
  /** The binary name of the record, for example `run.workhorse.dashboard.DashboardAuthorization.Allow`. */
  readonly name: string;
  readonly components: readonly string[];
  /** The text after the component list, for example ` implements run.workhorse.Y`. */
  readonly tail: string;
}

/** Splits a list at the commas outside angle brackets and parentheses. */
function topLevel(list: string): string[] {
  if (list.trim() === "") return [];
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index++) {
    const character = list[index];
    if (character === "<" || character === "(") depth++;
    else if (character === ">" || character === ")") depth--;
    else if (character === "," && depth === 0) {
      parts.push(list.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts;
}

function recordHeader(line: string): RecordHeader | undefined {
  const match = /^(?:@\S+ )*public (?:final )?record ([\w.$]+)/.exec(line);
  if (!match) return undefined;
  let index = match[0].length;
  let depth = 0;
  // Skip the type parameters, which can hold their own angle brackets.
  for (; index < line.length; index++) {
    const character = line[index];
    if (character === "<") depth++;
    else if (character === ">") depth--;
    else if (character === "(" && depth === 0) break;
  }
  const open = index;
  depth = 0;
  for (; index < line.length; index++) {
    const character = line[index];
    if (character === "(") depth++;
    else if (character === ")" && --depth === 0) break;
  }
  if (open >= line.length || index >= line.length) return undefined;
  return {
    head: line.slice(0, open),
    name: match[1] ?? "",
    components: topLevel(line.slice(open + 1, index)),
    tail: line.slice(index + 1),
  };
}

/** The constructor lines of record `name` with `arity` parameters. */
function constructors(lines: readonly string[], name: string, arity: number): string[] {
  const simple = name.slice(name.lastIndexOf(".") + 1);
  const prefix = `${name}: public ${simple}(`;
  return lines.filter(
    (line) =>
      line.startsWith(prefix) &&
      line.endsWith(")") &&
      topLevel(line.slice(prefix.length, -1)).length === arity,
  );
}

/**
 * The growth rule of ADR 0103 (SM-1516): a record header that is gone is additive when a fresh
 * header keeps every earlier component, in order, and adds components only at the end, and when the
 * earlier canonical constructor line is still present. Every other change of a header is breaking.
 */
export function grownRecord(
  line: string,
  before: readonly string[],
  after: readonly string[],
): boolean {
  const old = recordHeader(line);
  if (!old) return false;
  const kept = constructors(before, old.name, old.components.length);
  if (kept.length === 0 || !kept.every((constructor) => after.includes(constructor))) return false;
  return after.some((candidate) => {
    const grown = recordHeader(candidate);
    return (
      grown !== undefined &&
      grown.head === old.head &&
      grown.tail === old.tail &&
      grown.components.length > old.components.length &&
      old.components.every((component, index) => grown.components[index] === component)
    );
  });
}

export const javaContract: SnapshotContract = {
  path: "api/java.txt",
  generateCommand: "pnpm java-api:generate",
  meaning:
    `${meaning} A record header that only gained last components, and kept its earlier canonical` +
    " constructor, is additive.",
  goneLabel: "gone",
  arrivedLabel: "arrived",
  additive: { label: "grown record, additive under ADR 0103", test: grownRecord },
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
