import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";

interface OutputChunkLike {
  readonly type: "chunk";
  readonly modules: Readonly<Record<string, unknown>>;
}

interface OutputAssetLike {
  readonly type: "asset";
}

type OutputBundleLike = Readonly<Record<string, OutputChunkLike | OutputAssetLike>>;

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly license?: string;
  readonly homepage?: string;
  readonly repository?: string | { readonly url?: string };
}

interface RuntimePackage {
  readonly root: string;
  readonly manifest: PackageManifest;
}

const noticeName = "THIRD_PARTY_NOTICES.txt";
const legalFilePattern = /^(?:licen[cs]e|copying|notice)(?:\..+)?$/i;
const repositoryRoot = path.resolve(import.meta.dirname, "../..");

function sorted<T>(values: readonly T[], compare?: (left: T, right: T) => number): T[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 target lacks Array#toSorted().
  return [...values].sort(compare);
}

function modulePaths(bundle: OutputBundleLike): readonly string[] {
  return Object.values(bundle).flatMap((output) =>
    output.type === "chunk" ? Object.keys(output.modules) : [],
  );
}

async function packageForModule(moduleId: string): Promise<RuntimePackage | undefined> {
  const cleanId = moduleId.split("?", 1)[0]!;
  if (cleanId.startsWith("\0") || !cleanId.includes(`${path.sep}node_modules${path.sep}`)) {
    return undefined;
  }

  let directory = path.dirname(cleanId);
  for (;;) {
    const manifestPath = path.join(directory, "package.json");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
      if (manifest.name && manifest.version) return { root: directory, manifest };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function repositoryUrl(manifest: PackageManifest): string | undefined {
  const repository = manifest.repository;
  if (typeof repository === "string") return repository;
  return repository?.url ?? manifest.homepage;
}

async function legalFiles(
  packageRoot: string,
  manifest: PackageManifest,
): Promise<readonly [string, string][]> {
  let source = packageRoot;
  let names = sorted((await readdir(source)).filter((name) => legalFilePattern.test(name)));
  if (names.length === 0) {
    const key = `${manifest.name!.replaceAll("/", "+")}@${manifest.version}`;
    source = path.join(repositoryRoot, "dashboard/app/third-party-legal", key);
    names = sorted(
      (await readdir(source).catch(() => [])).filter((name) => legalFilePattern.test(name)),
    );
  }
  if (names.length === 0) {
    throw new Error(
      `${manifest.name}@${manifest.version} contains no licence or reviewed override`,
    );
  }
  return Promise.all(
    names.map(async (name) => [name, (await readFile(path.join(source, name), "utf8")).trim()]),
  );
}

export async function createDashboardThirdPartyNotices(bundle: OutputBundleLike): Promise<string> {
  const packages = (
    await Promise.all([...new Set(modulePaths(bundle))].map((id) => packageForModule(id)))
  ).filter((entry): entry is RuntimePackage => entry !== undefined);
  const uniquePackages = new Map(
    packages.map((entry) => [`${entry.manifest.name}@${entry.manifest.version}`, entry]),
  );
  const sortedPackages = sorted([...uniquePackages.values()], (left, right) =>
    `${left.manifest.name}@${left.manifest.version}`.localeCompare(
      `${right.manifest.name}@${right.manifest.version}`,
    ),
  );

  const sections = await Promise.all(
    sortedPackages.map(async ({ root, manifest }) => {
      if (!manifest.license)
        throw new Error(`${manifest.name}@${manifest.version} declares no licence`);
      const source = repositoryUrl(manifest);
      const metadata = [
        `${manifest.name}@${manifest.version}`,
        `Licence: ${manifest.license}`,
        ...(source ? [`Source: ${source}`] : []),
      ];
      const texts = (await legalFiles(root, manifest)).map(
        ([name, content]) => `${name}\n\n${content}`,
      );
      return [...metadata, "", ...texts].join("\n");
    }),
  );

  return [
    "Workhorse dashboard third-party notices",
    "",
    "This file is generated from the modules in the production dashboard bundle.",
    "Run `pnpm dashboard-bundle:generate` after changing dashboard dependencies.",
    "Review every dependency, licence expression, and included legal text before release.",
    "",
    ...sections.flatMap((section) => ["=".repeat(80), section, ""]),
  ].join("\n");
}

export function dashboardThirdPartyNotices(): Plugin {
  return {
    name: "workhorse-dashboard-third-party-notices",
    apply: "build",
    async generateBundle(_options, bundle) {
      this.emitFile({
        type: "asset",
        fileName: noticeName,
        source: await createDashboardThirdPartyNotices(bundle),
      });
    },
  };
}
