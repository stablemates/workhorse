import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * The published-package list, derived rather than declared.
 *
 * Every publishable workspace package is packed, built, and version-checked. Restating that set by
 * hand is how a new package silently misses a release, so this module derives the TypeScript
 * packages from their workspace locations:
 * `typescript/core/test/packed-packages.ts`, `typescript/core/test/support-matrix.test.ts`,
 * `.github/workflows/release.yml`, and the build scripts through the `typescript/*` filter.
 * `typescript/core/test/published-packages.test.ts` fails when
 * a consumer restates the list instead.
 */

/** Repository root, resolved from this file so the caller's working directory does not matter. */
export const repositoryRoot = path.resolve(import.meta.dirname, "..");

export interface PublishedPackage {
  /** Package name as npm knows it, for example `@stablemates/workhorse-dashboard`. */
  readonly name: string;
  /** Directory name under `typescript/`, for example `dashboard-server`. */
  readonly directory: string;
  /** Path from the repository root, for example `typescript/dashboard-server`. */
  readonly location: string;
  /** Path from the repository root to the manifest. */
  readonly manifest: string;
  /** Declared version. Every published package moves in lockstep with the root manifest. */
  readonly version: string;
  /** Tarball `pnpm pack` writes, for example `stablemates-workhorse-dashboard-0.1.0.tgz`. */
  readonly tarball: string;
}

interface Manifest {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
}

async function readManifest(relativePath: string): Promise<Manifest> {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8")) as Manifest;
}

async function readWorkspaceManifest(relativePath: string): Promise<Manifest | undefined> {
  try {
    return await readManifest(relativePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** The tarball basename `pnpm pack` produces: `@stablemates/workhorse-x` -> `stablemates-workhorse-x`. */
function tarballName(name: string, version: string): string {
  return `${name.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`;
}

async function describe(relativePath: string, directory: string): Promise<PublishedPackage> {
  const manifest = await readManifest(relativePath);
  const name = manifest.name;
  const version = manifest.version;
  if (!name || !version) throw new Error(`${relativePath} declares no name or version`);
  return {
    name,
    directory,
    location: path.posix.dirname(relativePath),
    manifest: relativePath,
    version,
    tarball: tarballName(name, version),
  };
}

/** `@stablemates/workhorse`, which lives at `typescript/core`. */
export async function corePackage(): Promise<PublishedPackage> {
  return describe("typescript/core/package.json", "core");
}

/** Publishable workspace packages other than core, in build order. */
export async function workspacePackages(): Promise<readonly PublishedPackage[]> {
  const entries = await readdir(path.join(repositoryRoot, "typescript"), { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && entry.name !== "core")
    .map((entry) => entry.name);
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 target lacks Array#toSorted().
  directories.sort();
  const described = await Promise.all(
    directories.map(async (directory) => {
      const relativePath = `typescript/${directory}/package.json`;
      const manifest = await readWorkspaceManifest(relativePath);
      if (!manifest) return undefined;
      return manifest.private === true ? undefined : await describe(relativePath, directory);
    }),
  );
  return described.filter((entry): entry is PublishedPackage => entry !== undefined);
}

/**
 * Every published package, core first.
 *
 * Order matters to the release: the packages under `typescript/` declare `@stablemates/workhorse` as a
 * peer, so a failed core publish must not leave dependents pointing at a version nobody can
 * install.
 */
export async function publishedPackages(): Promise<readonly PublishedPackage[]> {
  return [await corePackage(), ...(await workspacePackages())];
}

// Run directly to print the publishable `typescript/` directory names, one per line, for shell
// consumers such as the release workflow. Core is deliberately absent and publishes first.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  for (const entry of await workspacePackages()) process.stdout.write(`${entry.directory}\n`);
}
