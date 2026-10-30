/** Writes the id of the foreground page load, as a React state setter does. */
type ForegroundLoadSetter = (update: (current: number | null) => number | null) => void;

/**
 * The operator's page load that the Refresh control shows as busy.
 *
 * A stale page keeps its state while the operator retries, so the Refresh control reads the
 * request from here to show its spinner. A request ends its spinner when it settles, unless a
 * newer request took the spinner first. A navigation that a cached answer serves at once
 * supersedes the request in progress: the operator left that page, so its read must not keep the
 * new page busy.
 */
export function createForegroundLoads(set: ForegroundLoadSetter) {
  return {
    start(id: number): void {
      set(() => id);
    },
    settle(id: number): void {
      set((current) => (current === id ? null : current));
    },
    supersede(): void {
      set(() => null);
    },
  };
}
