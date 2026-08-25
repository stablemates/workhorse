/** Local database roles used by repository tooling. */
export type LocalDatabasePurpose =
  | "dev_primary"
  | "dev_secondary"
  | "test"
  | "bench"
  | "test_packed";

const POSTGRES_IDENTIFIER_LIMIT = 63;

interface LocalDatabaseDefinition {
  /** Environment override dedicated to this database role. */
  environmentVariable: string;
  /** Required database-name suffix, used to prevent destructive cross-purpose commands. */
  suffix: string;
  /** Zero-configuration URL matching the local role documented in the README. */
  defaultUrl: string;
}

const localDatabaseDefinitions: Record<LocalDatabasePurpose, LocalDatabaseDefinition> = {
  dev_primary: {
    environmentVariable: "DATABASE_URL_DEV_PRIMARY",
    suffix: "_dev_primary",
    defaultUrl: "postgres://workhorse:workhorse@localhost:5432/workhorse_dev_primary",
  },
  dev_secondary: {
    environmentVariable: "DATABASE_URL_DEV_SECONDARY",
    suffix: "_dev_secondary",
    defaultUrl: "postgres://workhorse:workhorse@localhost:5432/workhorse_dev_secondary",
  },
  test: {
    environmentVariable: "DATABASE_URL_TEST",
    suffix: "_test",
    defaultUrl: "postgres://workhorse:workhorse@localhost:5432/workhorse_test",
  },
  bench: {
    environmentVariable: "DATABASE_URL_BENCH",
    suffix: "_bench",
    defaultUrl: "postgres://workhorse:workhorse@localhost:5432/workhorse_bench",
  },
  test_packed: {
    environmentVariable: "DATABASE_URL_TEST_PACKED",
    suffix: "_test_packed",
    defaultUrl: "postgres://workhorse:workhorse@localhost:5432/workhorse_test_packed",
  },
};

export const localDatabasePurposes: readonly LocalDatabasePurpose[] = [
  "dev_primary",
  "dev_secondary",
  "test",
  "bench",
  "test_packed",
];

/** Name the environment override dedicated to a role, so tooling never hardcodes the string. */
export function localDatabaseEnvironmentVariable(purpose: LocalDatabasePurpose): string {
  return localDatabaseDefinitions[purpose].environmentVariable;
}

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
  if (!new RegExp(`${suffix}(?:_[a-z0-9][a-z0-9_]*)?$`).test(name)) {
    throw new Error(
      `Refusing to use database ${JSON.stringify(name)} for ${purpose}: its name must end in ${suffix} or ${suffix}_<worktree>`,
    );
  }
}

/** Add a stable, PostgreSQL-safe worktree suffix while preserving the purpose safety marker. */
export function worktreeDatabaseUrl(
  databaseUrl: string,
  purpose: LocalDatabasePurpose,
  worktreeId: string,
): string {
  assertLocalDatabasePurpose(databaseUrl, purpose);

  const url = new URL(databaseUrl);
  const baseName = databaseName(databaseUrl);
  const purposeSuffix = localDatabaseDefinitions[purpose].suffix;
  const basePrefix = baseName.slice(0, -purposeSuffix.length);
  const worktreeSlug = normalizeIdentifier(worktreeId) || "worktree";
  const worktreeHash = hashWorktreeId(worktreeId);
  const suffix = `${purposeSuffix}_${worktreeSlug.slice(0, 24)}_${worktreeHash}`;
  const availablePrefixLength = POSTGRES_IDENTIFIER_LIMIT - suffix.length;
  const prefix = basePrefix.slice(0, availablePrefixLength).replace(/_+$/, "") || "workhorse";

  url.pathname = `/${prefix}${suffix}`;
  return url.toString();
}

export function isLocalDatabasePurpose(value: string): value is LocalDatabasePurpose {
  return (localDatabasePurposes as readonly string[]).includes(value);
}

function normalizeIdentifier(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function hashWorktreeId(value: string): string {
  // FNV-1a is deterministic, dependency-free, and sufficient to avoid collisions between slugs.
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
