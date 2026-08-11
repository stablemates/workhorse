import { getRequestListener, serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMiddleware } from "hono/factory";
import {
  WorkhorseRuntime,
  type WorkhorseAdapter,
  type WorkhorseRuntimeContext,
  type WorkhorseRuntimeOptions,
  type WorkhorseRuntimeWorkerDefinition,
} from "@workhorse/core";

export type HonoWorkhorseContext<TTransaction> = WorkhorseRuntimeContext<TTransaction>;

export type HonoWorkhorseEnv<TTransaction> = {
  Variables: {
    workhorse: HonoWorkhorseContext<TTransaction>;
  };
};

export type HonoWorkerDefinition = WorkhorseRuntimeWorkerDefinition;
export type HonoWorkhorseOptions = WorkhorseRuntimeOptions;

/** Owns Workhorse worker startup and shutdown for one Hono application process. */
export class HonoWorkhorse<TTransaction> extends WorkhorseRuntime<TTransaction> {
  constructor(adapter: WorkhorseAdapter<TTransaction>, options: HonoWorkhorseOptions = {}) {
    super(adapter, options, "HonoWorkhorse");
  }

  /** Typed middleware that exposes `c.var.workhorse` to routes. */
  middleware() {
    return createMiddleware<HonoWorkhorseEnv<TTransaction>>(async (context, next) => {
      context.set("workhorse", this.context);
      await next();
    });
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
        let failure: unknown;
        let failed = false;
        const drains = await Promise.allSettled([workhorse.quiesce(), serverClosed]);
        for (const drain of drains) {
          if (drain.status === "rejected" && !failed) {
            failure = drain.reason;
            failed = true;
          }
        }
        try {
          await workhorse.stop();
        } catch (error) {
          if (!failed) {
            failure = error;
            failed = true;
          }
        }
        if (failed) throw failure;
      })();
      return shutdownPromise;
    },
  };
}

export { mountWorkhorseDashboard } from "./dashboard.js";
export type { MountWorkhorseDashboardOptions } from "./dashboard.js";
