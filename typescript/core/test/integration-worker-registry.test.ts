import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  readWorkerClientProtocols,
  type MaintenancePhaseResult,
  Queue,
  Worker,
} from "../src/index.js";
import type { ClaimedTask } from "../src/index.js";
import { WORKHORSE_VERSION } from "../src/version.js";
import { workerHeartbeatReservation } from "../src/worker-internal.js";
// `InjectedCrashError` is worker test support, not published API, so it comes from the source module.
import { InjectedCrashError } from "../src/worker.js";
import { Pool } from "pg";
import { type HeartbeatSchedule, recordHeartbeatTimers } from "./support/heartbeat-timers.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { databaseUrl, deferred, pool, queue, admin, adminAudit } = createIntegrationTestContext(
  import.meta.url,
);

const lifecycleRegistration = async () =>
  (await admin.listWorkers()).find((entry) => entry.workerId === "registry-lifecycle");

const closeFailureRegistration = async () =>
  (await admin.listWorkers()).find(
    (entry) => entry.workerId === "registry-notification-close-failure",
  );

// A heartbeat round ends with the COMMIT of its transaction, and no other worker statement or test
// in this file sends one. So the reserved backend's last query is the heartbeat or that COMMIT.
const heartbeatBackends = async (): Promise<number[]> => {
  const backends = await pool.query<{ pid: number }>(
    `SELECT pid
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND (query LIKE '%workhorse.heartbeat_many_v2%' OR query = 'COMMIT')
        AND query NOT LIKE '%pg_stat_activity%'`,
  );
  return backends.rows.map((row) => row.pid);
};

/**
 * Record the leases of each heartbeat round that a worker on `queue` sends through its reserved
 * connection. `mock.calls[n][0]` holds the tasks of round n.
 */
function spyOnReservedHeartbeats() {
  const rounds = vi.fn<(tasks: readonly ClaimedTask[]) => void>();
  const reserve = queue[workerHeartbeatReservation].bind(queue);
  const reservation = vi
    .spyOn(queue, workerHeartbeatReservation)
    .mockImplementation((intervalMs) => {
      const channel = reserve(intervalMs);
      if (channel === undefined) return channel;
      const heartbeatMany = channel.heartbeatMany.bind(channel);
      channel.heartbeatMany = (tasks, ...rest) => {
        rounds(tasks);
        return heartbeatMany(tasks, ...rest);
      };
      return channel;
    });
  return Object.assign(rounds, { mockRestore: () => reservation.mockRestore() });
}

// A heartbeat round on the reserved connection must end within heartbeatRoundBoundMs. Below 50 ms,
// that bound is the interval itself. On a loaded host, the four round trips of a round need more
// than 10 or 20 ms. Then no heartbeat gets to PostgreSQL, and the lease expires. Workhorse then
// rejects the completion as stale (SM-1436). A 100 ms interval gives a 75 ms round. The lease
// leaves time for many failed rounds.
const loadSafeHeartbeat = { heartbeatMs: 100, leaseMs: 5_000 };

// A host stall can delay a condition by seconds, so each wait gets 10 s, well inside the 20 s test.
const stallWait = { timeout: 10_000 };

// An idle worker polls again after 4.5 s at the earliest. A notification test must see its wake
// well before that, or a poll could pass the check.
const notificationWait = { timeout: 1_000 };

const prunedRegistration = (workerId: string) => ({
  workerId,
  hostname: "test-host",
  pid: 4321,
  queue: "default",
  concurrency: 1,
  activeSlots: 0,
  draining: false,
});
const ageRegistrations = (age: string) =>
  pool.query(
    "UPDATE workhorse.worker_registry SET last_heartbeat_at = clock_timestamp() - $1::interval",
    [age],
  );
const keptPauses = async (workerId: string) =>
  (
    await pool.query<{ instance_id: string }>(
      "SELECT instance_id::text FROM workhorse.worker_pause_tombstone WHERE worker_id = $1",
      [workerId],
    )
  ).rows.map((row) => row.instance_id);
// Pause one registered instance, then let maintenance prune its stale row, as a network
// partition longer than the prune age does.
const pauseAndPrune = async (workerId: string, instanceId: string) => {
  await queue.registerWorker({ ...prunedRegistration(workerId), instanceId });
  await admin.setWorkerPaused(workerId, true, {
    ...adminAudit("investigate the worker"),
    actor: "operator",
  });
  await ageRegistrations("10 minutes");
  await expect(queue.pruneWorkerRegistry(60_000)).resolves.toBe(1);
  expect((await admin.listWorkers()).some((entry) => entry.workerId === workerId)).toBe(false);
};

describe("worker registry", () => {
  it("claims configured queues through one worker identity and shared slot budget", async () => {
    const firstQueue = `multi-queue-first-${randomUUID()}`;
    const secondQueue = `multi-queue-second-${randomUUID()}`;
    const handled: string[] = [];
    await queue.enqueue("multi-queue", null, { queue: firstQueue });
    await queue.enqueue("multi-queue", null, { queue: secondQueue });

    const worker = new Worker(queue, {
      workerId: "multi-queue-worker",
      queues: [firstQueue, secondQueue],
      concurrency: 2,
      pollMs: 1,
    }).handle("multi-queue", (_payload, { task }) => {
      handled.push(task.queue);
      return null;
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(handled.toSorted()).toEqual([firstQueue, secondQueue].toSorted());
  });

  it("registers every queue served by one worker", async () => {
    const worker = new Worker(queue, {
      workerId: "multi-queue-registration",
      queues: ["mail", "billing"],
      scheduleNamespaces: ["commerce"],
      registryIntervalMs: 100,
    });

    await worker.runOnce();

    await expect(
      admin
        .listWorkers()
        .then((workers) => workers.find((entry) => entry.workerId === "multi-queue-registration")),
    ).resolves.toMatchObject({
      queues: ["mail", "billing"],
      scheduleNamespaces: ["commerce"],
    });
  });

  it("records the client protocol and SDK identity of the process that registered", async () => {
    const workerId = `sdk-identity-${randomUUID()}`;
    const worker = new Worker(queue, {
      workerId,
      queues: ["sdk-identity"],
      registryIntervalMs: 100,
    });

    await worker.runOnce();

    const row = await pool.query<{
      client_protocol_version: number | null;
      sdk_language: string | null;
      sdk_version: string | null;
    }>(
      `SELECT client_protocol_version, sdk_language, sdk_version
         FROM workhorse.worker_registry WHERE worker_id = $1`,
      [workerId],
    );

    expect(row.rows).toEqual([
      {
        client_protocol_version: PROTOCOL_VERSION,
        sdk_language: "typescript",
        sdk_version: WORKHORSE_VERSION,
      },
    ]);
  });

  // The SQL protocol is a governed surface a caller may use without one of the three SDKs, and the
  // three identity arguments are nullable for exactly that caller. Reporting nothing has to be
  // recorded as nothing rather than rejected, because that row is the population
  // `workhorse schema contract` must not assume away.
  it("registers a worker that reports no client identity at all", async () => {
    const workerId = `unreported-registration-${randomUUID()}`;
    await pool.query(
      `SELECT workhorse.register_worker_v1(
         $1::text, $2::uuid, 'legacy-host', 4242, ARRAY['legacy']::text[], ARRAY[]::text[],
         2, 30000, 10000, 250, 1000, 60000, 5000, 0, false,
         NULL::integer, NULL::text, NULL::text)`,
      [workerId, randomUUID()],
    );

    const row = await pool.query<{
      hostname: string;
      client_protocol_version: number | null;
      sdk_language: string | null;
      sdk_version: string | null;
    }>(
      `SELECT hostname, client_protocol_version, sdk_language, sdk_version
         FROM workhorse.worker_registry WHERE worker_id = $1`,
      [workerId],
    );

    expect(row.rows).toEqual([
      {
        hostname: "legacy-host",
        client_protocol_version: null,
        sdk_language: null,
        sdk_version: null,
      },
    ]);
  });

  // The evidence `workhorse schema contract` gates on: a worker outside its own lease is not
  // proof of anything, so it must not be counted as still speaking a protocol.
  it("counts only the protocols of workers heartbeating inside their lease", async () => {
    const live = `protocol-live-${randomUUID()}`;
    const lapsed = `protocol-lapsed-${randomUUID()}`;
    await pool.query(
      `SELECT workhorse.register_worker_v1(
         $1::text, $2::uuid, 'evidence-host', 4243, ARRAY['evidence']::text[], ARRAY[]::text[],
         1, 30000, 10000, 250, 1000, 60000, 5000, 0, false, 7, 'fixture', '9.9.9')`,
      [live, randomUUID()],
    );
    await pool.query(
      `SELECT workhorse.register_worker_v1(
         $1::text, $2::uuid, 'evidence-host', 4244, ARRAY['evidence']::text[], ARRAY[]::text[],
         1, 1000, 500, 250, 1000, 60000, 5000, 0, false, 8, 'fixture', '9.9.9')`,
      [lapsed, randomUUID()],
    );
    await pool.query(
      `UPDATE workhorse.worker_registry
          SET last_heartbeat_at = clock_timestamp() - interval '1 hour'
        WHERE worker_id = $1`,
      [lapsed],
    );

    const counted = await readWorkerClientProtocols(pool);
    const versions = (counted ?? []).map((entry) => entry.version);

    expect(counted).not.toBeNull();

    expect(versions).toContain(7);
    expect(versions).not.toContain(8);
  });

  it("subscribes to notifications for every configured queue", async () => {
    const close = vi.fn<() => Promise<void>>(async () => undefined);
    const subscribe = vi.spyOn(queue, "subscribeToTaskNotifications").mockResolvedValue({ close });
    const worker = new Worker(queue, {
      workerId: "multi-queue-notifications",
      queues: ["mail", "billing"],
      pollMs: 10,
      registryIntervalMs: 0,
    });

    try {
      const running = worker.run();
      await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2), stallWait);
      expect(subscribe.mock.calls.map(([queueName]) => queueName)).toEqual(["mail", "billing"]);
      worker.stop();
      await running;
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      subscribe.mockRestore();
    }
  });

  it("registers a running worker durably and deregisters it once its loop stops", async () => {
    const worker = new Worker(queue, {
      workerId: "registry-lifecycle",
      queue: "default",
      concurrency: 4,
      pollMs: 10,
      registryIntervalMs: 100,
    }).handle("registry-lifecycle", () => ({ ok: true }));

    const running = worker.run();
    await vi.waitFor(async () => {
      expect(await lifecycleRegistration()).toMatchObject({
        workerId: "registry-lifecycle",
        queue: "default",
        concurrency: 4,
        paused: false,
        draining: false,
        // Placement is recorded independently of the configured name, so a stably named worker
        // still answers "which host and process is this".
        hostname: expect.any(String),
        pid: process.pid,
      });
    }, stallWait);

    worker.stop();
    await running;
    await expect(lifecycleRegistration()).resolves.toBeUndefined();
  });

  it("deregisters when notification subscription cleanup fails", async () => {
    const closeFailure = new Error("notification close failed");
    const close = vi.fn<() => Promise<void>>(async () => {
      throw closeFailure;
    });
    const subscribe = vi.spyOn(queue, "subscribeToTaskNotifications").mockResolvedValue({ close });
    const worker = new Worker(queue, {
      workerId: "registry-notification-close-failure",
      queue: "default",
      pollMs: 10,
      registryIntervalMs: 100,
    }).handle("registry-notification-close-failure", () => null);

    try {
      const running = worker.run();
      await vi.waitFor(
        async () => expect(await closeFailureRegistration()).toBeDefined(),
        stallWait,
      );
      await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce(), stallWait);

      worker.stop();
      await expect(running).rejects.toBe(closeFailure);
      expect(close).toHaveBeenCalledOnce();
      await expect(closeFailureRegistration()).resolves.toBeUndefined();
    } finally {
      subscribe.mockRestore();
    }
  });

  it("preserves cleanup failures while still deregistering", async () => {
    const closeFailure = new Error("notification close failed");
    const registrationFailure = new Error("draining registration failed");
    let failRegistration = false;
    const subscribe = vi.fn<Queue["subscribeToTaskNotifications"]>(async () => ({
      close: async () => {
        throw closeFailure;
      },
    }));
    const rejectingQueue = new Proxy(queue, {
      get(target, property, receiver) {
        if (property === "registerWorker") {
          return async (...args: Parameters<Queue["registerWorker"]>) => {
            if (failRegistration) throw registrationFailure;
            return target.registerWorker(...args);
          };
        }
        if (property === "subscribeToTaskNotifications") {
          return subscribe;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const workerId = "registry-multiple-cleanup-failures";
    const worker = new Worker(rejectingQueue, {
      workerId,
      queue: "default",
      pollMs: 10,
      registryIntervalMs: 100,
      onRegistrationError: (error) => {
        throw error;
      },
    }).handle("registry-multiple-cleanup-failures", () => null);
    const registration = async () =>
      (await admin.listWorkers()).find((entry) => entry.workerId === workerId);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const running = worker.run();
      await vi.waitFor(async () => expect(await registration()).toBeDefined(), stallWait);
      await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce(), stallWait);
      failRegistration = true;
      worker.stop();

      // SM-1655: a throwing onRegistrationError is a reporter failure, not a cleanup failure.
      await expect(running).rejects.toBe(closeFailure);
      await expect(registration()).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith(
        "Workhorse worker onRegistrationError reporter failed",
        registrationFailure,
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("applies an operator pause written to PostgreSQL by another process", async () => {
    // The pause is written through a separate Queue instance holding no reference to the worker
    // object, which is exactly the situation of a dashboard running outside the worker process.
    const handled: number[] = [];
    const worker = new Worker(queue, {
      workerId: "registry-remote-pause",
      pollMs: 10,
      registryIntervalMs: 100,
    }).handle<{ sequence: number }>("registry-remote-pause", ({ sequence }) => {
      handled.push(sequence);
      return { sequence };
    });

    const running = worker.run();
    try {
      await vi.waitFor(async () => {
        expect((await admin.listWorkers()).map((entry) => entry.workerId)).toContain(
          "registry-remote-pause",
        );
      }, stallWait);

      await expect(
        admin.setWorkerPaused("registry-remote-pause", true, {
          ...adminAudit("rolling deploy"),
          actor: "operator",
        }),
      ).resolves.toMatchObject({ paused: true, pausedBy: "operator", reason: "rolling deploy" });
      await vi.waitFor(() => expect(worker.isPaused()).toBe(true), stallWait);
      expect(worker.runtimeState()).toMatchObject({
        paused: true,
        remotelyPaused: true,
        locallyPaused: false,
      });

      // Let a claim already submitted before the remote pause finish against the empty queue.
      // A local resume must then leave the remote pause latched for subsequently enqueued work.
      worker.resume();
      await sleep(300);
      expect(worker.isPaused()).toBe(true);
      await queue.enqueue("registry-remote-pause", { sequence: 1 });
      await sleep(300);
      expect(handled).toEqual([]);
      expect(worker.isPaused()).toBe(true);

      await admin.setWorkerPaused("registry-remote-pause", false, adminAudit("resume worker"));
      await vi.waitFor(() => expect(handled).toEqual([1]), stallWait);
      expect(worker.runtimeState()).toMatchObject({ paused: false, remotelyPaused: false });
    } finally {
      worker.stop();
      await running;
    }
  });

  it("returns null when pausing a worker that has never registered", async () => {
    await expect(
      admin.setWorkerPaused("never-registered", true, adminAudit("pause missing worker")),
    ).resolves.toBeNull();
  });

  it("scopes an operator pause to the running process rather than to the worker name", async () => {
    const instance = randomUUID();
    const registration = {
      workerId: "registry-process-scope",
      hostname: "test-host",
      pid: 4321,
      queue: "default",
      concurrency: 1,
      activeSlots: 0,
      draining: false,
    };

    await queue.registerWorker({ ...registration, instanceId: instance });
    await expect(
      admin.setWorkerPaused("registry-process-scope", true, adminAudit("pause process")),
    ).resolves.toMatchObject({ paused: true });

    // The same process refreshing must keep the pause, or a pause would clear on its own heartbeat.
    await expect(queue.registerWorker({ ...registration, instanceId: instance })).resolves.toEqual({
      paused: true,
    });

    // A replacement process for the same worker name comes back running, and inherits no
    // attribution from the operator decision that was aimed at the process it replaced.
    await expect(
      queue.registerWorker({ ...registration, instanceId: randomUUID() }),
    ).resolves.toEqual({ paused: false });
    const entry = (await admin.listWorkers()).find(
      (worker) => worker.workerId === "registry-process-scope",
    );
    expect(entry).toMatchObject({ paused: false, pausedBy: null, reason: null, pausedAt: null });
  });

  it("keeps the row of a later run when a stale deregistration names an ended instance", async () => {
    const workerId = "registry-fenced-deregistration";
    const registration = {
      workerId,
      hostname: "test-host",
      pid: 4321,
      queue: "default",
      concurrency: 1,
      activeSlots: 0,
      draining: false,
    };
    const ended = randomUUID();
    const later = randomUUID();
    await queue.registerWorker({ ...registration, instanceId: ended });
    await queue.registerWorker({ ...registration, instanceId: later });
    await admin.setWorkerPaused(workerId, true, adminAudit("pause the later run"));

    // The stop path of the ended run arrives late, after the later run registered.
    await expect(queue.deregisterWorker(workerId, ended)).resolves.toBe(false);
    const entry = (await admin.listWorkers()).find((worker) => worker.workerId === workerId);
    expect(entry).toMatchObject({ instanceId: later, paused: true });

    await expect(queue.deregisterWorker(workerId, later)).resolves.toBe(true);
    expect((await admin.listWorkers()).some((worker) => worker.workerId === workerId)).toBe(false);
  });

  it("keeps deregister_worker_v1 deleting by worker ID only", async () => {
    const workerId = "registry-deregistration-v1";
    await queue.registerWorker({
      workerId,
      instanceId: randomUUID(),
      hostname: "test-host",
      pid: 4321,
      queue: "default",
      concurrency: 1,
      activeSlots: 0,
      draining: false,
    });

    // A released SDK sends deregister_worker_v1 without an instance, and it still deletes the row.
    const result = await pool.query<{ deregistered: boolean }>(
      "SELECT workhorse.deregister_worker_v1($1::text) AS deregistered",
      [workerId],
    );
    expect(result.rows).toEqual([{ deregistered: true }]);
    expect((await admin.listWorkers()).some((worker) => worker.workerId === workerId)).toBe(false);
    await expect(queue.deregisterWorker(workerId)).resolves.toBe(false);
  });

  it("removes the row by worker ID only when deregisterWorker gets no instance", async () => {
    const workerId = "registry-unfenced-deregistration";
    const registration = {
      workerId,
      hostname: "test-host",
      pid: 4321,
      queue: "default",
      concurrency: 1,
      activeSlots: 0,
      draining: false,
    };
    await queue.registerWorker({ ...registration, instanceId: randomUUID() });
    await queue.registerWorker({ ...registration, instanceId: randomUUID() });

    // Without an instance the call is not fenced, so it removes the row of the later run too.
    await expect(queue.deregisterWorker(workerId)).resolves.toBe(true);
    expect((await admin.listWorkers()).some((worker) => worker.workerId === workerId)).toBe(false);
  });

  it("gives each run of one Worker a new instance that a stale stop of an earlier run cannot delete", async () => {
    const workerId = "registry-instance-per-run";
    const worker = new Worker(queue, {
      workerId,
      queue: "default",
      pollMs: 10,
      registryIntervalMs: 100,
    });
    const registeredInstance = async (): Promise<string> => {
      let instance: string | undefined;
      await vi.waitFor(async () => {
        instance = (await admin.listWorkers()).find(
          (item) => item.workerId === workerId,
        )?.instanceId;
        expect(instance).toBeDefined();
      }, stallWait);
      return instance!;
    };

    const firstRun = worker.run();
    const first = await registeredInstance();
    worker.stop();
    await firstRun;

    const secondRun = worker.run();
    try {
      const second = await registeredInstance();
      expect(second).not.toBe(first);

      // The stop path of the first run sends its deregistration after the second run registered.
      await expect(queue.deregisterWorker(workerId, first)).resolves.toBe(false);
      expect(await registeredInstance()).toBe(second);
    } finally {
      worker.stop();
      await secondRun;
    }
    expect((await admin.listWorkers()).some((item) => item.workerId === workerId)).toBe(false);
  });

  it("prunes only registrations whose heartbeat aged past the requested window", async () => {
    await queue.registerWorker({
      workerId: "registry-prune",
      instanceId: randomUUID(),
      hostname: "test-host",
      pid: 4321,
      queue: "default",
      concurrency: 1,
      activeSlots: 0,
      draining: false,
    });

    await expect(queue.pruneWorkerRegistry(60_000)).resolves.toBe(0);
    await pool.query(
      "UPDATE workhorse.worker_registry SET last_heartbeat_at = clock_timestamp() - interval '10 minutes'",
    );
    await expect(queue.pruneWorkerRegistry(60_000)).resolves.toBe(1);
    await expect(
      admin.listWorkers().then((entries) => entries.map((entry) => entry.workerId)),
    ).resolves.not.toContain("registry-prune");
  });

  it("prunes stale worker registrations during automatic maintenance", async () => {
    await queue.registerWorker({
      workerId: "registry-automatic-prune",
      instanceId: randomUUID(),
      hostname: "test-host",
      pid: 4321,
      queue: "default",
      concurrency: 1,
      activeSlots: 0,
      draining: false,
    });
    await pool.query(
      "UPDATE workhorse.worker_registry SET last_heartbeat_at = clock_timestamp() - interval '10 minutes'",
    );

    const worker = new Worker(queue, { workerId: "registry-maintenance-runner" });
    await worker.runOnce();

    await expect(
      admin.listWorkers().then((entries) => entries.map((entry) => entry.workerId)),
    ).resolves.not.toContain("registry-automatic-prune");
  });

  describe("operator pause after a registry prune", () => {
    it("restores the pause when the same instance registers again", async () => {
      const workerId = "registry-pruned-pause";
      const instanceId = randomUUID();
      await queue.registerWorker({ ...prunedRegistration(workerId), instanceId });
      await admin.setWorkerPaused(workerId, true, {
        ...adminAudit("investigate the worker"),
        actor: "operator",
      });
      await ageRegistrations("10 minutes");

      // Automatic maintenance prunes the row, as it does after a partition of more than a minute.
      await new Worker(queue, { workerId: "registry-pruned-pause-maintenance" }).runOnce();
      expect((await admin.listWorkers()).some((entry) => entry.workerId === workerId)).toBe(false);
      await expect(keptPauses(workerId)).resolves.toEqual([instanceId]);

      await expect(
        queue.registerWorker({ ...prunedRegistration(workerId), instanceId }),
      ).resolves.toEqual({ paused: true });
      expect(
        (await admin.listWorkers()).find((entry) => entry.workerId === workerId),
      ).toMatchObject({
        instanceId,
        paused: true,
        pausedBy: "operator",
        reason: "investigate the worker",
      });
      await expect(keptPauses(workerId)).resolves.toEqual([]);
    });

    it("keeps no pause when it prunes a running registration", async () => {
      const workerId = "registry-pruned-running";
      const instanceId = randomUUID();
      await queue.registerWorker({ ...prunedRegistration(workerId), instanceId });
      await ageRegistrations("10 minutes");
      await expect(queue.pruneWorkerRegistry(60_000)).resolves.toBe(1);

      await expect(keptPauses(workerId)).resolves.toEqual([]);
      await expect(
        queue.registerWorker({ ...prunedRegistration(workerId), instanceId }),
      ).resolves.toEqual({ paused: false });
    });

    it("starts a new instance running and ends the kept pause of the earlier one", async () => {
      const workerId = "registry-pruned-replaced";
      const ended = randomUUID();
      await pauseAndPrune(workerId, ended);

      await expect(
        queue.registerWorker({ ...prunedRegistration(workerId), instanceId: randomUUID() }),
      ).resolves.toEqual({ paused: false });
      expect(
        (await admin.listWorkers()).find((entry) => entry.workerId === workerId),
      ).toMatchObject({ paused: false, pausedBy: null, reason: null, pausedAt: null });
      await expect(keptPauses(workerId)).resolves.toEqual([]);
    });

    it("ends the kept pause on an explicit operator resume", async () => {
      const workerId = "registry-pruned-resumed";
      const instanceId = randomUUID();
      await pauseAndPrune(workerId, instanceId);

      // No row exists to report, but the resume still ends the kept pause.
      await expect(
        admin.setWorkerPaused(workerId, false, adminAudit("resume the worker")),
      ).resolves.toBeNull();
      await expect(keptPauses(workerId)).resolves.toEqual([]);
      await expect(
        queue.registerWorker({ ...prunedRegistration(workerId), instanceId }),
      ).resolves.toEqual({ paused: false });
    });

    it("ends the kept pause when the instance deregisters", async () => {
      const workerId = "registry-pruned-deregistered";
      const instanceId = randomUUID();
      await pauseAndPrune(workerId, instanceId);

      // A fenced deregistration of another instance keeps the pause of this one.
      await expect(queue.deregisterWorker(workerId, randomUUID())).resolves.toBe(false);
      await expect(keptPauses(workerId)).resolves.toEqual([instanceId]);

      await expect(queue.deregisterWorker(workerId, instanceId)).resolves.toBe(false);
      await expect(keptPauses(workerId)).resolves.toEqual([]);
    });

    it("removes an expired kept pause during the next prune", async () => {
      const workerId = "registry-pruned-expired";
      const instanceId = randomUUID();
      await pauseAndPrune(workerId, instanceId);
      const expiry = await pool.query<{ kept_for: boolean }>(
        `SELECT expires_at - pruned_at = interval '1 day' AS kept_for
           FROM workhorse.worker_pause_tombstone WHERE worker_id = $1`,
        [workerId],
      );
      expect(expiry.rows).toEqual([{ kept_for: true }]);

      await pool.query(
        "UPDATE workhorse.worker_pause_tombstone SET expires_at = clock_timestamp() - interval '1 second'",
      );
      await expect(queue.pruneWorkerRegistry(60_000)).resolves.toBe(0);
      await expect(keptPauses(workerId)).resolves.toEqual([]);
      await expect(
        queue.registerWorker({ ...prunedRegistration(workerId), instanceId }),
      ).resolves.toEqual({ paused: false });
    });

    it("lets a resume wait for a registration that restores the kept pause", async () => {
      const workerId = "registry-pruned-concurrent-resume";
      const instanceId = randomUUID();
      await pauseAndPrune(workerId, instanceId);
      const registering = await pool.connect();
      const resuming = await pool.connect();
      let resume: Promise<{ rows: { paused: boolean }[] }> | undefined;
      try {
        // The registration restores the pause and holds its transaction open.
        await registering.query("BEGIN");
        const restored = await registering.query<{ paused: boolean }>(
          `SELECT workhorse.register_worker_v1(
                    $1, $2::uuid, 'test-host', 4321, ARRAY['default'], ARRAY[]::text[], 1, 30000,
                    10000, 250, 1000, 60000, 5000, 0, false, NULL, NULL, NULL
                  ) AS paused`,
          [workerId, instanceId],
        );
        expect(restored.rows).toEqual([{ paused: true }]);

        // A resume in that time must wait, and then end the restored pause.
        const resumingPid = (
          await resuming.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        ).rows[0]!.pid;
        resume = resuming.query<{ paused: boolean }>(
          "SELECT paused FROM workhorse.set_worker_paused_internal_v1($1, false)",
          [workerId],
        );
        await vi.waitFor(async () => {
          const waiting = await pool.query<{ blocked: boolean }>(
            "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked",
            [resumingPid],
          );
          expect(waiting.rows[0]!.blocked).toBe(true);
        }, stallWait);
        await registering.query("COMMIT");
        await expect(resume).resolves.toMatchObject({ rows: [{ paused: false }] });
      } finally {
        await registering.query("ROLLBACK").catch(() => undefined);
        await resume?.catch(() => undefined);
        registering.release();
        resuming.release();
      }
      await expect(
        queue.registerWorker({ ...prunedRegistration(workerId), instanceId }),
      ).resolves.toEqual({ paused: false });
    });

    it("skips a stale registration whose worker ID another call holds", async () => {
      const busy = "registry-pruned-busy";
      const idle = "registry-pruned-idle";
      await queue.registerWorker({ ...prunedRegistration(busy), instanceId: randomUUID() });
      await queue.registerWorker({ ...prunedRegistration(idle), instanceId: randomUUID() });
      await ageRegistrations("10 minutes");
      const holder = await pool.connect();
      try {
        // A registration, resume, or deregistration of the busy worker holds this lock.
        await holder.query("BEGIN");
        await holder.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('workhorse:worker-registry:' || $1, 0))",
          [busy],
        );
        await expect(queue.pruneWorkerRegistry(60_000)).resolves.toBe(1);
        const remaining = (await admin.listWorkers()).map((entry) => entry.workerId);
        expect(remaining).toContain(busy);
        expect(remaining).not.toContain(idle);
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
      }
      await expect(queue.pruneWorkerRegistry(60_000)).resolves.toBe(1);
    });

    it("prunes and keeps the pause of the largest accepted registration interval", async () => {
      const workerId = "registry-largest-interval";
      const instanceId = randomUUID();
      await queue.registerWorker({
        ...prunedRegistration(workerId),
        instanceId,
        registryIntervalMs: 2_147_483_647,
      });
      await admin.setWorkerPaused(workerId, true, adminAudit("pause the slow worker"));

      // Three intervals of 2^31 - 1 ms are about 74.6 days, which integer arithmetic cannot hold.
      await ageRegistrations("10 minutes");
      await expect(queue.pruneWorkerRegistry(60_000)).resolves.toBe(0);
      await ageRegistrations("75 days");
      await expect(queue.pruneWorkerRegistry(60_000)).resolves.toBe(1);
      const expiry = await pool.query<{ kept_for: boolean }>(
        `SELECT expires_at - pruned_at = make_interval(secs => 6442450.941) AS kept_for
           FROM workhorse.worker_pause_tombstone WHERE worker_id = $1`,
        [workerId],
      );
      expect(expiry.rows).toEqual([{ kept_for: true }]);
      await expect(
        queue.registerWorker({ ...prunedRegistration(workerId), instanceId }),
      ).resolves.toEqual({ paused: true });
    });

    it("keeps a registration for three of its own registration intervals", async () => {
      const workerId = "registry-long-interval";
      await queue.registerWorker({
        ...prunedRegistration(workerId),
        instanceId: randomUUID(),
        registryIntervalMs: 120_000,
      });

      // Two missed refreshes of two minutes each are not yet stale for this worker.
      await ageRegistrations("5 minutes");
      await expect(queue.pruneWorkerRegistry(60_000)).resolves.toBe(0);
      await ageRegistrations("7 minutes");
      await expect(queue.pruneWorkerRegistry(60_000)).resolves.toBe(1);
    });
  });

  it("bounds overlap, claims only free slots, and breaks the claim loop on the first null", async () => {
    const release = deferred();
    let active = 0;
    let maxActive = 0;
    for (const sequence of [1, 2]) await queue.enqueue("bounded-batch", { sequence });
    const claim = vi.spyOn(queue, "claimMany");
    const worker = new Worker(queue, {
      workerId: "bounded-batch-worker",
      concurrency: 5,
      pollMs: 1,
    }).handle("bounded-batch", async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await release.promise;
      active -= 1;
      return null;
    });

    try {
      const run = worker.runOnce();
      await vi.waitFor(() => expect(worker.runtimeState().activeSlots).toBe(2), stallWait);

      expect(claim).toHaveBeenCalledTimes(1);
      expect(worker.runtimeState()).toEqual({
        concurrency: 5,
        activeSlots: 2,
        paused: false,
        locallyPaused: false,
        remotelyPaused: false,
        draining: false,
      });

      release.resolve();
      await expect(run).resolves.toBe(true);
      expect(maxActive).toBe(2);
      expect(worker.runtimeState().activeSlots).toBe(0);
    } finally {
      claim.mockRestore();
    }
  });

  it("refills a freed run slot while a sibling handler remains blocked", async () => {
    const firstRelease = deferred();
    const secondRelease = deferred();
    const thirdRelease = deferred();
    const thirdStarted = deferred();
    const started: number[] = [];
    let secondBlocked = true;
    for (const sequence of [1, 2, 3]) await queue.enqueue("continuous-refill", { sequence });
    const worker = new Worker(queue, {
      workerId: "continuous-refill-worker",
      concurrency: 2,
      pollMs: 1_000,
    }).handle<{ sequence: number }>("continuous-refill", async ({ sequence }) => {
      started.push(sequence);
      if (sequence === 1) await firstRelease.promise;
      if (sequence === 2) {
        await secondRelease.promise;
        secondBlocked = false;
      }
      if (sequence === 3) {
        thirdStarted.resolve();
        await thirdRelease.promise;
      }
      return { sequence };
    });

    const running = worker.run();
    try {
      await vi.waitFor(() => expect(started).toEqual([1, 2]), stallWait);
      firstRelease.resolve();
      await thirdStarted.promise;

      expect(secondBlocked).toBe(true);
      expect(started).toEqual([1, 2, 3]);
      expect(worker.runtimeState().activeSlots).toBe(2);
    } finally {
      worker.stop();
      firstRelease.resolve();
      secondRelease.resolve();
      thirdRelease.resolve();
      await running;
    }
  });

  it("serializes public runOnce calls and preserves default single-task compatibility", async () => {
    const firstRelease = deferred();
    const secondRelease = deferred();
    const started: number[] = [];
    for (const sequence of [1, 2]) await queue.enqueue("serialized-run-once", { sequence });
    const worker = new Worker(queue, {
      workerId: "serialized-run-once-worker",
      pollMs: 1,
    }).handle<{ sequence: number }>("serialized-run-once", async ({ sequence }) => {
      started.push(sequence);
      await (sequence === 1 ? firstRelease.promise : secondRelease.promise);
      return { sequence };
    });

    const first = worker.runOnce();
    const second = worker.runOnce();
    await vi.waitFor(() => expect(started).toEqual([1]), stallWait);
    expect(worker.concurrency).toBe(1);
    expect(worker.runtimeState().activeSlots).toBe(1);

    firstRelease.resolve();
    await expect(first).resolves.toBe(true);
    await vi.waitFor(() => expect(started).toEqual([1, 2]), stallWait);
    secondRelease.resolve();
    await expect(second).resolves.toBe(true);
    expect(worker.runtimeState().activeSlots).toBe(0);
  });

  it("keeps batched heartbeats running while paused and does not claim more work", async () => {
    const release = deferred();
    const ids = await Promise.all(
      [1, 2, 3].map((sequence) => queue.enqueue("paused-concurrency", { sequence })),
    );
    // Rounds go to the reserved heartbeat connection, so observe its channel.
    const heartbeat = spyOnReservedHeartbeats();
    const worker = new Worker(queue, {
      workerId: "paused-concurrency-worker",
      concurrency: 2,
      ...loadSafeHeartbeat,
      pollMs: 1,
    }).handle("paused-concurrency", async () => {
      await release.promise;
      return null;
    });

    try {
      const run = worker.runOnce();
      await vi.waitFor(() => expect(worker.runtimeState().activeSlots).toBe(2), stallWait);
      worker.pause();
      await vi.waitFor(() => {
        const heartbeatingIds = new Set(
          heartbeat.mock.calls.flatMap(([tasks]) => tasks.map((task) => task.id)),
        );
        expect(heartbeatingIds.size).toBe(2);
        expect([...heartbeatingIds].every((id) => ids.includes(id))).toBe(true);
      }, stallWait);

      expect(worker.runtimeState()).toMatchObject({ activeSlots: 2, paused: true });
      release.resolve();
      await expect(run).resolves.toBe(true);
      expect(await worker.runOnce()).toBe(false);
      const states = await Promise.all(ids.map(async (id) => (await admin.getTask(id))?.state));
      expect(states.filter((state) => state === "ready")).toHaveLength(1);
      expect(states.filter((state) => state === "succeeded")).toHaveLength(2);
    } finally {
      heartbeat.mockRestore();
    }
  });

  it("batches per-task heartbeats without overlapping a slow batch on the shared pool", async () => {
    const releaseHandlers = deferred();
    // Without connect() the queue cannot reserve a heartbeat connection, so every round waits for
    // the one before it however long that takes.
    const shared = new Queue({
      query: (text: string, values?: readonly unknown[]) => pool.query(text, values as unknown[]),
    });
    const heartbeatGates: ReturnType<typeof deferred<Map<string, "accepted">>>[] = [];
    let heartbeatCalls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    let latestIds: string[] = [];
    for (const sequence of [1, 2]) await shared.enqueue("slow-heartbeat", { sequence });
    vi.spyOn(shared, "heartbeatMany").mockImplementation((tasks) => {
      heartbeatCalls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      latestIds = tasks.map((task) => task.id);
      const gate = deferred<Map<string, "accepted">>();
      heartbeatGates.push(gate);
      return gate.promise.finally(() => {
        inFlight -= 1;
      });
    });
    const worker = new Worker(shared, {
      sharedHeartbeats: true,
      workerId: "slow-heartbeat-worker",
      concurrency: 2,
      heartbeatMs: 10,
      // No round renews while the test holds the first one. A lease of 500 ms could end before a
      // loaded host starts the handlers, so the lease is long enough not to end in the test.
      leaseMs: 30_000,
      pollMs: 1,
    }).handle("slow-heartbeat", async () => {
      await releaseHandlers.promise;
      return null;
    });
    const schedule = worker as unknown as HeartbeatSchedule;
    let holdTimers = false;
    const timers = recordHeartbeatTimers(worker, () => holdTimers);
    const pendingTimers = () => timers.filter((timer) => !timer.fired && !timer.cleared);

    try {
      const run = worker.runOnce();
      await vi.waitFor(() => expect(worker.runtimeState().activeSlots).toBe(2), stallWait);
      await vi.waitFor(() => expect(heartbeatGates).toHaveLength(1), stallWait);
      expect(latestIds).toHaveLength(2);

      // Wait until the next slot has passed while the first round is in flight. The worker holds
      // the round as in flight and has no pending timer, so no second round can start.
      const slotAtFirstRound = schedule.nextHeartbeatAt!;
      await vi.waitFor(
        () => expect(performance.now()).toBeGreaterThan(slotAtFirstRound),
        stallWait,
      );
      expect(schedule.heartbeatInFlight).toBe(true);
      expect(pendingTimers()).toEqual([]);
      expect(heartbeatCalls).toBe(1);
      heartbeatGates[0]!.resolve(new Map(latestIds.map((id) => [id, "accepted"])));
      await vi.waitFor(() => expect(heartbeatCalls).toBe(2), stallWait);
      expect(maxInFlight).toBe(1);

      // The second round ends, and the worker arms the timer of the third round. The test holds
      // that timer, so the third round cannot start.
      holdTimers = true;
      heartbeatGates[1]!.resolve(new Map(latestIds.map((id) => [id, "accepted"])));
      await vi.waitFor(() => expect(pendingTimers()).toHaveLength(1), stallWait);
      const third = pendingTimers()[0]!;
      releaseHandlers.resolve();
      await expect(run).resolves.toBe(true);
      // No lease remains, and the end of the last lease cleared the timer of the third round.
      expect(schedule.heartbeatLeases.size).toBe(0);
      expect(third).toMatchObject({ fired: false, cleared: true });
      expect(pendingTimers()).toEqual([]);
      expect(heartbeatCalls).toBe(2);
    } finally {
      releaseHandlers.resolve();
      for (const gate of heartbeatGates) {
        gate.resolve(new Map(latestIds.map((id) => [id, "accepted"])));
      }
      // Also removes the timer recording, which replaces the global clearTimeout.
      vi.restoreAllMocks();
    }
  });

  it("stops new claims and resolves run only after every active slot drains", async () => {
    const release = deferred();
    const ids = await Promise.all(
      [1, 2, 3].map((sequence) => queue.enqueue("graceful-concurrency-drain", { sequence })),
    );
    const worker = new Worker(queue, {
      workerId: "graceful-concurrency-drain-worker",
      concurrency: 2,
      pollMs: 1,
    }).handle("graceful-concurrency-drain", async () => {
      await release.promise;
      return null;
    });

    const running = worker.run();
    await vi.waitFor(() => expect(worker.runtimeState().activeSlots).toBe(2), stallWait);
    // runOnce() waits for the run to end. The gate is the worker's execution queue: runOnce()
    // joins it behind the run, so it cannot claim while the run holds both slots.
    const execution = worker as unknown as { executionTail: Promise<void> };
    const tailOfRun = execution.executionTail;
    const blockedRunOnce = worker.runOnce();
    let runOnceResolved = false;
    void blockedRunOnce.then(() => {
      runOnceResolved = true;
    });
    expect(execution.executionTail).not.toBe(tailOfRun);
    const states = async () => Promise.all(ids.map(async (id) => (await admin.getTask(id))?.state));
    expect((await states()).filter((state) => state === "ready")).toHaveLength(1);
    expect(runOnceResolved).toBe(false);

    worker.stop();
    // The run settles only after its active slots drain, and both handlers wait for the release.
    expect(worker.runtimeState()).toMatchObject({ activeSlots: 2, draining: true });
    let resolved = false;
    void running.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    release.resolve();
    await expect(running).resolves.toBeUndefined();
    await expect(blockedRunOnce).resolves.toBe(false);
    expect(worker.runtimeState()).toEqual({
      concurrency: 2,
      activeSlots: 0,
      paused: false,
      locallyPaused: false,
      remotelyPaused: false,
      draining: false,
    });
    const finalStates = await states();
    expect(finalStates.filter((state) => state === "ready")).toHaveLength(1);
    expect(finalStates.filter((state) => state === "succeeded")).toHaveLength(2);
  });

  it("drains both active handlers after signal abort without claiming queued work", async () => {
    const controller = new AbortController();
    const releases = [deferred(), deferred()];
    const bothStarted = deferred();
    const startedIds: string[] = [];
    const ids: string[] = [];
    for (const sequence of [0, 1, 2]) {
      ids.push(await queue.enqueue("signal-abort-drain", { sequence }));
    }
    const claim = vi.spyOn(queue, "claimMany");
    // Rounds go to the reserved heartbeat connection, so observe its channel.
    const heartbeat = spyOnReservedHeartbeats();
    const worker = new Worker(queue, {
      workerId: "signal-abort-drain-worker",
      concurrency: 2,
      ...loadSafeHeartbeat,
      pollMs: 1,
    }).handle<{ sequence: number }>("signal-abort-drain", async ({ sequence }, context) => {
      startedIds.push(context.task.id);
      if (startedIds.length === 2) bothStarted.resolve();
      await releases[sequence]!.promise;
      return { sequence };
    });

    const heartbeatCount = (id: string) =>
      heartbeat.mock.calls.filter(([tasks]) => tasks.some((task) => task.id === id)).length;
    const running = worker.run(controller.signal);

    try {
      await bothStarted.promise;
      expect(startedIds).toEqual(ids.slice(0, 2));
      expect(worker.runtimeState()).toMatchObject({ activeSlots: 2, paused: false });

      const countsAtAbort = new Map(ids.slice(0, 2).map((id) => [id, heartbeatCount(id)]));
      controller.abort();
      await vi.waitFor(() => {
        for (const id of ids.slice(0, 2)) {
          expect(heartbeatCount(id)).toBeGreaterThan(countsAtAbort.get(id)!);
        }
      }, stallWait);
      expect(claim).toHaveBeenCalledTimes(1);
      await expect(admin.getTask(ids[2]!)).resolves.toMatchObject({ state: "ready" });

      let runSettled = false;
      void running.then(() => {
        runSettled = true;
      });
      releases[0]!.resolve();
      await vi.waitFor(
        async () => expect((await admin.getTask(ids[0]!))?.state).toBe("succeeded"),
        stallWait,
      );
      expect(runSettled).toBe(false);
      expect(worker.runtimeState().activeSlots).toBe(1);

      const secondCountAfterFirstRelease = heartbeatCount(ids[1]!);
      await vi.waitFor(
        () => expect(heartbeatCount(ids[1]!)).toBeGreaterThan(secondCountAfterFirstRelease),
        stallWait,
      );
      expect(claim).toHaveBeenCalledTimes(1);
      await expect(admin.getTask(ids[2]!)).resolves.toMatchObject({ state: "ready" });

      releases[1]!.resolve();
      await expect(running).resolves.toBeUndefined();
      expect(worker.runtimeState().activeSlots).toBe(0);
      await expect(Promise.all(ids.slice(0, 2).map((id) => admin.getTask(id)))).resolves.toEqual(
        ids.slice(0, 2).map((id) => expect.objectContaining({ id, state: "succeeded" })),
      );
      await expect(admin.getTask(ids[2]!)).resolves.toMatchObject({ state: "ready" });
    } finally {
      controller.abort();
      for (const release of releases) release.resolve();
      await running.catch(() => undefined);
      claim.mockRestore();
      heartbeat.mockRestore();
    }
  });

  it("honors a same-turn stop before run starts without claiming", async () => {
    const id = await queue.enqueue("same-turn-stop", {});
    const claim = vi.spyOn(queue, "claimMany");
    const worker = new Worker(queue, { workerId: "same-turn-stop-worker" }).handle(
      "same-turn-stop",
      () => null,
    );

    try {
      const running = worker.run();
      worker.stop();
      await expect(running).resolves.toBeUndefined();
      expect(claim).not.toHaveBeenCalled();
      await expect(admin.getTask(id)).resolves.toMatchObject({ state: "ready" });
    } finally {
      claim.mockRestore();
    }
  });

  it("honors stop while run is queued behind runOnce without claiming again", async () => {
    const release = deferred();
    const started = deferred();
    const firstId = await queue.enqueue("queued-run-stop", { sequence: 1 });
    const secondId = await queue.enqueue("queued-run-stop", { sequence: 2 });
    const claim = vi.spyOn(queue, "claimMany");
    const worker = new Worker(queue, {
      workerId: "queued-run-stop-worker",
      pollMs: 1,
    }).handle("queued-run-stop", async () => {
      started.resolve();
      await release.promise;
      return [];
    });

    try {
      const once = worker.runOnce();
      await started.promise;
      const queuedRun = worker.run();
      worker.stop();
      release.resolve();

      await expect(once).resolves.toBe(true);
      await expect(queuedRun).resolves.toBeUndefined();
      expect(claim).toHaveBeenCalledTimes(1);
      await expect(admin.getTask(firstId)).resolves.toMatchObject({ state: "succeeded" });
      await expect(admin.getTask(secondId)).resolves.toMatchObject({ state: "ready" });
    } finally {
      release.resolve();
      claim.mockRestore();
    }
  });

  it.each([
    { maxAttempts: 2, expectedState: "ready", expectedAttempt: 2 },
    { maxAttempts: 1, expectedState: "failed", expectedAttempt: 1 },
  ] as const)(
    "settles successful siblings and recovers a concurrent crash with maxAttempts $maxAttempts",
    async ({ maxAttempts, expectedState, expectedAttempt }) => {
      const siblingsStarted = deferred();
      const crashObserved = deferred();
      const releaseSiblings = deferred();
      const startedSiblings = new Set<number>();
      let crashedClaim:
        | { id: string; attempt: number; fenceToken: bigint; leaseExpiresAt: Date }
        | undefined;
      const [crashedId, ...siblingIds] = await Promise.all([
        queue.enqueue("batch-crash-settlement", { sequence: 1 }, { maxAttempts }),
        queue.enqueue("batch-crash-settlement", { sequence: 2 }),
        queue.enqueue("batch-crash-settlement", { sequence: 3 }),
      ]);
      const workerId = `batch-crash-settlement-${maxAttempts}`;
      const worker = new Worker(queue, {
        workerId,
        concurrency: 3,
        leaseMs: 10_000,
        heartbeatMs: 1_000,
        pollMs: 1,
        failpoint: (point, task) => {
          const shouldCrash =
            point === "beforeHandler" && (task.payload as { sequence: number }).sequence === 1;
          if (shouldCrash) {
            crashedClaim = {
              id: task.id,
              attempt: task.attempt,
              fenceToken: task.fenceToken,
              leaseExpiresAt: task.leaseExpiresAt,
            };
            crashObserved.resolve();
          }
          return shouldCrash;
        },
      }).handle<{ sequence: number }>("batch-crash-settlement", async ({ sequence }) => {
        startedSiblings.add(sequence);
        if (startedSiblings.size === 2) siblingsStarted.resolve();
        await releaseSiblings.promise;
        return { sequence };
      });

      const run = worker.runOnce();
      await Promise.all([siblingsStarted.promise, crashObserved.promise]);
      expect(crashedClaim).toBeDefined();
      const crash = crashedClaim!;
      expect(crash).toMatchObject({ id: crashedId, attempt: 1 });

      let settled = false;
      void run.catch(() => {
        settled = true;
      });
      // The pass settles only after every execution ends. Both siblings wait for the release, so
      // their slots stay active.
      expect(worker.runtimeState().activeSlots).toBeGreaterThanOrEqual(2);
      expect(settled).toBe(false);

      releaseSiblings.resolve();
      await expect(run).rejects.toMatchObject({
        name: "InjectedCrashError",
        failpoint: "beforeHandler",
      });
      expect(worker.runtimeState().activeSlots).toBe(0);
      await expect(Promise.all(siblingIds.map((id) => admin.getTask(id)))).resolves.toEqual(
        siblingIds.map((id) => expect.objectContaining({ id, state: "succeeded" })),
      );

      const active = await pool.query<{
        state: string;
        current_attempt: number;
        fence_token: string;
        worker_id: string | null;
        expires_at: Date | null;
      }>(
        `SELECT state, current_attempt, fence_token::text, worker_id, expires_at
         FROM workhorse.task_runtime WHERE task_id = $1`,
        [crashedId],
      );
      expect(active.rows[0]).toEqual({
        state: "active",
        current_attempt: 1,
        fence_token: crash.fenceToken.toString(),
        worker_id: workerId,
        expires_at: crash.leaseExpiresAt,
      });
      await expect(admin.getTask(crashedId)).resolves.toMatchObject({
        state: "active",
        currentAttempt: 1,
        fenceToken: crash.fenceToken,
        result: null,
        error: null,
      });
      expect(
        (
          await pool.query<{ count: number }>(
            "SELECT count(*)::integer AS count FROM workhorse.attempt_history WHERE task_id = $1",
            [crashedId],
          )
        ).rows[0]!.count,
      ).toBe(0);

      await pool.query(
        "UPDATE workhorse.task_runtime SET expires_at = clock_timestamp() - interval '1 ms' WHERE task_id = $1",
        [crashedId],
      );
      expect(await queue.recoverExpired(100, 0)).toBe(1);
      await expect(admin.getTask(crashedId)).resolves.toMatchObject({
        state: expectedState,
        currentAttempt: expectedAttempt,
        result: null,
      });

      const recoveredRuntime = await pool.query<{
        state: string;
        current_attempt: number;
        fence_token: string;
        worker_id: string | null;
        expires_at: Date | null;
      }>(
        `SELECT state, current_attempt, fence_token::text, worker_id, expires_at
         FROM workhorse.task_runtime WHERE task_id = $1`,
        [crashedId],
      );
      const expectedRuntimeRows =
        expectedState === "ready"
          ? [
              {
                state: "ready",
                current_attempt: 2,
                fence_token: "0",
                worker_id: null,
                expires_at: null,
              },
            ]
          : [];
      expect(recoveredRuntime.rows).toEqual(expectedRuntimeRows);
    },
  );

  it("keeps run maintenance cadence independent from active handlers", async () => {
    const release = deferred();
    await queue.enqueue("maintenance-during-handler", {});
    const tick = vi.spyOn(queue, "tick");
    const worker = new Worker(queue, {
      workerId: "maintenance-during-handler-worker",
      // 100 ms is the smallest supported interval. The lease is longer than the 10 s waits, so a
      // slow round cannot end the attempt.
      heartbeatMs: 100,
      leaseMs: 30_000,
      maintenanceIntervalMs: 100,
      // The other intervals are much longer than stallWait. Thus a second tick inside that wait
      // comes only from the 100 ms maintenance cadence.
      maintenanceRoutinePollMs: 60_000,
      pollMs: 60_000,
    }).handle("maintenance-during-handler", async () => {
      await release.promise;
      return null;
    });

    try {
      const running = worker.run();
      await vi.waitFor(() => expect(worker.runtimeState().activeSlots).toBe(1), stallWait);
      await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(2), stallWait);

      worker.stop();
      release.resolve();
      await expect(running).resolves.toBeUndefined();
    } finally {
      // If a wait fails, the handler must still end, or the worker cannot stop after the test.
      release.resolve();
      tick.mockRestore();
    }
  });

  it("does not wake maintenance when a task notification wakes dispatch", async () => {
    let notify: (() => void) | undefined;
    const subscribe = vi
      .spyOn(queue, "subscribeToTaskNotifications")
      .mockImplementation(async (_queueName, onTasksAvailable) => {
        notify = onTasksAvailable;
        return { close: async () => undefined };
      });
    const worker = new Worker(queue, {
      workerId: "notification-dispatch-only",
      pollMs: 15_000,
      maintenanceIntervalMs: 100,
      maintenanceRoutinePollMs: 100,
      registryIntervalMs: 0,
    });
    const maintenancePasses: Array<{ startedAt: number; endedAt?: number }> = [];
    const privateWorker = worker as unknown as { runMaintenance(): Promise<void> };
    const originalRunMaintenance = privateWorker.runMaintenance.bind(worker);
    const runMaintenance = vi
      .spyOn(privateWorker, "runMaintenance")
      .mockImplementation(async () => {
        const pass: { startedAt: number; endedAt?: number } = { startedAt: Date.now() };
        maintenancePasses.push(pass);
        try {
          await originalRunMaintenance();
        } finally {
          pass.endedAt = Date.now();
        }
      });

    const running = worker.run();
    let notificationLoad: NodeJS.Timeout | undefined;
    try {
      await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce(), stallWait);
      expect(runMaintenance).toHaveBeenCalledOnce();
      expect(notify).toBeDefined();
      notificationLoad = setInterval(() => notify?.(), 10);
      // The gaps below are the check. Under load, a maintenance pass can take longer than 100 ms,
      // so the wait for three passes has no short limit. The maintenance loop waits its interval
      // after a pass ends, so each gap starts when the previous pass ends. A notification that woke
      // maintenance would start the next pass at once, however long the passes take.
      await vi.waitFor(() => expect(runMaintenance).toHaveBeenCalledTimes(3), { timeout: 10_000 });
      clearInterval(notificationLoad);
      notificationLoad = undefined;

      for (let index = 1; index < maintenancePasses.length; index += 1) {
        const previous = maintenancePasses[index - 1]!;
        expect(previous.endedAt).toBeTypeOf("number");
        expect(maintenancePasses[index]!.startedAt - previous.endedAt!).toBeGreaterThanOrEqual(80);
      }
    } finally {
      if (notificationLoad) clearInterval(notificationLoad);
      worker.stop();
      await running;
      subscribe.mockRestore();
    }
  });

  it("runs tick and scheduled maintenance routines on independent cadences with phase telemetry", async () => {
    const taskId = await queue.enqueue(
      "scheduled-worker",
      { ok: true },
      { runAt: new Date(Date.now() + 80) },
    );
    await sleep(100);
    await queue.syncMaintenancePolicy({ timezone: "UTC", historyRetentionLocalTime: "00:00" });

    const telemetry: ReturnType<Worker["maintenanceTelemetry"]> = [];
    // The routine poll is due again when maintenanceRoutinePollMs has passed since the start of the
    // first pass. On a loaded host, that pass and the checks after it can take more than 1 s.
    const worker = new Worker(queue, {
      workerId: "worker-maintenance",
      maintenanceIntervalMs: 100,
      maintenanceRoutinePollMs: 60_000,
      onMaintenance: (event) => telemetry.push(event),
    }).handle("scheduled-worker", () => ({ ok: true }));
    expect(await worker.runOnce()).toBe(true);
    expect((await admin.getTask(taskId))?.state).toBe("succeeded");
    expect(telemetry.map(({ loop, phase }) => `${loop}:${phase}`)).toEqual([
      "tick:promote",
      "tick:recover",
      // Statistics roll up before retention so the same pass can reclaim the history it summarized.
      "statistics_rollup:stat_rollup",
      "statistics_rollup:stat_retention",
      "background_routines:enqueue_idempotency",
      "background_routines:released_dependencies",
      "background_routines:terminal_tasks",
      "background_routines:task_groups",
      "background_routines:worker_registry",
      // The partition DDL phases run last, so their parent locks end when the call commits.
      "background_routines:event_retention",
      "background_routines:attempt_retention",
      "background_routines:schedule_occurrences",
      "background_routines:history_partitions",
    ]);
    expect(worker.maintenanceTelemetry()).toEqual(telemetry);

    const firstPassLength = telemetry.length;
    await sleep(110);
    expect(await worker.runOnce()).toBe(false);
    expect(telemetry.slice(firstPassLength).map(({ loop, phase }) => `${loop}:${phase}`)).toEqual([
      "tick:promote",
      "tick:recover",
    ]);

    const tickState = await pool.query<{
      last_started_at: Date | null;
      last_completed_at: Date | null;
    }>(
      `SELECT last_started_at, last_completed_at
         FROM workhorse.maintenance_state
        WHERE routine_name = 'tick'`,
    );
    expect(tickState.rows).toHaveLength(1);
    expect(tickState.rows[0]?.last_started_at).toBeInstanceOf(Date);
    expect(tickState.rows[0]?.last_completed_at).toBeInstanceOf(Date);
  });

  it("claims on each runOnce call while maintenance keeps its own interval", async () => {
    const tickResults: MaintenancePhaseResult[] = [
      { phase: "promote", rowsAffected: 0, durationMs: 0, skippedLock: false, error: null },
      { phase: "recover", rowsAffected: 0, durationMs: 0, skippedLock: false, error: null },
    ];
    const partitionResults: MaintenancePhaseResult[] = [
      {
        phase: "history_partitions",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
    ];
    const retentionResults: MaintenancePhaseResult[] = [
      {
        phase: "event_retention",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
      {
        phase: "attempt_retention",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
      {
        phase: "schedule_occurrences",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
    ];
    const terminalResults: MaintenancePhaseResult[] = [
      {
        phase: "enqueue_idempotency",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
      {
        phase: "released_dependencies",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
      {
        phase: "terminal_tasks",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
    ];
    // The worker measures its maintenance cadence on monotonicNow(), which reads performance.now().
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const tick = vi.spyOn(queue, "tick").mockResolvedValue(tickResults);
    const prepareHistoryPartitions = vi
      .spyOn(queue, "prepareHistoryPartitions")
      .mockResolvedValue(partitionResults);
    const retainHistory = vi.spyOn(queue, "retainHistory").mockResolvedValue(retentionResults);
    const pruneTerminalStorage = vi
      .spyOn(queue, "pruneTerminalStorage")
      .mockResolvedValue(terminalResults);
    const claim = vi.spyOn(queue, "claimMany").mockResolvedValue([]);

    try {
      const worker = new Worker(queue, {
        workerId: "idle-cadence",
        pollMs: 15_000,
        maintenanceIntervalMs: 1_000,
        maintenanceRoutinePollMs: 60_000,
      });

      await worker.runOnce();
      now.mockReturnValue(1_000);
      await worker.runOnce();
      now.mockReturnValue(2_000);
      await worker.runOnce();
      now.mockReturnValue(14_999);
      await worker.runOnce();

      expect(tick).toHaveBeenCalledTimes(4);
      // The single-pass call keeps no state between calls (ADR 0099), so pollMs does not delay
      // the next claim. A caller that loops on runOnce() waits after false.
      expect(claim).toHaveBeenCalledTimes(4);

      now.mockReturnValue(15_000);
      await worker.runOnce();
      expect(tick).toHaveBeenCalledTimes(4);
      expect(claim).toHaveBeenCalledTimes(5);
    } finally {
      now.mockRestore();
      tick.mockRestore();
      prepareHistoryPartitions.mockRestore();
      retainHistory.mockRestore();
      pruneTerminalStorage.mockRestore();
      claim.mockRestore();
    }
  });

  it("wakes idle dispatch when PostgreSQL notifies a matching queue", async () => {
    const handled: string[] = [];
    const claim = vi.spyOn(queue, "claimMany");
    const worker = new Worker(queue, {
      workerId: "notification-dispatch",
      pollMs: 15_000,
      registryIntervalMs: 0,
    }).handle<{ message: string }>("notification-dispatch", ({ message }) => {
      handled.push(message);
      return null;
    });

    const running = worker.run();
    try {
      await vi.waitFor(() => expect(claim).toHaveBeenCalled(), stallWait);
      await queue.enqueue("notification-dispatch", { message: "prompt" });

      await vi.waitFor(() => expect(handled).toEqual(["prompt"]), notificationWait);
    } finally {
      worker.stop();
      await running;
      claim.mockRestore();
    }
  });

  it("wakes a policy-blocked worker when another process releases capacity", async () => {
    const queueName = `capacity-wake-${randomUUID()}`;
    const policyQueue = new Queue(pool, queueName);
    await policyQueue.syncConcurrencyPolicies("test", [{ queue: queueName, maxActive: 1 }]);
    const firstId = await policyQueue.enqueue("capacity-wake", { ordinal: 1 });
    const secondId = await policyQueue.enqueue("capacity-wake", { ordinal: 2 });
    const held = await policyQueue.claim("capacity-holder", { queue: queueName });
    expect(held?.id).toBe(firstId);

    const handled: string[] = [];
    const worker = new Worker(policyQueue, {
      workerId: "capacity-waiter",
      pollMs: 15_000,
      registryIntervalMs: 0,
    }).handle("capacity-wake", (_payload, context) => {
      handled.push(context.task.id);
      return null;
    });

    const running = worker.run();
    try {
      await sleep(100);
      expect(handled).toEqual([]);
      await expect(policyQueue.complete(held!, "capacity-holder", null)).resolves.toBe(true);
      await vi.waitFor(() => expect(handled).toEqual([secondId]), notificationWait);
    } finally {
      worker.stop();
      await running;
    }
  });

  it("latches a notification that arrives while an empty claim is in flight", async () => {
    const claimStarted = deferred();
    const releaseEmptyClaim = deferred();
    const handled: string[] = [];
    const claim = vi.spyOn(queue, "claimMany").mockImplementationOnce(async () => {
      claimStarted.resolve();
      await releaseEmptyClaim.promise;
      return [];
    });
    const worker = new Worker(queue, {
      workerId: "notification-during-claim",
      pollMs: 15_000,
      registryIntervalMs: 0,
    }).handle<{ message: string }>("notification-during-claim", ({ message }) => {
      handled.push(message);
      return null;
    });

    const running = worker.run();
    try {
      await claimStarted.promise;
      await vi.waitFor(async () => {
        const listeners = await pool.query<{ count: number }>(
          `SELECT count(*)::integer AS count
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND state = 'idle'
              AND query = 'LISTEN workhorse_tasks'`,
        );
        expect(listeners.rows[0]?.count).toBeGreaterThan(0);
      }, stallWait);
      await queue.enqueue("notification-during-claim", { message: "latched" });
      releaseEmptyClaim.resolve();

      await vi.waitFor(() => expect(handled).toEqual(["latched"]), notificationWait);
    } finally {
      worker.stop();
      releaseEmptyClaim.resolve();
      await running;
      claim.mockRestore();
    }
  });

  it("reconnects notification dispatch after PostgreSQL terminates the listener", async () => {
    const handled: string[] = [];
    const notificationErrors: unknown[] = [];
    const worker = new Worker(queue, {
      workerId: "notification-reconnect",
      pollMs: 15_000,
      registryIntervalMs: 0,
      onNotificationError: (error) => notificationErrors.push(error),
    }).handle<{ message: string }>("notification-reconnect", ({ message }) => {
      handled.push(message);
      return null;
    });

    const running = worker.run();
    try {
      const listenerPid = await vi.waitFor(async () => {
        const listeners = await pool.query<{ pid: number }>(
          `SELECT pid
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND state = 'idle'
              AND query = 'LISTEN workhorse_tasks'
            ORDER BY backend_start DESC
            LIMIT 1`,
        );
        expect(listeners.rows[0]?.pid).toBeDefined();
        return listeners.rows[0]!.pid;
      }, stallWait);
      await pool.query("SELECT pg_terminate_backend($1)", [listenerPid]);
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });

      await queue.enqueue("notification-reconnect", { message: "after reconnect" });

      await vi.waitFor(() => expect(handled).toEqual(["after reconnect"]), notificationWait);
      expect(notificationErrors).toHaveLength(1);
      expect(notificationErrors[0]).toBeInstanceOf(Error);
    } finally {
      worker.stop();
      await running;
    }
  });

  it("survives PostgreSQL terminating the idle heartbeat connection and resumes heartbeats", async () => {
    const kind = `heartbeat-reconnect-${randomUUID()}`;
    const finished: string[] = [];
    const releases = new Map<string, ReturnType<typeof deferred<void>>>();
    const worker = new Worker(queue, {
      workerId: kind,
      // 100 ms is the smallest supported interval.
      heartbeatMs: 100,
      leaseMs: 5_000,
      pollMs: 50,
      registryIntervalMs: 0,
    }).handle<{ step: string }>(kind, async ({ step }) => {
      await releases.get(step)!.promise;
      finished.push(step);
      return null;
    });

    const running = worker.run();
    try {
      releases.set("before", deferred());
      await queue.enqueue(kind, { step: "before" });
      const [terminatedPid] = await vi.waitFor(async () => {
        const pids = await heartbeatBackends();
        expect(pids).toHaveLength(1);
        return pids;
      }, stallWait);
      releases.get("before")!.resolve();
      await vi.waitFor(() => expect(finished).toEqual(["before"]), stallWait);

      // The worker is idle and still holds the connection, so the error arrives outside a round.
      await pool.query("SELECT pg_terminate_backend($1)", [terminatedPid]);
      await sleep(100);

      releases.set("after", deferred());
      await queue.enqueue(kind, { step: "after" });
      await vi.waitFor(async () => {
        const pids = await heartbeatBackends();
        expect(pids).toHaveLength(1);
        expect(pids[0]).not.toBe(terminatedPid);
      }, stallWait);
      releases.get("after")!.resolve();
      await vi.waitFor(() => expect(finished).toEqual(["before", "after"]), stallWait);
    } finally {
      for (const release of releases.values()) release.resolve();
      worker.stop();
      await running;
    }
  });

  it("keeps bounded polling as the fallback when the database cannot LISTEN", async () => {
    const pollingQueue = new Queue({ query: pool.query.bind(pool) });
    const handled: string[] = [];
    const realClaim = pollingQueue.claimMany.bind(pollingQueue);
    let claimsInFlight = 0;
    let emptyClaims = 0;
    const claim = vi.spyOn(pollingQueue, "claimMany").mockImplementation(async (...args) => {
      claimsInFlight += 1;
      try {
        const tasks = await realClaim(...args);
        if (tasks.length === 0) emptyClaims += 1;
        return tasks;
      } finally {
        claimsInFlight -= 1;
      }
    });
    const worker = new Worker(pollingQueue, {
      sharedHeartbeats: true,
      workerId: "notification-fallback",
      pollMs: 100,
      registryIntervalMs: 0,
    }).handle<{ message: string }>("notification-fallback", ({ message }) => {
      handled.push(message);
      return null;
    });

    const running = worker.run();
    try {
      // A claim that starts before the enqueue can find the task without a poll (SM-1788). So the
      // test enqueues only after an empty claim answers and no claim is in flight. Then only the
      // poll timer can start the claim that finds the task.
      await vi.waitFor(() => {
        expect(emptyClaims).toBeGreaterThan(0);
        expect(claimsInFlight).toBe(0);
      }, stallWait);
      await queue.enqueue("notification-fallback", { message: "polled" });

      await vi.waitFor(() => expect(handled).toEqual(["polled"]), stallWait);
    } finally {
      worker.stop();
      await running;
      claim.mockRestore();
    }
  });

  it("starts polling and stops while the initial LISTEN connection is still pending", async () => {
    const pendingListenerDatabase = {
      query: pool.query.bind(pool),
      connect: () =>
        new Promise<never>(() => {
          // This connection stays pending until the worker stops.
        }),
    };
    const pendingQueue = new Queue(pendingListenerDatabase);
    const claimTimes: number[] = [];
    const claim = vi.spyOn(pendingQueue, "claimMany").mockImplementation(async () => {
      claimTimes.push(performance.now());
      return [];
    });
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    // The stalled-connect wrapper states no pool size, so it cannot lend a heartbeat connection.
    const worker = new Worker(pendingQueue, {
      sharedHeartbeats: true,
      workerId: "notification-pending-listener",
      pollMs: 100,
      registryIntervalMs: 0,
    });

    const running = worker.run();
    try {
      await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(3), stallWait);
      const firstWait = claimTimes[1]! - claimTimes[0]!;
      const secondWait = claimTimes[2]! - claimTimes[1]!;
      expect(secondWait).toBeGreaterThan(firstWait * 1.5);
    } finally {
      worker.stop();
      await expect(running).resolves.toBeUndefined();
      random.mockRestore();
      claim.mockRestore();
    }
  });

  it("starts polling and stops while the initial LISTEN query is still pending", async () => {
    const listener = {
      query: vi.fn<() => Promise<never>>(
        () =>
          new Promise<never>(() => {
            // This query stays pending until the worker stops.
          }),
      ),
      on: vi.fn<() => void>(),
      removeListener: vi.fn<() => void>(),
      release: vi.fn<(error?: Error) => void>(),
    };
    // The pool states its size, so the worker starts the listener under the opt-out (SM-1585).
    const pendingListenerDatabase = {
      query: pool.query.bind(pool),
      connect: async () => listener,
      options: { max: 2 },
    };
    const pendingQueue = new Queue(pendingListenerDatabase);
    const claim = vi.spyOn(pendingQueue, "claimMany");
    const worker = new Worker(pendingQueue, {
      sharedHeartbeats: true,
      workerId: "notification-pending-listen",
      pollMs: 100,
      registryIntervalMs: 0,
    });

    const running = worker.run();
    await vi.waitFor(() => expect(claim).toHaveBeenCalled(), stallWait);
    worker.stop();
    await expect(running).resolves.toBeUndefined();
    expect(listener.release).toHaveBeenCalledWith(expect.any(Error));
    claim.mockRestore();
  });

  it("keeps single-connection pools polling-only so LISTEN cannot block claims", async () => {
    const singleConnectionPool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      expect(new Queue(singleConnectionPool).supportsTaskNotifications()).toBe(false);
    } finally {
      await singleConnectionPool.end();
    }
  });

  it("notifies only the queue whose scheduled work was promoted", async () => {
    const queueName = `notification-routing-${randomUUID()}`;
    const handled: string[] = [];
    // The worker also polls, at most 5 s apart, so a claim does not prove a notification. Count the
    // wakes that the notification listener gives the worker.
    let wakes = 0;
    const subscribeToTaskNotifications = queue.subscribeToTaskNotifications.bind(queue);
    const subscribe = vi
      .spyOn(queue, "subscribeToTaskNotifications")
      .mockImplementation((subscribedQueue, wake, error) =>
        subscribeToTaskNotifications(
          subscribedQueue,
          () => {
            wakes += 1;
            wake();
          },
          error,
        ),
      );
    const worker = new Worker(queue, {
      queue: queueName,
      workerId: "notification-routing",
      pollMs: 15_000,
      // Only the promote() calls below may promote the tasks of this test.
      maintenanceIntervalMs: 3_600_000,
      maintenanceRoutinePollMs: 3_600_000,
      registryIntervalMs: 0,
    }).handle<{ message: string }>("notification-routing", ({ message }) => {
      handled.push(message);
      return null;
    });
    let maintenancePasses = 0;
    const privateWorker = worker as unknown as { runMaintenance(): Promise<void> };
    const runMaintenance = privateWorker.runMaintenance.bind(worker);
    vi.spyOn(privateWorker, "runMaintenance").mockImplementation(async () => {
      await runMaintenance();
      maintenancePasses += 1;
    });
    // A task that is enqueued after its run time is ready at once, and the enqueue notifies. Each
    // task starts an hour ahead, and the test moves it into the past, so only promote() notifies.
    const promoteScheduled = async (
      type: string,
      taskQueue: string,
      payload: { message: string } | null,
    ) => {
      const id = await queue.enqueue(type, payload, {
        queue: taskQueue,
        runAt: new Date(Date.now() + 3_600_000),
      });
      expect((await admin.getTask(id))?.state).toBe("scheduled");
      await pool.query(
        `UPDATE workhorse.task_runtime SET run_at = clock_timestamp() - interval '1 second'
          WHERE task_id = $1`,
        [id],
      );
      expect(await queue.promote()).toBe(1);
    };

    const running = worker.run();
    try {
      // The listener wakes the worker once when its LISTEN starts.
      await vi.waitFor(() => expect(wakes).toBe(1), { timeout: 10_000 });
      await vi.waitFor(() => expect(maintenancePasses).toBe(1), { timeout: 10_000 });
      await promoteScheduled("other-queue-notification", `${queueName}-other`, null);
      await sleep(50);
      expect(wakes).toBe(1);

      await promoteScheduled("notification-routing", queueName, { message: "promoted" });
      await vi.waitFor(() => expect(wakes).toBe(2), { timeout: 10_000 });
      await vi.waitFor(() => expect(handled).toEqual(["promoted"]), { timeout: 10_000 });
    } finally {
      worker.stop();
      await running;
      subscribe.mockRestore();
    }
  });

  it("shares one notification connection across workers backed by the same pool", async () => {
    const firstQueue = new Queue(pool, `notification-shared-${randomUUID()}`);
    const secondQueue = new Queue(pool, `notification-shared-${randomUUID()}`);
    const firstClaim = vi.spyOn(firstQueue, "claimMany");
    const secondClaim = vi.spyOn(secondQueue, "claimMany");
    const first = new Worker(firstQueue, {
      workerId: "notification-shared-first",
      pollMs: 15_000,
      registryIntervalMs: 0,
    });
    const second = new Worker(secondQueue, {
      workerId: "notification-shared-second",
      pollMs: 15_000,
      registryIntervalMs: 0,
    });

    const firstRun = first.run();
    const secondRun = second.run();
    try {
      await vi.waitFor(() => {
        expect(firstClaim).toHaveBeenCalled();
        expect(secondClaim).toHaveBeenCalled();
      }, stallWait);
      const listeners = await pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND state = 'idle'
            AND query = 'LISTEN workhorse_tasks'`,
      );

      expect(listeners.rows).toEqual([{ count: 1 }]);
    } finally {
      first.stop();
      second.stop();
      await Promise.all([firstRun, secondRun]);
      firstClaim.mockRestore();
      secondClaim.mockRestore();
    }

    const listenersAfterStop = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND state = 'idle'
          AND query = 'LISTEN workhorse_tasks'`,
    );
    expect(listenersAfterStop.rows).toEqual([{ count: 0 }]);
  });

  it("offers schedule namespaces when another worker owns the maintenance tick", async () => {
    const skippedTick: MaintenancePhaseResult[] = [
      { phase: "promote", rowsAffected: 0, durationMs: 0, skippedLock: true, error: null },
      { phase: "recover", rowsAffected: 0, durationMs: 0, skippedLock: true, error: null },
    ];
    // The worker measures its maintenance cadence on monotonicNow(), which reads performance.now().
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const tick = vi.spyOn(queue, "tick").mockResolvedValue(skippedTick);
    const prepareHistoryPartitions = vi
      .spyOn(queue, "prepareHistoryPartitions")
      .mockResolvedValue([]);
    const retainHistory = vi.spyOn(queue, "retainHistory").mockResolvedValue([]);
    const pruneTerminalStorage = vi.spyOn(queue, "pruneTerminalStorage").mockResolvedValue([]);
    const fireDueSchedules = vi.spyOn(queue, "fireDueSchedules").mockResolvedValue();
    const claim = vi.spyOn(queue, "claimMany").mockResolvedValue([]);

    try {
      const worker = new Worker(queue, {
        workerId: "schedule-lock-gate",
        pollMs: 15_000,
        maintenanceIntervalMs: 100,
        scheduleNamespaces: ["integration"],
      });

      await worker.runOnce();
      expect(fireDueSchedules).toHaveBeenCalledOnce();
      expect(fireDueSchedules.mock.calls[0]?.[0]).toEqual(["integration"]);

      now.mockReturnValue(100);
      await worker.runOnce();
      expect(fireDueSchedules).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
      tick.mockRestore();
      prepareHistoryPartitions.mockRestore();
      retainHistory.mockRestore();
      pruneTerminalStorage.mockRestore();
      fireDueSchedules.mockRestore();
      claim.mockRestore();
    }
  });

  it("runs a registered handler end to end", async () => {
    const id = await queue.enqueue("sum", { a: 2, b: 3 });
    const worker = new Worker(queue, { workerId: "worker-a" }).handle<
      { a: number; b: number },
      { total: number }
    >("sum", ({ a, b }) => ({ total: a + b }));
    expect(await worker.runOnce()).toBe(true);
    expect((await admin.getTask<{ total: number }>(id))?.result).toEqual({ total: 5 });
  });

  it.each([
    ["afterClaim", 0, "active"],
    ["beforeHandler", 0, "active"],
    ["afterHandler", 1, "active"],
    ["beforeComplete", 1, "active"],
    ["afterComplete", 1, "succeeded"],
  ] as const)("models a crash at %s", async (failpoint, expectedEffects, expectedState) => {
    const id = await queue.enqueue("work", {}, { maxAttempts: 2 });
    let effects = 0;
    // The lease leaves room for a loaded database: the local lease watchdog aborts a handler whose
    // renewal has not been accepted within one lease, which would preempt the modeled crash.
    const worker = new Worker(queue, {
      workerId: "crashing-worker",
      leaseMs: 500,
      heartbeatMs: 100,
      failpoint,
    }).handle("work", () => {
      effects += 1;
      return { ok: true };
    });

    await expect(worker.runOnce()).rejects.toBeInstanceOf(InjectedCrashError);
    expect(effects).toBe(expectedEffects);
    expect((await admin.getTask(id))?.state).toBe(expectedState);

    if (expectedState === "active") await sleep(530);
    const recovered = await queue.recoverExpired();
    const stateAfterRecovery = (await admin.getTask(id))?.state;
    expect(recovered).toBe(expectedState === "active" ? 1 : 0);
    expect(stateAfterRecovery).toBe(expectedState === "active" ? "ready" : "succeeded");
  });
  it("lets running workers drain work while a paused worker stops claiming until resumed", async () => {
    const handledBy: string[] = [];
    const pausedWorker = new Worker(queue, {
      workerId: "paused-worker",
      pollMs: 1,
    }).handle<{ sequence: number }>("pause-control", ({ sequence }) => {
      handledBy.push(`paused:${sequence}`);
      return { sequence };
    });
    const runningWorker = new Worker(queue, {
      workerId: "running-worker",
      pollMs: 1,
    }).handle<{ sequence: number }>("pause-control", ({ sequence }) => {
      handledBy.push(`running:${sequence}`);
      return { sequence };
    });
    const initialIds: string[] = [];
    for (const sequence of [1, 2, 3]) {
      initialIds.push(await queue.enqueue("pause-control", { sequence }));
    }

    pausedWorker.pause();
    expect(pausedWorker.isPaused()).toBe(true);
    expect(await pausedWorker.runOnce()).toBe(false);
    while (await runningWorker.runOnce()) {
      // Drain all ready work without allowing the paused worker to compete for claims.
    }

    expect(handledBy).toEqual(["running:1", "running:2", "running:3"]);
    await expect(Promise.all(initialIds.map((id) => admin.getTask(id)))).resolves.toEqual(
      initialIds.map((id) => expect.objectContaining({ id, state: "succeeded" })),
    );

    const resumedId = await queue.enqueue("pause-control", { sequence: 4 });
    pausedWorker.resume();
    expect(pausedWorker.isPaused()).toBe(false);
    expect(await pausedWorker.runOnce()).toBe(true);
    expect(handledBy.at(-1)).toBe("paused:4");
    await expect(admin.getTask(resumedId)).resolves.toMatchObject({ state: "succeeded" });
  });

  it("allows an active task to finish after its worker is paused", async () => {
    let releaseHandler!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const worker = new Worker(queue, {
      workerId: "pause-in-flight",
      // 100 ms is the smallest supported interval. The lease is longer than the 20 s test timeout,
      // so a slow round cannot end the attempt.
      heartbeatMs: 100,
      leaseMs: 30_000,
    }).handle("pause-in-flight", async () => {
      markStarted();
      await released;
      return { completedWhilePaused: true };
    });
    const taskId = await queue.enqueue("pause-in-flight", {});

    const run = worker.runOnce();
    await started;
    worker.pause();
    releaseHandler();

    await expect(run).resolves.toBe(true);
    expect(worker.isPaused()).toBe(true);
    await expect(admin.getTask(taskId)).resolves.toMatchObject({
      state: "succeeded",
      result: { completedWhilePaused: true },
    });
    expect(await worker.runOnce()).toBe(false);
  });
});
