import { getRequestListener, serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMiddleware } from "hono/factory";
import type { WorkhorseAdapter, Queryable, Queue, Worker, WorkerOptions } from "@workhorse/core";

export interface HonoWorkhorseContext<TTransaction> {
  readonly queue: Queue;
  forTransaction(transaction: TTransaction): Queue;
}

export type HonoWorkhorseEnv<TTransaction> = {
  Variables: {
    workhorse: HonoWorkhorseContext<TTransaction>;
  };
};

export interface HonoWorkerDefinition {
  options?: WorkerOptions;
  configure(worker: Worker): void;
}

export interface HonoWorkhorseOptions {
  workers?: readonly HonoWorkerDefinition[];
  onWorkerError?: (error: unknown, worker: Worker) => void;
}

/** Owns Workhorse worker startup and shutdown for one Hono application process. */
export class HonoWorkhorse<TTransaction> {
  readonly database: Queryable;
  readonly context: HonoWorkhorseContext<TTransaction>;
  private readonly workers: Worker[] = [];
  private readonly runs: Promise<void>[] = [];
  private started = false;
  private quiescePromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly adapter: WorkhorseAdapter<TTransaction>,
    private readonly options: HonoWorkhorseOptions = {},
  ) {
    this.database = adapter.database;
    this.context = {
      queue: adapter.queue,
      forTransaction: (transaction) => adapter.forTransaction(transaction),
    };
  }

  /** Typed middleware that exposes `c.var.workhorse` to routes. */
  middleware() {
    return createMiddleware<HonoWorkhorseEnv<TTransaction>>(async (context, next) => {
      context.set("workhorse", this.context);
      await next();
    });
  }

  /** Start every configured worker once. Worker loops run in the background. */
  start(): void {
    if (this.started) return;
    if (this.quiescePromise || this.closePromise) {
      throw new Error("A stopped HonoWorkhorse runtime cannot be restarted");
    }
    this.started = true;

    for (const definition of this.options.workers ?? []) {
      const worker = this.adapter.createWorker(definition.options);
      definition.configure(worker);
      this.workers.push(worker);
      this.runs.push(
        worker.run().catch((error: unknown) => {
          this.options.onWorkerError?.(error, worker);
        }),
      );
    }
  }

  /** Stop new claims and wait for every in-flight handler to finish. */
  quiesce(): Promise<void> {
    this.quiescePromise ??= (async () => {
      for (const worker of this.workers) worker.stop();
      await Promise.all(this.runs);
    })();
    return this.quiescePromise;
  }

  /** Quiesce workers, then close provider-owned resources. This method is idempotent. */
  stop(): Promise<void> {
    this.closePromise ??= (async () => {
      try {
        await this.quiesce();
      } finally {
        await this.adapter.close();
      }
    })();
    return this.closePromise;
  }
}

type NodeServeOptions = Parameters<typeof serve>[0];

export type ServeWithWorkhorseOptions<TTransaction> = Omit<NodeServeOptions, "fetch"> & {
  fetch: NodeServeOptions["fetch"];
  workhorse: HonoWorkhorse<TTransaction>;
  onListen?: Parameters<typeof serve>[1];
  /**
   * Connect-style middleware to run before the Hono application.
   *
   * The intended use is a development bundler such as `@workhorse/dashboard/dev`, which needs to
   * own its module and hot-reload routes while everything it does not recognize falls through to
   * the application. It calls `next()` for unowned requests, so ordinary routing is unaffected.
   */
  nodeMiddleware?: (
    request: IncomingMessage,
    response: ServerResponse,
    next: (error?: unknown) => void,
  ) => void;
};

export interface HonoWorkhorseServer {
  readonly server: ServerType;
  shutdown(): Promise<void>;
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Start Hono and Workhorse together and return one idempotent graceful-shutdown handle. */
export async function serveWithWorkhorse<TTransaction>(
  options: ServeWithWorkhorseOptions<TTransaction>,
): Promise<HonoWorkhorseServer> {
  const { workhorse, onListen, nodeMiddleware, ...serverOptions } = options;
  const fetchHandler = serverOptions.fetch;

  let server: ServerType;
  try {
    workhorse.start();
    if (nodeMiddleware) {
      // Build the listener directly rather than letting `serve` own it, so the middleware runs
      // first and Hono becomes its `next`. The bundler answers only what it owns, and the
      // application keeps every route it already had.
      const application = getRequestListener(fetchHandler);
      const httpServer = createServer((request, response) => {
        nodeMiddleware(request, response, (error) => {
          if (error) {
            response.statusCode = 500;
            response.end("Internal Server Error");
            return;
          }
          application(request, response);
        });
      });
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(serverOptions.port, serverOptions.hostname, () => {
          httpServer.removeListener("error", reject);
          resolve();
        });
      });
      server = httpServer as unknown as ServerType;
      onListen?.(httpServer.address() as never);
    } else {
      server = serve(serverOptions as NodeServeOptions, onListen);
    }
  } catch (error) {
    await workhorse.stop();
    throw error;
  }

  let shutdownPromise: Promise<void> | undefined;
  return {
    server,
    shutdown() {
      shutdownPromise ??= (async () => {
        const serverClosed = closeServer(server);
        await workhorse.quiesce();
        await serverClosed;
        await workhorse.stop();
      })();
      return shutdownPromise;
    },
  };
}

export { mountWorkhorseDashboard } from "./dashboard.js";
export type { MountWorkhorseDashboardOptions } from "./dashboard.js";
