import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

function generatedBundle(file: string): boolean {
  return (
    file.startsWith("dashboard/v1/bundle/") ||
    /^(go\/dashboard|python\/src\/workhorse\/dashboard|rust\/dashboard)\/(bundle\.json|read-surface-.*\.tar\.gz)$/.test(
      file,
    )
  );
}

export async function sourceFingerprint(root: string): Promise<string> {
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
      ),
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter((file) => file && !generatedBundle(file));
  return hashFiles(root, files, process.version);
}

/** Include file names and every chunk, so removing or changing a nested output invalidates reuse. */
export async function treeFingerprint(
  root: string,
  directories: readonly string[],
): Promise<string> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(path.join(root, directory), { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else files.push(file);
    }
  }
  for (const directory of directories) await walk(directory);
  return hashFiles(root, files);
}

/**
 * The bytes that stand for one path. A symbolic link stands for its target path, because git
 * tracks the link and not what it points to. The docs site links `site/blume/public` to a
 * directory, which `readFile` cannot read.
 */
async function fileContent(file: string): Promise<Buffer | string> {
  if ((await lstat(file)).isSymbolicLink()) return `symlink:${await readlink(file)}`;
  return readFile(file);
}

async function hashFiles(root: string, files: readonly string[], salt = ""): Promise<string> {
  const hash = createHash("sha256").update(salt);
  for (const file of [...new Set(files)].toSorted()) {
    hash.update(file).update("\0");
    try {
      hash.update(await fileContent(path.join(root, file)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("deleted");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}
