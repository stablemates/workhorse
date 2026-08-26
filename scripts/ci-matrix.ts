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

export interface CiMatrices {
  readonly typescript: Matrix<{ readonly node: number; readonly postgres: number }>;
  readonly python: Matrix<{ readonly python: string; readonly postgres: number }>;
  readonly go: Matrix<{ readonly go: string; readonly postgres: number }>;
  readonly packed: Matrix<{ readonly node: number }>;
}

function bounds<T>(values: readonly T[]): readonly [T, T] {
  const first = values[0];
  const last = values.at(-1);
  if (first === undefined || last === undefined)
    throw new Error("CI support lists cannot be empty");
  return [first, last];
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

export function buildCiMatrices(support: Support, eventName: string): CiMatrices {
  const goVersion = support.go.minimum.replace(/\.0$/, "");

  if (eventName === "pull_request") {
    const [oldestNode, newestNode] = bounds(support.node.tested);
    const [oldestPostgres, newestPostgres] = bounds(support.postgres.tested);
    const [oldestPython, newestPython] = bounds(support.python.tested);

    return {
      typescript: {
        include: [
          { node: oldestNode, postgres: oldestPostgres },
          { node: newestNode, postgres: newestPostgres },
        ],
      },
      python: {
        include: [
          { python: oldestPython, postgres: oldestPostgres },
          { python: newestPython, postgres: newestPostgres },
        ],
      },
      go: {
        include: [{ go: goVersion, postgres: newestPostgres }],
      },
      packed: { include: [{ node: oldestNode }] },
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
    packed: { include: support.node.tested.map((node) => ({ node })) },
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
  const matrices = buildCiMatrices(manifest.support, eventName);
  for (const [name, matrix] of Object.entries(matrices)) {
    process.stdout.write(`${name}=${JSON.stringify(matrix)}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
