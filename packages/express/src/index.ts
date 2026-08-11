import { createServer, type Server } from "node:http";
import type { Application, Request, RequestHandler } from "express";
import {
  WorkhorseRuntime,
  type WorkhorseAdapter,
  type WorkhorseRuntimeContext,
  type WorkhorseRuntimeOptions,
  type WorkhorseRuntimeWorkerDefinition,
} from "@workhorse/core";

export type ExpressWorkhorseContext<TTransaction> = WorkhorseRuntimeContext<TTransaction>;

declare global {
  namespace Express {
    interface Request {
      workhorse: ExpressWorkhorseContext<never>;
    }
  }
}

export type ExpressWorkerDefinition = WorkhorseRuntimeWorkerDefinition;
export type ExpressWorkhorseOptions = WorkhorseRuntimeOptions;

/** Owns Workhorse worker startup and shutdown for one Express application process. */
export class ExpressWorkhorse<TTransaction> extends WorkhorseRuntime<TTransaction> {
  constructor(adapter: WorkhorseAdapter<TTransaction>, options: ExpressWorkhorseOptions = {}) {
    super(adapter, options, "ExpressWorkhorse");
  }

  /** Middleware that exposes `request.workhorse` to later handlers. */
  middleware(): RequestHandler {
    return (request, _response, next) => {
      request.workhorse = this.context as ExpressWorkhorseContext<never>;
      next();
    };
  }

  /** Recover the adapter's transaction type after Express's global request augmentation. */
  contextFor(_request: Request): ExpressWorkhorseContext<TTransaction> {
    return this.context;
  }
}

export interface ServeWithWorkhorseOptions<TTransaction> {
  app: Application;
  workhorse: ExpressWorkhorse<TTransaction>;
  port?: number;
  hostname?: string;
}

export interface ExpressWorkhorseServer {
  readonly server: Server;
  shutdown(): Promise<void>;
}

function listen(server: Server, port: number, hostname?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Start Express and Workhorse together and return one idempotent graceful-shutdown handle. */
export async function serveWithWorkhorse<TTransaction>(
  options: ServeWithWorkhorseOptions<TTransaction>,
): Promise<ExpressWorkhorseServer> {
  const server = createServer(options.app);
  try {
    options.workhorse.start();
    await listen(server, options.port ?? 3000, options.hostname);
  } catch (error) {
    await options.workhorse.stop();
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
        const drains = await Promise.allSettled([options.workhorse.quiesce(), serverClosed]);
        for (const drain of drains) {
          if (drain.status === "rejected" && !failed) {
            failure = drain.reason;
            failed = true;
          }
        }
        try {
          await options.workhorse.stop();
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
