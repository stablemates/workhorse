/** Options accepted by the standalone dashboard process owned by the Workhorse CLI. */
export interface DashboardCommandOptions {
  port: number;
  /** Interface to bind. Defaults to loopback so the console is not published by accident. */
  hostname: string;
  /** Enables operator mutations. Off by default; a standalone server has nobody to delegate to. */
  allowMutations: boolean;
  /** Attribution recorded on mutations. Never authorization. */
  actor: string;
}

/** A standalone dashboard listener whose database connection remains owned by its caller. */
export interface RunningDashboard {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * The dashboard package entry point loaded by `workhorse dashboard`.
 *
 * The dependency-free interface lets core and dashboard compile against one definition without
 * either package copying the other's types. The caller supplies a database capability, the
 * dashboard owns HTTP, and closing the dashboard never closes the database connection.
 */
export interface DashboardStandaloneModule<Database> {
  startDashboardServer(
    database: Database,
    options: DashboardCommandOptions,
  ): Promise<RunningDashboard>;
}
