import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

interface Support {
  /** `prerelease` lists the releases that have not shipped. CI tests each at its newest preview. */
  readonly dotnet: { readonly tested: readonly number[]; readonly prerelease?: readonly number[] };
  readonly go: { readonly minimum: string };
  readonly java: { readonly tested: readonly number[] };
  readonly node: { readonly tested: readonly number[] };
  readonly postgres: { readonly tested: readonly number[] };
  readonly python: { readonly tested: readonly string[] };
  readonly ruby: { readonly tested: readonly string[] };
}

/** The development toolchains of support.json, which mise.toml pins too. */
interface Toolchains {
  readonly go: string;
}

interface Matrix<T> {
  readonly include: readonly T[];
}

export const WEEKLY_COMPATIBILITY_SCHEDULE = "17 4 * * 0";

/**
 * Where a .NET lane gets its runtime. `sdk` is the runtime that the SDK of mise.toml carries. `ga`
 * and `preview` name the quality that the lane installs beside that SDK, and the tests roll forward
 * to it.
 */
type DotnetRuntime = "sdk" | "ga" | "preview";

/**
 * The .NET releases that CI tests, oldest first (ADR 0107, "Floors"). Each package targets the
 * floor. The SDK of mise.toml builds the packages and carries the runtime of the floor, so the floor
 * lane runs on it. A later release that has shipped installs its newest release runtime, and a
 * release in `prerelease` installs its newest preview runtime.
 */
function dotnetReleases(
  dotnet: Support["dotnet"],
): { readonly dotnet: number; readonly runtime: DotnetRuntime }[] {
  return dotnet.tested.map((release, index) => ({
    dotnet: release,
    runtime: index === 0 ? "sdk" : dotnet.prerelease?.includes(release) ? "preview" : "ga",
  }));
}

export interface CiMatrices {
  readonly typescript: Matrix<{ readonly node: number; readonly postgres: number }>;
  readonly python: Matrix<{ readonly python: string; readonly postgres: number }>;
  readonly go: Matrix<{ readonly go: string; readonly postgres: number }>;
  readonly rust: Matrix<{ readonly postgres: number }>;
  readonly ruby: Matrix<{ readonly ruby: string; readonly postgres: number }>;
  readonly jvm: Matrix<{ readonly java: number; readonly postgres: number }>;
  readonly dotnet: Matrix<{
    readonly dotnet: number;
    readonly runtime: DotnetRuntime;
    readonly postgres: number;
  }>;
  readonly packed: Matrix<{ readonly node: number }>;
}

function crossProduct<AKey extends string, A, BKey extends string, B>(
  aKey: AKey,
  aValues: readonly A[],
  bKey: BKey,
  bValues: readonly B[],
): Array<Record<AKey, A> & Record<BKey, B>> {
  return aValues.flatMap((aValue) =>
    bValues.map(
      (bValue) => ({ [aKey]: aValue, [bKey]: bValue }) as Record<AKey, A> & Record<BKey, B>,
    ),
  );
}

/**
 * The Go releases of a weekly run, floor first: the floor of support.json, and the development
 * compiler that mise.toml pins. setup-go sets GOTOOLCHAIN=local, so each lane compiles with the
 * release it installs, and only this lane runs the suite on the development compiler.
 */
function goReleases(support: Support, toolchains: Toolchains): string[] {
  const floor = support.go.minimum.replace(/\.0$/, "");
  return toolchains.go === support.go.minimum || toolchains.go === floor
    ? [floor]
    : [floor, toolchains.go];
}

export function buildCiMatrices(
  { support, toolchains }: { readonly support: Support; readonly toolchains: Toolchains },
  eventName: string,
  schedule = "",
): CiMatrices {
  const [goFloor, ...laterGo] = goReleases(support, toolchains);
  const oldestJava = support.java.tested[0];
  const newestJava = support.java.tested.at(-1);
  const newestNode = support.node.tested.at(-1);
  const newestPostgres = support.postgres.tested.at(-1);
  const newestPython = support.python.tested.at(-1);
  const newestRuby = support.ruby.tested.at(-1);
  const dotnet = dotnetReleases(support.dotnet);
  if (
    dotnet.length === 0 ||
    oldestJava === undefined ||
    newestJava === undefined ||
    newestNode === undefined ||
    newestPostgres === undefined ||
    newestPython === undefined ||
    newestRuby === undefined ||
    goFloor === undefined
  )
    throw new Error("CI support lists cannot be empty");

  if (eventName !== "schedule" || schedule !== WEEKLY_COMPATIBILITY_SCHEDULE) {
    return {
      typescript: {
        include: [{ node: newestNode, postgres: newestPostgres }],
      },
      python: {
        include: [{ python: newestPython, postgres: newestPostgres }],
      },
      go: {
        include: [{ go: goFloor, postgres: newestPostgres }],
      },
      rust: { include: [{ postgres: newestPostgres }] },
      ruby: { include: [{ ruby: newestRuby, postgres: newestPostgres }] },
      // A change runs the Java floor and the newest release (ADR 0103, "Floors").
      jvm: {
        include: [oldestJava, newestJava].map((java) => ({ java, postgres: newestPostgres })),
      },
      // A change runs every .NET release that CI tests (ADR 0107, "Floors").
      dotnet: {
        include: dotnet.map((release) => ({ ...release, postgres: newestPostgres })),
      },
      packed: { include: [{ node: newestNode }] },
    };
  }

  return {
    typescript: {
      include: crossProduct("node", support.node.tested, "postgres", support.postgres.tested),
    },
    python: {
      include: crossProduct("python", support.python.tested, "postgres", support.postgres.tested),
    },
    // The floor against every PostgreSQL, and the development compiler against the newest.
    go: {
      include: [
        ...support.postgres.tested.map((postgres) => ({ go: goFloor, postgres })),
        ...laterGo.map((go) => ({ go, postgres: newestPostgres })),
      ],
    },
    rust: { include: support.postgres.tested.map((postgres) => ({ postgres })) },
    ruby: {
      include: crossProduct("ruby", support.ruby.tested, "postgres", support.postgres.tested),
    },
    jvm: {
      include: crossProduct("java", support.java.tested, "postgres", support.postgres.tested),
    },
    dotnet: {
      include: dotnet.flatMap((release) =>
        support.postgres.tested.map((postgres) => ({ ...release, postgres })),
      ),
    },
    packed: { include: [{ node: newestNode }] },
  };
}

async function main(): Promise<void> {
  const eventName = process.argv[2];
  if (!eventName) throw new Error("Usage: scripts/ci-matrix.ts <event-name>");

  const manifest = JSON.parse(
    await readFile(new URL("../support.json", import.meta.url), "utf8"),
  ) as {
    readonly support: Support;
    readonly toolchains: Toolchains;
  };
  const matrices = buildCiMatrices(manifest, eventName, process.argv[3]);
  for (const [name, matrix] of Object.entries(matrices)) {
    process.stdout.write(`${name}=${JSON.stringify(matrix)}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
