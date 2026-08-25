import { readFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const releaseVersionPattern = "[0-9]+\\.[0-9]+\\.[0-9]+(?:[ab][0-9]+|rc[0-9]+|-[-0-9A-Za-z.]+)?";

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

function releaseVersion(target: "go" | "python", tag: string): string {
  const match = new RegExp(`^${target}/v(${releaseVersionPattern})$`).exec(tag);
  if (!match) throw new Error(`Expected a ${target}/vX.Y.Z release tag, received ${tag}`);
  return match[1]!;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function requireChangelogVersion(relativePath: string, version: string): Promise<void> {
  const changelog = await read(relativePath);
  if (!new RegExp(`^## ${escapeRegExp(version)}(?:\\s|$)`, "m").test(changelog)) {
    throw new Error(`${relativePath} has no ${version} release entry`);
  }
}

export async function checkRelease(target: "go" | "python", tag: string): Promise<void> {
  const version = releaseVersion(target, tag);
  if (target === "python") {
    const manifest = await read("python/pyproject.toml");
    const declaredVersion = /^version = "([^"]+)"$/m.exec(manifest)?.[1];
    if (!declaredVersion) throw new Error("python/pyproject.toml declares no project version");
    if (declaredVersion !== version) {
      throw new Error(`python/pyproject.toml is ${declaredVersion} but the tag is ${version}`);
    }
  }
  await requireChangelogVersion(`${target}/CHANGELOG.md`, version);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [target, tag] = process.argv.slice(2);
  if ((target !== "go" && target !== "python") || !tag) {
    process.stderr.write("Usage: pnpm release:check <go|python> <go/vX.Y.Z|python/vX.Y.Z>\n");
    process.exitCode = 1;
  } else {
    try {
      await checkRelease(target, tag);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
