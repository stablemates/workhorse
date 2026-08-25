import type { WorkhorseAdapter } from "./adapter.js";
import type { Worker, WorkerOptions } from "./worker.js";
import { createServer } from "node:http";
import type { Server } from "node:http";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;
const SIGNAL_EXIT_CODES: Readonly<Record<WorkerProcessSignal, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

type MaybePromise<T> = T | Promise<T>;

export type WorkerProcessSignal = "SIGINT" | "SIGTERM";

export interface WorkerProcessWorkerDefinition {
  options?: WorkerOptions;
  configure(worker: Worker): void;
}

export interface WorkerProcessLogger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface WorkerProcessProbeOptions {
  /** TCP port for the probe-only HTTP server. Port 0 is allowed for tests and supervisors. */
  port: number;
  /** Defaults to 127.0.0.1. This server does not expose application traffic. */
  hostname?: string;
  /** Defaults to /livez. */
  livenessPath?: string;
  /** Defaults to /readyz. */
  readinessPath?: string;
}

export interface WorkerProcessDefinition<TTransaction = unknown> {
  /** Create resources owned exclusively by this worker process. */
  adapter(): MaybePromise<WorkhorseAdapter<TTransaction>>;
  /** One definition per independently configured Worker instance. */
  workers: readonly WorkerProcessWorkerDefinition[];
  /** Hard-exit deadline after the first termination signal. Defaults to 25 seconds. */
  shutdownTimeoutMs?: number;
  /** Optional probe-only HTTP listener for container orchestrators. */
  probes?: WorkerProcessProbeOptions;
  logger?: WorkerProcessLogger;
}

export interface WorkerProcessSignalSource {
  on(signal: WorkerProcessSignal, listener: () => void): void;
  off(signal: WorkerProcessSignal, listener: () => void): void;
}

export interface RunWorkerProcessOptions {
  /** Override the definition deadline, primarily for deployment-specific grace periods. */
  shutdownTimeoutMs?: number;
  /** Injectable process boundary used by embedders and tests. */
  signalSource?: WorkerProcessSignalSource;
  /** Defaults to process.exit. It must terminate the process in production. */
  forceExit?: (code: number) => void;
}

export interface StartedWorkerProcess {
  readonly workers: readonly Worker[];
  /** Resolved probe URL when a probe server is configured, otherwise null. */
  readonly probeUrl: string | null;
  /** Resolves with the first unexpected worker-loop failure. Pending during ordinary operation. */
  readonly failure: Promise<Error>;
  /** Settles after graceful shutdown or rejects after a worker/runtime failure. */
  readonly completed: Promise<void>;
  /** Stop claims, drain active handlers, and close adapter-owned resources. */
  shutdown(): Promise<void>;
}

/** Type-check a dedicated worker process configuration without changing it. */
export function defineWorkerProcess<TTransaction = unknown>(
  definition: WorkerProcessDefinition<TTransaction>,
): WorkerProcessDefinition<TTransaction> {
  return definition;
}

function validateDefinition(definition: WorkerProcessDefinition): void {
  if (!definition || typeof definition !== "object") {
    throw new Error("Worker process configuration must export a definition object");
  }
  if (typeof definition.adapter !== "function") {
    throw new TypeError("Worker process configuration must define adapter()");
  }
  if (!Array.isArray(definition.workers) || definition.workers.length === 0) {
    throw new Error("Worker process configuration must define at least one worker");
  }
  for (const worker of definition.workers) {
    if (!worker || typeof worker.configure !== "function") {
      throw new Error("Every worker process definition must define configure(worker)");
    }
  }
  validateShutdownTimeout(definition.shutdownTimeoutMs);
  validateProbes(definition.probes);
}

function validateShutdownTimeout(timeoutMs: number | undefined): void {
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000)
  ) {
    throw new Error("shutdownTimeoutMs must be a safe integer between 1 and 3600000");
  }
}

function validateProbes(probes: WorkerProcessProbeOptions | undefined): void {
  if (!probes) return;
  if (!Number.isSafeInteger(probes.port) || probes.port < 0 || probes.port > 65_535) {
    throw new Error("probes.port must be a safe integer between 0 and 65535");
  }
  for (const [name, value] of [
    ["probes.livenessPath", probes.livenessPath],
    ["probes.readinessPath", probes.readinessPath],
  ] as const) {
    if (value !== undefined && (!value.startsWith("/") || value.includes("?"))) {
      throw new Error(`${name} must be an absolute URL path without a query string`);
    }
  }
  const livenessPath = probes.livenessPath ?? "/livez";
  const readinessPath = probes.readinessPath ?? "/readyz";
  if (livenessPath === readinessPath) {
    throw new Error("Probe liveness and readiness paths must be different");
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startProbeServer(
  options: WorkerProcessProbeOptions,
  isReady: () => boolean,
): Promise<{ server: Server; url: string }> {
  const hostname = options.hostname ?? "127.0.0.1";
  const livenessPath = options.livenessPath ?? "/livez";
  const readinessPath = options.readinessPath ?? "/readyz";
  if (livenessPath === readinessPath) {
    throw new Error("Probe liveness and readiness paths must be different");
  }
  const server = createServer((request, response) => {
    const methodAllowed = request.method === "GET" || request.method === "HEAD";
    const path = request.url?.split("?", 1)[0];
    if (!methodAllowed || (path !== livenessPath && path !== readinessPath)) {
      response.writeHead(404).end();
      return;
    }
    const ready = path === livenessPath || isReady();
    response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    if (request.method === "HEAD") response.end();
    else response.end(JSON.stringify({ status: ready ? "ok" : "draining" }));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, hostname);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Probe server did not expose a TCP address");
  }
  const displayHostname = hostname.includes(":") ? `[${hostname}]` : hostname;
  return { server, url: `http://${displayHostname}:${address.port}` };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Start configured workers without installing global signal handlers.
 *
 * This lower-level API is useful for supervisors and tests. Most standalone Node processes should call
 * {@link runWorkerProcess}, which adds bounded SIGINT/SIGTERM handling.
 */
export async function startWorkerProcess<TTransaction = unknown>(
  definition: WorkerProcessDefinition<TTransaction>,
): Promise<StartedWorkerProcess> {
  validateDefinition(definition as WorkerProcessDefinition);
  const adapter = await definition.adapter();
  const workers: Worker[] = [];
  let ready = false;
  let probeServer: Server | undefined;
  let probeUrl: string | null = null;

  try {
    for (const workerDefinition of definition.workers) {
      const worker = adapter.createWorker(workerDefinition.options);
      workerDefinition.configure(worker);
      workers.push(worker);
    }
  } catch (error) {
    await adapter.close();
    throw error;
  }

  if (definition.probes) {
    try {
      const probe = await startProbeServer(definition.probes, () => ready);
      probeServer = probe.server;
      probeUrl = probe.url;
    } catch (error) {
      await adapter.close();
      throw error;
    }
  }

  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;
  let resolveCompleted!: () => void;
  let rejectCompleted!: (error: unknown) => void;
  let resolveFailure!: (error: Error) => void;
  const failure = new Promise<Error>((resolve) => {
    resolveFailure = resolve;
  });
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  // The process runner normally awaits this promise. Attaching a no-op rejection observer here also
  // keeps programmatic callers from producing an unhandled rejection before they attach their own.
  void completed.catch(() => undefined);

  const runs: Promise<void>[] = [];
  try {
    for (const worker of workers) runs.push(worker.run());
    ready = true;
  } catch (error) {
    for (const worker of workers) worker.stop();
    await Promise.allSettled(runs);
    if (probeServer) await closeServer(probeServer);
    await adapter.close();
    throw error;
  }
  const settlements = Promise.allSettled(runs);
  let unexpectedFailure: Error | undefined;

  const beginShutdown = (cause?: unknown): Promise<void> => {
    if (cause !== undefined && !unexpectedFailure) {
      unexpectedFailure = asError(cause);
      resolveFailure(unexpectedFailure);
    }
    if (shutdownPromise) return shutdownPromise;

    shuttingDown = true;
    ready = false;
    for (const worker of workers) worker.stop();
    shutdownPromise = (async () => {
      const results = await settlements;
      for (const result of results) {
        if (result.status === "rejected" && !unexpectedFailure) {
          unexpectedFailure = asError(result.reason);
        }
      }

      let closeFailure: Error | undefined;
      try {
        await adapter.close();
      } catch (error) {
        closeFailure = asError(error);
      }
      if (probeServer) {
        try {
          await closeServer(probeServer);
        } catch (error) {
          closeFailure ??= asError(error);
        }
      }

      const failures = [unexpectedFailure, closeFailure].filter(
        (error): error is Error => error !== undefined,
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Worker process shutdown failed");
    })();
    void shutdownPromise.then(resolveCompleted, rejectCompleted);
    return shutdownPromise;
  };

  runs.forEach((run, index) => {
    void run.then(
      () => {
        if (!shuttingDown) {
          void beginShutdown(new Error(`Worker ${index + 1} stopped unexpectedly`)).catch(
            () => undefined,
          );
        }
      },
      (error: unknown) => {
        if (!shuttingDown) void beginShutdown(error).catch(() => undefined);
      },
    );
  });

  return {
    workers,
    probeUrl,
    failure,
    completed,
    shutdown: () => beginShutdown(),
  };
}

function defaultLogger(): WorkerProcessLogger {
  return {
    info: (message) => console.log(`[workhorse] ${message}`),
    error: (message, error) => {
      console.error(`[workhorse] ${message}`);
      if (error !== undefined) console.error(error);
    },
  };
}

/**
 * Run a standalone worker process until it is terminated or a worker fails.
 *
 * The first SIGINT/SIGTERM stops new claims and starts a bounded drain. A second signal exits
 * immediately using the conventional signal exit code. Exceeding the deadline exits with code 1 so
 * the platform can recover any remaining leases after they expire.
 */
export async function runWorkerProcess<TTransaction = unknown>(
  definition: WorkerProcessDefinition<TTransaction>,
  options: RunWorkerProcessOptions = {},
): Promise<void> {
  validateDefinition(definition as WorkerProcessDefinition);
  validateShutdownTimeout(options.shutdownTimeoutMs);
  const logger = definition.logger ?? defaultLogger();
  const timeoutMs =
    options.shutdownTimeoutMs ?? definition.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const signalSource = options.signalSource ?? process;
  const forceExit = options.forceExit ?? ((code: number) => process.exit(code));

  let firstSignal: WorkerProcessSignal | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let runtime: StartedWorkerProcess | undefined;
  const listeners = new Map<WorkerProcessSignal, () => void>();

  const force = (code: number, message: string): void => {
    logger.error(message);
    forceExit(code);
  };

  const armDeadline = (message: string): void => {
    if (deadline) return;
    deadline = setTimeout(() => force(1, message), timeoutMs);
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const listener = (): void => {
      if (firstSignal) {
        force(SIGNAL_EXIT_CODES[signal], `Received ${signal} during shutdown; exiting immediately`);
        return;
      }

      firstSignal = signal;
      logger.info(`Received ${signal}; stopping claims and draining active jobs`);
      armDeadline(`Graceful shutdown exceeded ${timeoutMs}ms; exiting immediately`);
      void runtime?.shutdown().catch(() => undefined);
    };
    listeners.set(signal, listener);
    signalSource.on(signal, listener);
  }

  try {
    runtime = await startWorkerProcess(definition);
    logger.info(
      `Started ${runtime.workers.length} worker${runtime.workers.length === 1 ? "" : "s"}`,
    );
    void runtime.failure.then((error) => {
      logger.error("A worker stopped unexpectedly; draining sibling workers", error);
      armDeadline(`Worker failure shutdown exceeded ${timeoutMs}ms; exiting immediately`);
    });
    if (firstSignal) void runtime.shutdown().catch(() => undefined);
    await runtime.completed;
    if (firstSignal) logger.info("Graceful worker shutdown completed");
  } finally {
    if (deadline) clearTimeout(deadline);
    for (const [signal, listener] of listeners) signalSource.off(signal, listener);
  }
}
