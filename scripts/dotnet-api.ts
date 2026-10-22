import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SnapshotContract } from "./api-snapshot.js";
import { repositoryRoot } from "./packages.js";

/**
 * The C# API snapshot of ADR 0107: `api/dotnet.txt`.
 *
 * `dotnet/tools/Workhorse.ApiSnapshot` does the reading. It reads the built assembly of each package
 * with System.Reflection.Metadata, which sees nullability, `required`, `init`, and default values,
 * and it reads the `Workhorse:*` configuration keys from the resource that `Workhorse.Hosting`
 * embeds. This side runs the tool and shares the reporting the other language snapshots use.
 */

const toolProject = "dotnet/tools/Workhorse.ApiSnapshot/Workhorse.ApiSnapshot.csproj";

const access = "(?:public|protected internal|protected)";

/** The declaring type and the member of a member line, or `undefined` for another line. */
function memberOf(line: string): { type: string; member: string } | undefined {
  if (new RegExp(`^(?:\\[[^\\]]*\\] )*${access} `).test(line) || line.startsWith("key "))
    return undefined;
  const at = line.indexOf(": ");
  if (at < 0) return undefined;
  // Attributes such as `[SetsRequiredMembers]` or `[return: MaybeNull]` come before the access.
  const member = new RegExp(`^(?:\\[[^\\]]*\\] )*${access} (.*)$`).exec(line.slice(at + 2))?.[1];
  return member === undefined ? undefined : { type: line.slice(0, at), member };
}

/**
 * The kind and the name of a type header line, without the variance of its type parameters, so
 * `public interface Workhorse.IHandler<in T>` names `Workhorse.IHandler<T>`.
 */
function headerOf(line: string): { kind: string; type: string } | undefined {
  const match = new RegExp(
    `^${access} (?:\\w+ )*(class|record|struct|interface|enum) (.+?)(?= : | where |$)`,
  ).exec(line);
  if (!match) return undefined;
  return { kind: match[1] ?? "", type: (match[2] ?? "").replace(/\b(?:in|out) /g, "") };
}

/** The last name of a type, without its type arguments: `Workhorse.Outer<T>.Base<U>` gives `Base`. */
function simpleName(type: string): string {
  let plain = type;
  for (let previous = ""; previous !== plain;) {
    previous = plain;
    plain = plain.replace(/<[^<>]*>/g, "");
  }
  return plain.slice(plain.lastIndexOf(".") + 1);
}

/**
 * The growth rules of ADR 0107 ("Public types grow only additively"). An arrived line is breaking
 * when an existing type gains a `required` property or field, or when an existing type that callers
 * can implement gains an abstract member. A caller implements an interface, and it derives from an
 * abstract class or record that has a public or protected constructor.
 */
export function breakingArrival(line: string, before: readonly string[]): boolean {
  const arrived = memberOf(line);
  if (!arrived) return false;
  const { type, member } = arrived;
  const header = before.map(headerOf).find((candidate) => candidate?.type === type);
  if (!header) return false;
  if (/^(?:\S+ )*required /.test(member)) return true;
  if (!/^(?:static )?abstract /.test(member)) return false;
  if (header.kind === "interface") return true;
  const simple = simpleName(type);
  return before.some((candidate) => {
    const existing = memberOf(candidate);
    return existing?.type === type && existing.member.startsWith(`${simple}(`);
  });
}

export const dotnetContract: SnapshotContract = {
  path: "api/dotnet.txt",
  generateCommand: "pnpm dotnet-api:generate",
  meaning:
    "A gone line is a removal, a rename, or a narrowing, and ADR 0107 makes it breaking." +
    " A new required property or field of an existing type, and a new abstract member of a type that callers" +
    " implement, are breaking too.",
  goneLabel: "gone",
  arrivedLabel: "arrived",
  breakingArrival: { label: "arrived, breaking under ADR 0107", test: breakingArrival },
};

/** The package IDs: each project directory under `dotnet/src`, whose project file has its name. */
async function packages(): Promise<string[]> {
  const source = path.join(repositoryRoot, "dotnet", "src");
  const names: string[] = [];
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files = await readdir(path.join(source, entry.name));
    if (files.includes(`${entry.name}.csproj`)) names.push(entry.name);
  }
  return names.toSorted();
}

/** Builds and runs the snapshot tool and returns the file it wrote. */
export async function readDotnetSnapshot(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "workhorse-dotnet-api-"));
  const output = path.join(directory, "dotnet.txt");
  try {
    const args = ["run", "--project", toolProject, "--", output, ...(await packages())];
    await new Promise<void>((resolve, reject) => {
      const child = spawn("dotnet", args, {
        cwd: repositoryRoot,
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(`dotnet run --project ${toolProject} exited with ${signal ?? String(code)}`),
          );
      });
    });
    return await readFile(output, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
