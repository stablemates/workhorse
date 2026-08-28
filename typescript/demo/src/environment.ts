const defaultDemoDatabaseUrl =
  "postgresql://workhorse:workhorse@localhost:5432/workhorse_dev_primary";

export function resolveDemoDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.DATABASE_URL_PRIMARY ?? defaultDemoDatabaseUrl;
}

export interface DemoSchemaTarget {
  name: "production" | "staging";
  url: string;
}

/** Every configured demo database that the container must prepare before application startup. */
export function resolveDemoSchemaTargets(
  environment: NodeJS.ProcessEnv = process.env,
): readonly DemoSchemaTarget[] {
  const targets: DemoSchemaTarget[] = [
    { name: "production", url: resolveDemoDatabaseUrl(environment) },
  ];
  if (environment.DATABASE_URL_SECONDARY) {
    targets.push({ name: "staging", url: environment.DATABASE_URL_SECONDARY });
  }
  return targets;
}

/**
 * Display-only host label for a PostgreSQL URL: `hostname[:port]`, or the socket directory from
 * the `host` query parameter when the URL names no network host (the deployed demo connects
 * through a mounted unix socket). Undefined when the URL does not parse.
 */
export function demoDatabaseHostLabel(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.hostname) {
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  }
  return parsed.searchParams.get("host") ?? undefined;
}

/** Display-only database name from a PostgreSQL URL's path. Undefined when absent or unparsable. */
export function demoDatabaseNameLabel(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const name = parsed.pathname.replace(/^\//, "");
  return name === "" ? undefined : decodeURIComponent(name);
}
