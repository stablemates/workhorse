/** Local database roles used by repository tooling. Application code may still use DATABASE_URL. */
export type LocalDatabasePurpose = "dev" | "test" | "bench" | "demo";

interface LocalDatabaseDefinition {
  /** Environment override dedicated to this database role. */
  environmentVariable: string;
  /** Required database-name suffix, used to prevent destructive cross-purpose commands. */
  suffix: string;
  /** Zero-configuration URL matching the local role documented in the README. */
  defaultUrl: string;
}

const localDatabaseDefinitions: Record<LocalDatabasePurpose, LocalDatabaseDefinition> = {
  dev: {
    environmentVariable: "WORKHORSE_DEV_DATABASE_URL",
    suffix: "_dev",
    defaultUrl: "postgres://workhorse:workhorse@localhost:5432/workhorse_dev",
  },
  test: {
    environmentVariable: "WORKHORSE_TEST_DATABASE_URL",
    suffix: "_test",
    defaultUrl: "postgres://workhorse:workhorse@localhost:5432/workhorse_test",
  },
  bench: {
    environmentVariable: "WORKHORSE_BENCH_DATABASE_URL",
    suffix: "_bench",
    defaultUrl: "postgres://workhorse:workhorse@localhost:5432/workhorse_bench",
  },
  demo: {
    environmentVariable: "WORKHORSE_DEMO_DATABASE_URL",
    suffix: "_demo",
    defaultUrl: "postgres://workhorse:workhorse@localhost:5432/workhorse_demo",
  },
};

/** Resolve a repository-tooling URL without allowing one purpose to inherit another's URL. */
export function localDatabaseUrl(
  purpose: LocalDatabasePurpose,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const definition = localDatabaseDefinitions[purpose];
  return environment[definition.environmentVariable] ?? definition.defaultUrl;
}

/** Decode the database component once so guards and status messages agree on its name. */
export function databaseName(databaseUrl: string): string {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!name) throw new Error("Database URL must include a database name");
  return name;
}

/**
 * Protect destructive tooling from crossing database roles. A custom URL is allowed, but its
 * database name must retain the role suffix so intent remains visible to operators and scripts.
 */
export function assertLocalDatabasePurpose(
  databaseUrl: string,
  purpose: LocalDatabasePurpose,
): void {
  const name = databaseName(databaseUrl);
  const suffix = localDatabaseDefinitions[purpose].suffix;
  if (!name.endsWith(suffix)) {
    throw new Error(
      `Refusing to use database ${JSON.stringify(name)} for ${purpose}: its name must end in ${suffix}`,
    );
  }
}

export function isLocalDatabasePurpose(value: string): value is LocalDatabasePurpose {
  return value === "dev" || value === "test" || value === "bench" || value === "demo";
}
