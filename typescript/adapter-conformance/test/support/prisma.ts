import { createRequire } from "node:module";
import { PrismaPg } from "@prisma/adapter-pg";
import type { PrismaClient as Prisma7Client } from "@prisma/client";
import type { PrismaExecutor } from "@stablemates/workhorse-prisma";

/** The part of a Prisma 6 or Prisma 7 client that the conformance tests use. */
interface PrismaTestClient extends PrismaExecutor {
  $disconnect(): Promise<void>;
  $transaction<T>(
    run: (
      transaction: PrismaExecutor & {
        $executeRawUnsafe(statement: string, ...values: unknown[]): Promise<unknown>;
      },
    ) => Promise<T>,
  ): Promise<T>;
}

/** One Prisma major that `@stablemates/workhorse-prisma` claims in its peer range. */
export interface PrismaMajor {
  /** The provider name in task types and probe rows. */
  name: "Prisma6" | "Prisma7";
  /** Open a client with at most `max` connections. */
  createClient(databaseUrl: string, max?: number): PrismaTestClient;
}

// Each package generates the client of its own Prisma major in its `prepare` script. This
// package installs Prisma 7. typescript/prisma installs Prisma 6, so its resolution gives the
// Prisma 6 client.
const { PrismaClient: Prisma7 } = createRequire(import.meta.url)("@prisma/client") as {
  PrismaClient: typeof Prisma7Client;
};
const { PrismaClient: Prisma6 } = createRequire(
  new URL("../../../prisma/package.json", import.meta.url),
)("@prisma/client") as { PrismaClient: new (options: unknown) => PrismaTestClient };

export const prismaMajors: readonly PrismaMajor[] = [
  {
    name: "Prisma6",
    createClient(databaseUrl, max) {
      const url = new URL(databaseUrl);
      if (max !== undefined) url.searchParams.set("connection_limit", String(max));
      return new Prisma6({ datasources: { db: { url: url.toString() } } });
    },
  },
  {
    name: "Prisma7",
    // Prisma 7 has no `datasources` option and no `connection_limit` parameter. The driver
    // adapter owns the connection pool, so `max` sizes that pool. The generated client type is
    // returned as it is, so the typecheck proves that it satisfies `PrismaExecutor`.
    createClient(connectionString, max) {
      const client: Prisma7Client = new Prisma7({
        adapter: new PrismaPg({ connectionString, max }),
      });
      return client;
    },
  },
];
