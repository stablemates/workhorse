import { readFileSync } from "node:fs";
import path from "node:path";

interface RootManifest {
  name?: string;
  version: string;
  devDependencies: Record<string, string>;
}

function rootManifest(): RootManifest {
  let directory = import.meta.dirname;
  for (;;) {
    const candidate = path.join(directory, "package.json");
    try {
      const manifest = JSON.parse(readFileSync(candidate, "utf8")) as RootManifest;
      if (manifest.name === "@workhorse/core") return manifest;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("Unable to locate the @workhorse/core manifest");
    directory = parent;
  }
}

const manifest = rootManifest();

function dependencyVersion(name: string): string {
  const version = manifest.devDependencies[name];
  if (!version) throw new Error(`The root manifest must pin benchmark competitor ${name}`);
  return version;
}

export const benchmarkTargetVersions = Object.freeze({
  workhorse: manifest.version,
  "pg-boss": dependencyVersion("pg-boss"),
  "graphile-worker": dependencyVersion("graphile-worker"),
});
