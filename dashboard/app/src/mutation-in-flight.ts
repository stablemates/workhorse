import { useCallback, useMemo, useState } from "react";

export interface MutationInFlight<T> {
  value: T | null;
  start(value: T): void;
  stop(): void;
}

export function useMutationInFlight<T>(): MutationInFlight<T> {
  const [value, setValue] = useState<T | null>(null);
  const start = useCallback((next: T) => setValue(next), []);
  const stop = useCallback(() => setValue(null), []);
  return useMemo(() => ({ value, start, stop }), [value, start, stop]);
}

export function createMutationInFlight<T>(initial: T | null = null): MutationInFlight<T> {
  let value = initial;
  return {
    get value() {
      return value;
    },
    start(next) {
      value = next;
    },
    stop() {
      value = null;
    },
  };
}
