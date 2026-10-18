import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// `jvm/examples` holds the documentation snippets (SM-1453). Their SQL is the application SQL of a
// snippet, such as the `account` insert of a transaction example, not protocol SQL, and the
// directory is no artifact. The path is relative to the repository root, so a directory named
// `examples` in another place stays covered.
const exemptDirectories = new Set(["jvm/examples"]);

/**
 * The places where a JVM class writes SQL by hand (ADR 0103), as `<path>:<line>` relative to
 * `repository`. A JDBC call whose SQL argument starts with a string literal is SQL written in
 * place. The scan reads `jvm/` and skips build output, test sources, and `jvm/examples`. The
 * result is sorted.
 */
export async function findInlineJavaSql(repository: string): Promise<string[]> {
  const call =
    /\b(?:prepareStatement|prepareCall|execute|executeQuery|executeUpdate|executeLargeUpdate|addBatch)\(\s*"/g;
  const violations: string[] = [];

  async function inspect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      const relative = path.relative(repository, filename).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (
          entry.name !== "build" &&
          entry.name !== ".gradle" &&
          entry.name !== "test" &&
          !exemptDirectories.has(relative)
        )
          await inspect(filename);
        continue;
      }
      if (!/\.(?:java|kt)$/.test(entry.name)) continue;
      const source = await readFile(filename, "utf8");
      for (const match of source.matchAll(call)) {
        const line = source.slice(0, match.index).split("\n").length;
        violations.push(`${relative}:${line}`);
      }
    }
  }

  await inspect(path.join(repository, "jvm"));
  return violations.toSorted();
}
