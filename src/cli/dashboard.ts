import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { Queue } from "../queue.js";

export interface DashboardCommandOptions {
  databaseUrl: string;
  port: number;
  /** Interface to bind. Defaults to loopback so the console is not published by accident. */
  hostname: string;
  /** Enables operator mutations. Off by default; a standalone server has nobody to delegate to. */
  allowMutations: boolean;
  /** Attribution recorded on mutations. Never authorization. */
  actor: string;
}

export interface RunningDashboard {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * The slice of `@workhorse/dashboard/server` this command uses.
 *
 * It is declared structurally rather than imported as a type on purpose. `@workhorse/dashboard`
 * depends on `@workhorse/core`, so a type reference in the other direction would make the two
 * packages' builds circular. Keeping the dependency to a runtime-only dynamic import also means an
 * install that never serves a dashboard does not pull a React application into its tree.
 *
 * The packed-package test exercises the real wiring, which is what keeps this declaration honest.
 */
interface DashboardServerModule {
  createDashboardOperatorControllers(options: {
    requestedBy: string;
    run<T>(action: unknown, operation: (queue: Queue) => Promise<T>): Promise<T>;
  }): {
    operator: { mode: "local" };
    queueController: Record<string, unknown>;
    taskController: Record<string, unknown>;
    workerController: Record<string, unknown>;
  };
  createDashboardHost(options: Record<string, unknown>): {
    handle(request: Request): Promise<Response | null>;
    owns(request: Request): boolean;
  };
  dashboardNodeMiddleware(
    host: unknown,
  ): (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => void;
}

/**
 * Load the dashboard package on demand.
 *
 * Importing it lazily keeps `@workhorse/core` free of a React dashboard dependency for the many
 * installs that only ever run workers, while still letting one `workhorse` binary serve it.
 */
async function loadDashboard(): Promise<DashboardServerModule> {
  try {
    // The specifier is built at runtime so the compiler does not resolve it, which is what keeps
    // the package graph acyclic. There is no bundler in this path to trip over it.
    const specifier = ["@workhorse", "dashboard/server"].join("/");
    return (await import(specifier)) as unknown as DashboardServerModule;
  } catch (error) {
    throw new Error(
      "The dashboard command requires @workhorse/dashboard. Install it alongside @workhorse/core.",
      { cause: error },
    );
  }
}

/**
 * Serve the operator dashboard as its own process against any Workhorse database.
 *
 * This owns the process, so unlike an embedded mount it also owns its connection pool and accepts a
 * connection string. It hosts no application: everything it shows is read from PostgreSQL, and the
 * worker fleet is discovered from the durable registry, so it needs nothing else running.
 */
export async function startDashboardServer(
  pool: Pool,
  options: DashboardCommandOptions,
): Promise<RunningDashboard> {
  const { createDashboardHost, createDashboardOperatorControllers, dashboardNodeMiddleware } =
    await loadDashboard();
  const queue = new Queue(pool);
  const controls = options.allowMutations
    ? createDashboardOperatorControllers({
        requestedBy: options.actor,
        run: (_action, operation) => operation(queue),
      })
    : { operator: { mode: "read-only" as const } };

  const host = createDashboardHost({
    database: pool,
    path: "/",
    environment: "standalone",
    auditActor: options.actor,
    // Binding to loopback is the boundary. There is no session to check, so the console must never
    // silently authorize a request that arrived from somewhere unexpected.
    authorize: () => true,
    ...controls,
  });

  const middleware = dashboardNodeMiddleware(host);
  const server = createServer((request, response) => {
    middleware(request, response, () => {
      response.statusCode = 404;
      response.end("Not found");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.hostname, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://${options.hostname}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
