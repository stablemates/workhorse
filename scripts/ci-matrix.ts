import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

interface Support {
  readonly go: { readonly minimum: string };
  readonly java: { readonly tested: readonly number[] };
  readonly node: { readonly tested: readonly number[] };
  readonly postgres: { readonly tested: readonly number[] };
  readonly python: { readonly tested: readonly string[] };
  readonly ruby: { readonly tested: readonly string[] };
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
export type DotnetRuntime = "sdk" | "ga" | "preview";

/**
 * The .NET releases that CI tests, oldest first (ADR 0107, "Floors"). Each package targets
 * `net10.0`. The SDK of mise.toml builds the packages and carries the .NET 10 runtime. .NET 11 is
 * at a release candidate until it ships, so its lane installs the newest preview runtime. SM-1627
 * moves this list to support.json.
 */
export const DOTNET_TESTED: readonly {
  readonly dotnet: number;
  readonly runtime: DotnetRuntime;
}[] = [
  { dotnet: 10, runtime: "sdk" },
  { dotnet: 11, runtime: "preview" },
];

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

export function buildCiMatrices(support: Support, eventName: string, schedule = ""): CiMatrices {
  const goVersion = support.go.minimum.replace(/\.0$/, "");
  const oldestJava = support.java.tested[0];
  const newestJava = support.java.tested.at(-1);
  const newestNode = support.node.tested.at(-1);
  const newestPostgres = support.postgres.tested.at(-1);
  const newestPython = support.python.tested.at(-1);
  const newestRuby = support.ruby.tested.at(-1);
  if (
    oldestJava === undefined ||
    newestJava === undefined ||
    newestNode === undefined ||
    newestPostgres === undefined ||
    newestPython === undefined ||
    newestRuby === undefined
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
        include: [{ go: goVersion, postgres: newestPostgres }],
      },
      rust: { include: [{ postgres: newestPostgres }] },
      ruby: { include: [{ ruby: newestRuby, postgres: newestPostgres }] },
      // A change runs the Java floor and the newest release (ADR 0103, "Floors").
      jvm: {
        include: [oldestJava, newestJava].map((java) => ({ java, postgres: newestPostgres })),
      },
      // A change runs every .NET release that CI tests (ADR 0107, "Floors").
      dotnet: {
        include: DOTNET_TESTED.map((release) => ({ ...release, postgres: newestPostgres })),
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
    go: {
      include: support.postgres.tested.map((postgres) => ({
        go: goVersion,
        postgres,
      })),
    },
    rust: { include: support.postgres.tested.map((postgres) => ({ postgres })) },
    ruby: {
      include: crossProduct("ruby", support.ruby.tested, "postgres", support.postgres.tested),
    },
    jvm: {
      include: crossProduct("java", support.java.tested, "postgres", support.postgres.tested),
    },
    dotnet: {
      include: DOTNET_TESTED.flatMap((release) =>
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
  };
  const matrices = buildCiMatrices(manifest.support, eventName, process.argv[3]);
  for (const [name, matrix] of Object.entries(matrices)) {
    process.stdout.write(`${name}=${JSON.stringify(matrix)}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
