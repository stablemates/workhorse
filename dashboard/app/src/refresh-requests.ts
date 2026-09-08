/** Share identical reads, but let a mutation's refresh wait and then read its committed result. */
export function createRefreshRequests() {
  const pending = new Map<string, Promise<unknown>>();
  return {
    async run<T>(key: string, read: () => Promise<T>, fresh = false): Promise<T> {
      const previous = pending.get(key);
      if (previous) {
        if (!fresh) return previous as Promise<T>;
        await previous.catch(() => undefined);
        return this.run(key, read);
      }
      const request = Promise.resolve().then(read);
      pending.set(key, request);
      try {
        return await request;
      } finally {
        if (pending.get(key) === request) pending.delete(key);
      }
    },
    has(key: string): boolean {
      return pending.has(key);
    },
  };
}
