const defaultDemoDatabaseUrl = "postgresql://workhorse:workhorse@localhost:5432/workhorse_demo";

export function resolveDemoDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  return (
    environment.WORKHORSE_DEMO_DATABASE_URL ?? environment.DATABASE_URL ?? defaultDemoDatabaseUrl
  );
}
