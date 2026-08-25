const defaultDemoDatabaseUrl =
  "postgresql://workhorse:workhorse@localhost:5432/workhorse_dev_primary";

export function resolveDemoDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.DATABASE_URL_PRIMARY ?? defaultDemoDatabaseUrl;
}
