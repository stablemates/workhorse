/**
 * The fleet view: declared capacity, slot use, pause, and drain.
 *
 * One piece of the demo integration suite. Every piece owns a scratch database, so the pieces run
 * in parallel; see ./support/demo-integration.ts for the harness they share.
 */
import { describe, expect, it } from "vitest";
import { dashboardDatabase } from "@stablemates/workhorse-dashboard/server";
import { readDashboardWorkers } from "../../dashboard-server/src/server/read-model.js";
import { createLocalOperator, DEMO_WORKER_CONCURRENCY } from "../src/app.js";
import {
  TEST_CONTROL_WINDOW_TASK_MS,
  TEST_OBSERVABLE_TASK_MS,
  createDemoIntegrationSuite,
} from "./support/demo-integration.js";

const {
  createTestApplication,
  dashboardClient,
  database,
  pool,
  waitFor,
  waitForRegisteredWorker,
  waitForWorker,
} = createDemoIntegrationSuite(import.meta.url);

describe("Workhorse demo", () => {
  it("reports overlapping slots and keeps active work running when a worker is paused", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
      longRunningTaskMs: TEST_CONTROL_WINDOW_TASK_MS,
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      // Wait for both unnamed workers before enqueueing enough work to fill either worker's slots.
      await waitForRegisteredWorker(client);

      const enqueued = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          client.dashboard.enqueueTest({
            kind: "long-running",
            audit: {
              actor: "operator",
              reason: "fill slots",
              requestId: `slots-${index + 1}`,
            },
          }),
        ),
      );

      const busyFleet = await waitFor(
        () => client.dashboard.workers(),
        (page) => page.workers.some((worker) => worker.activeSlots === 3),
      );
      const overlapped = busyFleet.workers.find((worker) => worker.activeSlots === 3)!;
      expect(overlapped).toMatchObject({ concurrency: 3, activeSlots: 3, paused: false });
      // SQL-observed active tasks and in-process slots describe the same overlap from two sources.
      expect(overlapped.activeTasks).toBe(3);

      await expect(
        client.dashboard.setWorkerPaused({
          workerId: overlapped.id,
          paused: true,
          audit: { actor: "operator", reason: "pause while busy", requestId: "slots-pause" },
        }),
      ).resolves.toEqual({ paused: true });

      // Pause stops new claims only, so both in-flight handlers keep their slots.
      const paused = (await client.dashboard.workers()).workers.find(
        (worker) => worker.id === overlapped.id,
      );
      expect(paused).toMatchObject({ paused: true, activeSlots: 3, concurrency: 3 });

      for (const { taskId } of enqueued) {
        const detail = await waitFor(
          () => client.dashboard.taskDetail({ id: taskId }),
          (value) => value.identity.state === "succeeded",
          2_000,
        );
        expect(detail.identity.state).toBe("succeeded");
      }

      const drained = await waitForWorker(
        client,
        overlapped.id,
        (worker) => worker.activeSlots === 0,
      );
      expect(drained).toMatchObject({ paused: true, activeSlots: 0, draining: false });

      expect(
        (
          await pool.query(
            `SELECT target, before, after FROM public.workhorse_demo_audit
              WHERE request_id = 'slots-pause'`,
          )
        ).rows,
      ).toEqual([
        {
          target: `worker:${overlapped.id}`,
          before: { paused: false },
          after: { paused: true },
        },
      ]);
    } finally {
      await workhorse.stop();
    }
  }, 60_000);

  it("reports unknown capacity for a declared worker that has never registered", async () => {
    // The demo declares no fleet, because real deployments do not name their workers. Hosts that do
    // declare one still get an expected-but-never-started worker rendered with unknown capacity
    // rather than an implied zero or one slot.
    await expect(
      readDashboardWorkers(dashboardDatabase(pool), ["expected-worker-a", "expected-worker-b"]),
    ).resolves.toMatchObject({
      canManageWorkers: false,
      workers: [
        {
          id: "expected-worker-a",
          registered: false,
          concurrency: null,
          activeSlots: null,
          draining: false,
          lastHeartbeatAt: null,
        },
        {
          id: "expected-worker-b",
          registered: false,
          concurrency: null,
          activeSlots: null,
          draining: false,
          lastHeartbeatAt: null,
        },
      ],
    });
  });

  it("reports declared capacity and slot use in the snapshot from the durable registry", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
      longRunningTaskMs: TEST_OBSERVABLE_TASK_MS,
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      await client.dashboard.enqueueTest({
        kind: "long-running",
        audit: { actor: "operator", reason: "snapshot capacity", requestId: "snapshot-slots" },
      });
      await waitFor(
        () => client.dashboard.workers(),
        (page) => page.workers.some((worker) => worker.activeSlots === 1),
      );

      // No declared fleet is configured: the page discovers workers from the registry alone. The
      // read is a pure SQL projection with no process-local worker handle, yet it still reports
      // declared capacity and slot use because workers publish both to the durable registry.
      // SQL-observed active tasks remain a separate, independently sourced number.
      const page = await client.dashboard.workers();
      expect(page.workers.map((worker) => worker.activeTasks).reduce((a, b) => a + b, 0)).toBe(1);
      expect(page.workers).toHaveLength(DEMO_WORKER_CONCURRENCY.length);
      expect(page.workers.map((worker) => worker.concurrency)).toEqual([3, 3, 3]);
      for (const worker of page.workers) {
        expect(worker).toMatchObject({ registered: true, draining: false });
        expect(worker.activeSlots).not.toBeNull();
      }
    } finally {
      await workhorse.stop();
    }
  });

  it("reports a worker as draining while shutdown waits on an in-flight handler", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
      longRunningTaskMs: TEST_OBSERVABLE_TASK_MS,
    });
    const client = dashboardClient(app);
    workhorse.start();
    let quiesced: Promise<void> | null = null;

    try {
      const enqueued = await client.dashboard.enqueueTest({
        kind: "long-running",
        audit: { actor: "operator", reason: "observe draining", requestId: "drain-one" },
      });
      const busy = await waitFor(
        () => client.dashboard.workers(),
        (page) => page.workers.some((worker) => worker.activeSlots === 1),
      );
      const busyWorker = busy.workers.find((worker) => worker.activeSlots === 1)!;
      expect(busyWorker.draining).toBe(false);

      // quiesce stops claiming immediately and then waits for the running handler to finish.
      quiesced = workhorse.quiesce();
      const draining = await waitForWorker(
        client,
        busyWorker.id,
        (worker) => worker.draining || worker.activeSlots === 0,
      );
      expect(draining).toMatchObject({ draining: true, activeSlots: 1 });

      await quiesced;
      quiesced = null;
      await expect(client.dashboard.taskDetail({ id: enqueued.taskId })).resolves.toMatchObject({
        identity: { state: "succeeded" },
      });
      // A drained worker has stopped, so it deregisters. The demo declares no expected fleet, so it
      // simply leaves the list rather than lingering as an offline row nobody asked for.
      const afterDrain = await client.dashboard.workers();
      expect(afterDrain.workers.map((worker) => worker.id)).not.toContain(busyWorker.id);
    } finally {
      if (quiesced) await quiesced;
      await workhorse.stop();
    }
  });
});
