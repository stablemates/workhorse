import { setTimeout as sleep } from "node:timers/promises";
import type { DatabaseNotification, NotificationClient, Queryable } from "./types.js";

const CHANNEL = "workhorse_jobs";
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

export interface JobNotificationSubscription {
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

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
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
  const client = await Promise.race([pending, waitForAbort(signal).then(() => null)]);
  if (client && !signal.aborted) return client;
  if (client) client.release();
  else void pending.then((lateClient) => lateClient.release()).catch(() => undefined);
  return null;
}

async function listenUntilAbort(client: NotificationClient, signal: AbortSignal): Promise<boolean> {
  const pending = client.query(`LISTEN ${CHANNEL}`);
  const listening = await Promise.race([
    pending.then(() => true),
    waitForAbort(signal).then(() => false),
  ]);
  if (!listening) void pending.catch(() => undefined);
  return listening;
}

class JobNotificationHub {
  private readonly subscribers = new Map<number, NotificationSubscriber>();
  private nextSubscriberId = 0;
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;
  private listening = false;

  constructor(private readonly database: NotificationDatabase) {}

  async subscribe(subscriber: NotificationSubscriber): Promise<JobNotificationSubscription> {
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
        this.subscribers.delete(subscriberId);
        if (this.subscribers.size > 0) return;
        this.controller?.abort();
        await this.running;
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
    for (const subscriber of this.subscribers.values()) subscriber.error(error);
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
        connectionError = await Promise.race([
          disconnected.promise,
          waitForAbort(signal).then(() => undefined),
        ]);
        if (connectionError) {
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
          client.removeListener("error", onError);
          client.removeListener("end", onEnd);
          if (!connectionError) {
            try {
              await client.query(`UNLISTEN ${CHANNEL}`);
            } catch (error) {
              connectionError = error instanceof Error ? error : new Error(String(error));
              this.report(error);
            }
          }
          client.release(connectionError);
        }
      }

      if (signal.aborted) return;
      const jitteredReconnectMs = jitterDuration(reconnectMs);
      await abortableSleep(jitteredReconnectMs, signal);
      reconnectMs = Math.min(RECONNECT_MAX_MS, reconnectMs * 2);
    }
  }
}

const hubs = new WeakMap<object, JobNotificationHub>();

export function supportsJobNotifications(database: Queryable): boolean {
  return canListen(database);
}

export function subscribeToJobNotifications(
  database: Queryable,
  subscriber: NotificationSubscriber,
): Promise<JobNotificationSubscription | null> {
  if (!canListen(database)) return Promise.resolve(null);
  const identity = (database as NotificationDatabase).notificationConnectionIdentity ?? database;
  let hub = hubs.get(identity);
  if (!hub) {
    hub = new JobNotificationHub(database);
    hubs.set(identity, hub);
  }
  return hub.subscribe(subscriber);
}
