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
