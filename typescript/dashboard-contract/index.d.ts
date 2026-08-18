/** Optional single-administrator authentication for the standalone listener. */
export interface DashboardSingleAdminOptions {
  username: string;
  /** Versioned password hash; plaintext passwords are never accepted as server configuration. */
  passwordHash: string;
  /** Previous password hash accepted only until `previousPasswordHashExpiresAt`. */
  previousPasswordHash?: string;
  /** Absolute ISO 8601 cutoff for the previous password and sessions created with it. */
  previousPasswordHashExpiresAt?: string;
  /** Session lifetime in seconds. Defaults to eight hours. */
  sessionTtlSeconds?: number;
}

/** Options accepted by the standalone dashboard process owned by the Workhorse CLI. */
export interface DashboardCommandOptions {
  port: number;
  /** Interface to bind. Defaults to loopback so the console is not published by accident. */
  hostname: string;
  /** Unix socket path. When present, the listener ignores `hostname` and `port`. */
  socketPath?: string;
  /** External origin used behind a proxy. Remote authenticated listeners require HTTPS. */
  publicOrigin?: string;
  /** Enables operator mutations. Off by default; a standalone server has nobody to delegate to. */
  allowMutations: boolean;
  /** Server-owned attribution for the explicit unauthenticated loopback development bypass. */
  actor: string;
  /** Omit only for an explicit local development bypass. */
  authentication?: DashboardSingleAdminOptions;
}

/** A standalone dashboard listener whose database connection remains owned by its caller. */
export interface RunningDashboard {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * The databases a standalone dashboard serves: one anonymous database, or named workspaces the
 * served application can switch between. A workspace map is distinguished from a bare database
 * capability by its `workspaces` key, which no database driver exposes.
 */
export type DashboardStandaloneTarget<Database> =
  | Database
  | {
      workspaces: Readonly<Record<string, Database>>;
      /** Workspace served at the root path. Defaults to the first configured workspace. */
      defaultWorkspace?: string;
    };

/**
 * The dashboard package entry point loaded by `workhorse dashboard`.
 *
 * The dependency-free interface lets core and dashboard compile against one definition without
 * either package copying the other's types. The caller supplies a database capability, the
 * dashboard owns HTTP, and closing the dashboard never closes the database connection.
 */
export interface DashboardStandaloneModule<Database> {
  startDashboardServer(
    database: DashboardStandaloneTarget<Database>,
    options: DashboardCommandOptions,
  ): Promise<RunningDashboard>;
}
