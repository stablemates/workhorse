import { setTimeout as sleep } from "node:timers/promises";
import type { DatabaseNotification, NotificationClient, Queryable } from "./types.js";

const CHANNEL = "workhorse_tasks";
const RECONNECT_INITIAL_MS = 100;
const RECONNECT_MAX_MS = 5_000;

export function jitterDuration(durationMs: number): number {
  return Math.max(1, Math.round(durationMs * (0.9 + Math.random() * 0.2)));
}

interface NotificationSubscriber {
  queueName: string;
  wake: () => void;
  error: (error: unknown) => void;
}

export interface TaskNotificationSubscription {
  isListening?(): boolean;
  close(): Promise<void>;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const ABORTED = Symbol("workhorse.notificationAborted");

/** Settles with `pending`, or with ABORTED once `signal` aborts, and never leaves a listener. */
async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return ABORTED;
  let onAbort!: () => void;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function abortableSleep(durationMs: number, signal: AbortSignal): Promise<void> {
  try {
    await sleep(durationMs, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

type NotificationDatabase = Queryable & {
  connect?: () => Promise<unknown>;
  notificationConnectionCapacity?: number;
  notificationConnectionIdentity?: object;
  options?: { max?: number };
};

function canListen(database: Queryable): database is NotificationDatabase & {
  connect: () => Promise<unknown>;
} {
  const candidate = database as NotificationDatabase;
  const capacity = candidate.notificationConnectionCapacity ?? candidate.options?.max;
  return typeof candidate.connect === "function" && (capacity === undefined || capacity > 1);
}

async function connect(database: NotificationDatabase): Promise<NotificationClient> {
  const client = await database.connect!.call(database);
  if (
    typeof client !== "object" ||
    client === null ||
    !("query" in client) ||
    !("on" in client) ||
    !("removeListener" in client) ||
    !("release" in client)
  ) {
    throw new TypeError("Database connect() did not return a notification-capable client");
  }
  return client as NotificationClient;
}

async function connectUntilAbort(
  database: NotificationDatabase,
  signal: AbortSignal,
): Promise<NotificationClient | null> {
  const pending = connect(database);
  const client = await raceAbort(pending, signal);
  if (client !== ABORTED && !signal.aborted) return client;
  if (client !== ABORTED) client.release();
  else void pending.then((lateClient) => lateClient.release()).catch(() => undefined);
  return null;
}

async function listenUntilAbort(client: NotificationClient, signal: AbortSignal): Promise<boolean> {
  const pending = client.query(`LISTEN ${CHANNEL}`);
  const listening = (await raceAbort(pending, signal)) !== ABORTED;
  if (!listening) void pending.catch(() => undefined);
  return listening;
}

class TaskNotificationHub {
  private readonly subscribers = new Map<number, NotificationSubscriber>();
  private nextSubscriberId = 0;
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;
  private listening = false;

  constructor(private readonly database: NotificationDatabase) {}

  async subscribe(subscriber: NotificationSubscriber): Promise<TaskNotificationSubscription> {
    if (this.controller?.signal.aborted && this.running) await this.running;

    const subscriberId = this.nextSubscriberId;
    this.nextSubscriberId += 1;
    this.subscribers.set(subscriberId, subscriber);
    if (!this.running) this.start();

    let closed = false;
    return {
      isListening: () => this.listening,
      close: async () => {
        if (closed) return;
        closed = true;
        if (this.subscribers.size > 1) {
          this.subscribers.delete(subscriberId);
          return;
        }
        // The last subscriber stays registered through shutdown so it observes an UNLISTEN failure.
        this.controller?.abort();
        await this.running;
        this.subscribers.delete(subscriberId);
      },
    };
  }

  private start(): void {
    const controller = new AbortController();
    this.controller = controller;
    const running = this.run(controller.signal).finally(() => {
      if (this.running !== running) return;
      this.running = null;
      this.controller = null;
    });
    this.running = running;
  }

  private wakeMatching(notification: DatabaseNotification): void {
    if (notification.channel !== CHANNEL) return;
    for (const subscriber of this.subscribers.values()) {
      if (notification.payload === subscriber.queueName || notification.payload === "*") {
        subscriber.wake();
      }
    }
  }

  private wakeAll(): void {
    for (const subscriber of this.subscribers.values()) subscriber.wake();
  }

  private report(error: unknown): void {
    for (const subscriber of this.subscribers.values()) {
      // A throwing callback must not end the hub, which would stop every subscriber's wakeups.
      try {
        subscriber.error(error);
      } catch {
        // The subscriber owns its callback's failures.
      }
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    let reconnectMs = RECONNECT_INITIAL_MS;
    while (!signal.aborted) {
      let client: NotificationClient | null = null;
      let connectionError: Error | undefined;
      const disconnected = deferred<Error>();
      const onNotification = (notification: DatabaseNotification): void =>
        this.wakeMatching(notification);
      const onError = (error: Error): void => disconnected.resolve(error);
      const onEnd = (): void =>
        disconnected.resolve(new Error("PostgreSQL notification connection ended"));

      try {
        client = await connectUntilAbort(this.database, signal);
        if (!client) return;
        client.on("notification", onNotification);
        client.on("error", onError);
        client.on("end", onEnd);
        if (!(await listenUntilAbort(client, signal))) {
          connectionError = new Error("PostgreSQL notification setup was aborted");
          return;
        }
        this.listening = true;
        reconnectMs = RECONNECT_INITIAL_MS;
        this.wakeAll();
        const disconnection = await raceAbort(disconnected.promise, signal);
        if (disconnection !== ABORTED) {
          connectionError = disconnection;
          this.report(connectionError);
          this.wakeAll();
        }
      } catch (error) {
        connectionError = error instanceof Error ? error : new Error(String(error));
        this.report(error);
      } finally {
        this.listening = false;
        if (client) {
          client.removeListener("notification", onNotification);
          client.removeListener("end", onEnd);
          // The error listener stays until release: an unobserved client error event throws.
          if (!connectionError) {
            try {
              await client.query(`UNLISTEN ${CHANNEL}`);
            } catch (error) {
              connectionError = error instanceof Error ? error : new Error(String(error));
              this.report(error);
            }
          }
          client.release(connectionError);
          client.removeListener("error", onError);
        }
      }

      if (signal.aborted) return;
      const jitteredReconnectMs = jitterDuration(reconnectMs);
      await abortableSleep(jitteredReconnectMs, signal);
      reconnectMs = Math.min(RECONNECT_MAX_MS, reconnectMs * 2);
    }
  }
}

const hubs = new WeakMap<object, TaskNotificationHub>();

export function supportsTaskNotifications(database: Queryable): boolean {
  return canListen(database);
}

export function subscribeToTaskNotifications(
  database: Queryable,
  subscriber: NotificationSubscriber,
): Promise<TaskNotificationSubscription | null> {
  if (!canListen(database)) return Promise.resolve(null);
  const identity = (database as NotificationDatabase).notificationConnectionIdentity ?? database;
  let hub = hubs.get(identity);
  if (!hub) {
    hub = new TaskNotificationHub(database);
    hubs.set(identity, hub);
  }
  return hub.subscribe(subscriber);
}
