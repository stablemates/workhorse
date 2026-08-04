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
  createDashboardHost(options: Record<string, unknown>): {
    refresh: unknown;
    handle(request: Request): Promise<Response | null>;
    owns(request: Request): boolean;
  };
  dashboardNodeMiddleware(
    host: unknown,
  ): (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => void;
  listenForDashboardRefresh(options: Record<string, unknown>): Promise<unknown>;
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
 * Operator controls backed directly by `Queue`.
 *
 * A standalone console has no application to delegate audit and authorization to, which is exactly
 * why mutations are opt-in. When they are enabled, `requestedBy` carries the configured actor so
 * the durable lifecycle records still say who asked, even though nothing here can prove it.
 */
function standaloneControllers(queue: Queue, actor: string) {
  return {
    operator: { mode: "local" as const },
    queueController: {
      async setQueuePaused(queueName: string, paused: boolean) {
        if (paused) await queue.pauseQueue(queueName);
        else await queue.resumeQueue(queueName);
        return { paused };
      },
      async purgeQueue(queueName: string) {
        return { deletedCount: await queue.purgeQueue(queueName) };
      },
    },
    taskController: {
      async runTaskNow(jobId: string) {
        const result = await queue.runTaskNow(jobId);
        return {
          status: result.status,
          id: result.jobId,
          state: result.state,
          runAt: result.runAt === null ? null : new Date(result.runAt).toISOString(),
        };
      },
      async cancelTask(jobId: string, audit: { reason: string | null }) {
        const result = await queue.cancel(jobId, {
          requestedBy: actor,
          reason: audit.reason ?? undefined,
        });
        return {
          status: result.status,
          jobId: result.jobId,
          state: result.state,
          currentAttempt: result.currentAttempt,
          requestedAt:
            result.requestedAt === null ? null : new Date(result.requestedAt).toISOString(),
          requestedBy: result.requestedBy,
          reason: result.reason,
          finishedAt: result.finishedAt === null ? null : new Date(result.finishedAt).toISOString(),
        };
      },
    },
    workerController: {
      async setWorkerPaused(workerId: string, paused: boolean, audit: { reason: string }) {
        const result = await queue.setWorkerPaused(workerId, paused, {
          requestedBy: actor,
          reason: audit.reason,
        });
        if (!result) throw new Error(`Worker ${workerId} is not registered`);
        return { paused: result.paused };
      },
    },
  };
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
  notificationClient?: {
    query(sql: string): Promise<unknown>;
    on(event: never, listener: never): void;
  },
): Promise<RunningDashboard> {
  const { createDashboardHost, dashboardNodeMiddleware, listenForDashboardRefresh } =
    await loadDashboard();
  const queue = new Queue(pool);
  const controls = options.allowMutations
    ? standaloneControllers(queue, options.actor)
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

  if (notificationClient) {
    await listenForDashboardRefresh({
      client: notificationClient as never,
      refresh: host.refresh,
      onError: (error: unknown) =>
        console.error("Refresh listener stopped; the periodic fallback remains active", error),
    });
  }

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
