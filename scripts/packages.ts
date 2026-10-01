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
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
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

/** Publishable workspace packages other than core, in directory order. */
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
 * The published packages a manifest cannot install without: its `dependencies`, and every peer it
 * does not mark optional. An optional peer is satisfied by its absence, so it imposes no order.
 */
function requiredPublishedPackages(manifest: Manifest, names: ReadonlySet<string>): string[] {
  const optional = manifest.peerDependenciesMeta ?? {};
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}).filter(
      (name) => optional[name]?.optional !== true,
    ),
  ].filter((name) => names.has(name));
}

/**
 * Every published package, each after the published packages it requires.
 *
 * Order matters to the release, because `scripts/publish-npm.ts` publishes in this order and stops
 * at the first failure. A package that reaches npm before a package it requires cannot be installed
 * until that one follows. `@stablemates/workhorse` requires the dashboard contract, the dashboard
 * facade requires the dashboard server, and most other packages require core as a peer. Sorting by
 * those edges keeps every package an interrupted release did publish installable. Optional peers
 * are left out, which is what breaks the cycle between core and the dashboard facade. Packages with
 * no remaining requirement go in name order, so the order is stable.
 */
export async function publishedPackages(): Promise<readonly PublishedPackage[]> {
  const candidates = [await corePackage(), ...(await workspacePackages())];
  const names = new Set(candidates.map((entry) => entry.name));
  const requirements = new Map(
    await Promise.all(
      candidates.map(
        async (entry) =>
          [
            entry.name,
            new Set(requiredPublishedPackages(await readManifest(entry.manifest), names)),
          ] as const,
      ),
    ),
  );
  const ordered: PublishedPackage[] = [];
  const placed = new Set<string>();
  while (ordered.length < candidates.length) {
    const next = candidates
      .filter((entry) => !placed.has(entry.name))
      .filter((entry) =>
        [...(requirements.get(entry.name) ?? [])].every((name) => placed.has(name)),
      )
      .reduce<PublishedPackage | undefined>(
        (first, entry) => (first === undefined || entry.name < first.name ? entry : first),
        undefined,
      );
    if (!next) {
      const cycle = candidates
        .filter((entry) => !placed.has(entry.name))
        .map((entry) => entry.name);
      throw new Error(`Published packages require each other in a cycle: ${cycle.join(", ")}`);
    }
    ordered.push(next);
    placed.add(next.name);
  }
  return ordered;
}

// Run directly to print one field per package for shell consumers such as the release workflow.
// The default preserves the original non-core directory list used by older callers.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const output = process.argv[2];
  const entries = output === undefined ? await workspacePackages() : await publishedPackages();
  for (const entry of entries) {
    switch (output) {
      case undefined:
        process.stdout.write(`${entry.directory}\n`);
        break;
      case "--locations":
        process.stdout.write(`${entry.location}\n`);
        break;
      case "--manifests":
        process.stdout.write(`${entry.manifest}\n`);
        break;
      case "--tarballs":
        process.stdout.write(`${entry.tarball}\n`);
        break;
      default:
        throw new Error(`Unknown package-list output ${output}`);
    }
  }
}
