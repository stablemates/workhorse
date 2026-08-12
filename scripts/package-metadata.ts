/**
 * Package selections used by repository automation.
 *
 * Keep the runtime list explicit: a directory appearing under packages/ must not silently join the
 * build or release surface. The drift tests compare this declaration with every publishable package
 * manifest, so adding a package requires one deliberate edit here.
 */
export interface WorkspacePackage {
  readonly directory: string;
  readonly name: `@workhorse/${string}`;
}

export const runtimePackages: readonly WorkspacePackage[] = Object.freeze([
  Object.freeze({ directory: "packages/dashboard", name: "@workhorse/dashboard" }),
  Object.freeze({ directory: "packages/drizzle", name: "@workhorse/drizzle" }),
  Object.freeze({ directory: "packages/kysely", name: "@workhorse/kysely" }),
  Object.freeze({ directory: "packages/prisma", name: "@workhorse/prisma" }),
  Object.freeze({ directory: "packages/typeorm", name: "@workhorse/typeorm" }),
]);

export const packedPackages: readonly WorkspacePackage[] = Object.freeze([
  Object.freeze({ directory: ".", name: "@workhorse/core" }),
  ...runtimePackages,
]);

export function packageTarballFilename(name: string, version: string): string {
  return `${name.replace("@", "").replace("/", "-")}-${version}.tgz`;
}
