import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

interface Support {
  readonly go: { readonly minimum: string };
  readonly node: { readonly tested: readonly number[] };
  readonly postgres: { readonly tested: readonly number[] };
  readonly python: { readonly tested: readonly string[] };
}

interface Matrix<T> {
  readonly include: readonly T[];
}

export const WEEKLY_COMPATIBILITY_SCHEDULE = "17 4 * * 0";

/**
 * The Ruby releases the gem supports, per ADR 0075. The gem is unreleased, so they live here
 * rather than in `support.json` until its first release publishes a support policy.
 */
export const RUBY_TESTED = ["3.3", "3.4", "4.0"] as const;

export interface CiMatrices {
  readonly typescript: Matrix<{ readonly node: number; readonly postgres: number }>;
  readonly python: Matrix<{ readonly python: string; readonly postgres: number }>;
  readonly go: Matrix<{ readonly go: string; readonly postgres: number }>;
  readonly rust: Matrix<{ readonly postgres: number }>;
  readonly ruby: Matrix<{ readonly ruby: string; readonly postgres: number }>;
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
  const newestNode = support.node.tested.at(-1);
  const newestPostgres = support.postgres.tested.at(-1);
  const newestPython = support.python.tested.at(-1);
  const newestRuby = RUBY_TESTED.at(-1);
  if (
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
    ruby: { include: crossProduct("ruby", RUBY_TESTED, "postgres", support.postgres.tested) },
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
