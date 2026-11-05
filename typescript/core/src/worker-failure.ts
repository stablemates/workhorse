/**
 * Package-internal channel from a worker's run to the process runner that owns it.
 *
 * A worker drains its active handlers before `run()` rejects, so a handler that ignores
 * cancellation would otherwise hide a fatal error. The worker reports the error here when it first
 * observes it, and the process runner turns readiness false and starts its deadline at once.
 */
const failureObservers = new WeakMap<object, (error: unknown) => void>();

export function observeWorkerFailure(worker: object, observer: (error: unknown) => void): void {
  failureObservers.set(worker, observer);
}

export function reportWorkerFailure(worker: object, error: unknown): void {
  failureObservers.get(worker)?.(error);
}

/**
 * The same channel for startup. A worker reports once each run passes its startup checks: the
 * reserved heartbeat connection, the schema compatibility verdict, and the first registration
 * write. The process runner reports readiness only after every worker reported.
 */
const startupObservers = new WeakMap<object, () => void>();

export function observeWorkerStartup(worker: object, observer: () => void): void {
  startupObservers.set(worker, observer);
}

export function reportWorkerStartup(worker: object): void {
  startupObservers.get(worker)?.();
}

/**
 * The channel in the other direction. At the end of its shutdown grace, the process runner aborts
 * the signal of each handler that still runs, so the worker can give the task back before the
 * process exits (SM-1919).
 */
const shutdownAborts = new WeakMap<object, () => void>();

export function onWorkerShutdownAbort(worker: object, abort: () => void): void {
  shutdownAborts.set(worker, abort);
}

export function abortWorkerHandlers(worker: object): void {
  shutdownAborts.get(worker)?.();
}
