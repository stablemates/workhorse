import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { createMiddleware } from "hono/factory";
import type { IronshiftAdapter, Queue, Worker, WorkerOptions } from "ironshift";

export interface HonoIronshiftContext<TTransaction> {
  readonly queue: Queue;
  forTransaction(transaction: TTransaction): Queue;
}

export type HonoIronshiftEnv<TTransaction> = {
  Variables: {
    ironshift: HonoIronshiftContext<TTransaction>;
  };
};

export interface HonoWorkerDefinition {
  options?: WorkerOptions;
  configure(worker: Worker): void;
}

export interface HonoIronshiftOptions {
  workers?: readonly HonoWorkerDefinition[];
  onWorkerError?: (error: unknown, worker: Worker) => void;
}

/** Owns Ironshift worker startup and shutdown for one Hono application process. */
export class HonoIronshift<TTransaction> {
  readonly context: HonoIronshiftContext<TTransaction>;
  private readonly workers: Worker[] = [];
  private readonly runs: Promise<void>[] = [];
  private started = false;
  private quiescePromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly adapter: IronshiftAdapter<TTransaction>,
    private readonly options: HonoIronshiftOptions = {},
  ) {
    this.context = {
      queue: adapter.queue,
      forTransaction: (transaction) => adapter.forTransaction(transaction),
    };
  }

  /** Typed middleware that exposes `c.var.ironshift` to routes. */
  middleware() {
    return createMiddleware<HonoIronshiftEnv<TTransaction>>(async (context, next) => {
      context.set("ironshift", this.context);
      await next();
    });
  }

  /** Start every configured worker once. Worker loops run in the background. */
  start(): void {
    if (this.started) return;
    if (this.quiescePromise || this.closePromise) {
      throw new Error("A stopped HonoIronshift runtime cannot be restarted");
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

export type ServeWithIronshiftOptions<TTransaction> = Omit<NodeServeOptions, "fetch"> & {
  fetch: NodeServeOptions["fetch"];
  ironshift: HonoIronshift<TTransaction>;
  onListen?: Parameters<typeof serve>[1];
};

export interface HonoIronshiftServer {
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

/** Start Hono and Ironshift together and return one idempotent graceful-shutdown handle. */
export async function serveWithIronshift<TTransaction>(
  options: ServeWithIronshiftOptions<TTransaction>,
): Promise<HonoIronshiftServer> {
  const { ironshift, onListen, ...serverOptions } = options;

  let server: ServerType;
  try {
    ironshift.start();
    server = serve(serverOptions as NodeServeOptions, onListen);
  } catch (error) {
    await ironshift.stop();
    throw error;
  }

  let shutdownPromise: Promise<void> | undefined;
  return {
    server,
    shutdown() {
      shutdownPromise ??= (async () => {
        const serverClosed = closeServer(server);
        await ironshift.quiesce();
        await serverClosed;
        await ironshift.stop();
      })();
      return shutdownPromise;
    },
  };
}
