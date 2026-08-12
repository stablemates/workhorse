import { readFileSync } from "node:fs";

/**
 * The versions a benchmark run reports for itself and its competitors.
 *
 * A recorded benchmark is evidence only if the version in the report is the version that ran, so
 * neither the targets nor the documentation may restate a competitor version. The installed
 * version is the one the root manifest pins, and both are read from it here.
 * `test/benchmark-versions.test.ts` fails when a target, the README, or `docs/benchmarking.md`
 * disagrees with the pin.
 */

interface RootManifest {
  readonly version: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as RootManifest;

/** The repository's own version, which is what a Workhorse benchmark result describes. */
export const repositoryVersion: string = manifest.version;

/**
 * The exact version of an installed competitor package.
 *
 * Competitors are pinned rather than ranged: a range would let a lockfile refresh change what a
 * recorded comparison measured without changing what it claims to have measured. A range here is
 * therefore an error rather than something to approximate.
 */
export function installedVersion(packageName: string): string {
  const declared = manifest.dependencies?.[packageName] ?? manifest.devDependencies?.[packageName];
  if (declared === undefined) {
    throw new Error(`${packageName} is not a dependency of the repository`);
  }
  if (!/^\d+\.\d+\.\d+/.test(declared)) {
    throw new Error(
      `${packageName} is declared as "${declared}"; benchmark competitors must be pinned exactly`,
    );
  }
  return declared;
}
