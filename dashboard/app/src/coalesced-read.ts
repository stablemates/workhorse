/** The answer of one read: its value, or the error that it failed with. */
export type CoalescedReadResult<T> =
  | { status: "ready"; value: T }
  | { status: "failed"; error: unknown };

export interface CoalescedRead<T> {
  /**
   * Read `key` now, or after the read in flight for `key` ends.
   *
   * A new key starts its read at once and discards the answer of the read for the old key.
   */
  request(key: string, read: () => Promise<T>): void;
  /** Discard every answer that arrives later. */
  close(): void;
}

/**
 * A read that a poll can repeat without a pile of requests.
 *
 * A page polls each few seconds, and a read can take longer than that. If each poll started a read
 * and discarded the one in flight, no answer would arrive. So each key has one read in flight at
 * most. Requests for the same key while it runs start one more read after it ends, with the newest
 * `read` function. Each answer for the current key goes to `deliver`.
 */
export function createCoalescedRead<T>(
  deliver: (result: CoalescedReadResult<T>) => void,
): CoalescedRead<T> {
  let key: string | null = null;
  let latestRead: (() => Promise<T>) | null = null;
  let inFlight = false;
  let again = false;
  let generation = 0;
  let closed = false;

  function start(read: () => Promise<T>) {
    generation += 1;
    const ticket = generation;
    inFlight = true;
    again = false;
    read().then(
      (value) => finish(ticket, { status: "ready", value }),
      (error: unknown) => finish(ticket, { status: "failed", error }),
    );
  }

  function finish(ticket: number, result: CoalescedReadResult<T>) {
    if (closed || ticket !== generation) return;
    inFlight = false;
    deliver(result);
    if (again && latestRead !== null) start(latestRead);
  }

  return {
    request(next, read) {
      if (closed) return;
      latestRead = read;
      if (next !== key) {
        key = next;
        start(read);
      } else if (inFlight) {
        again = true;
      } else {
        start(read);
      }
    },
    close() {
      closed = true;
    },
  };
}
