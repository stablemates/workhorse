import { describe, expect, it } from "vitest";
import { trackWorkerRuns } from "./support/worker-runs.js";

// A stand-in for Worker: run() resolves or rejects only after stop(), as a worker loop does.
class FakeWorker {
  stops = 0;
  private finish?: () => void;

  constructor(
    readonly id: string,
    private readonly outcome: "resolve" | "reject" | "hang" = "resolve",
  ) {}

  run(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.finish = () => {
        if (this.outcome === "resolve") resolve();
        if (this.outcome === "reject") reject(new Error(`${this.id} failed`));
      };
    });
  }

  stop(): void {
    this.stops += 1;
    this.finish?.();
  }
}

describe("worker run tracking", () => {
  it("stops a worker that the test leaves running", async () => {
    const tracking = trackWorkerRuns(FakeWorker.prototype);
    const worker = new FakeWorker("left-running");
    const run = worker.run();

    await tracking.stopAll();

    expect(worker.stops).toBe(1);
    await expect(run).resolves.toBeUndefined();
  });

  it("accepts a worker that the test stopped itself", async () => {
    const tracking = trackWorkerRuns(FakeWorker.prototype);
    const worker = new FakeWorker("stopped-by-test");
    const run = worker.run();
    worker.stop();
    await run;

    await expect(tracking.stopAll()).resolves.toBeUndefined();
    expect(worker.stops).toBe(1);
  });

  it("leaves a rejection to the test that handled it", async () => {
    const tracking = trackWorkerRuns(FakeWorker.prototype);
    const worker = new FakeWorker("rejected-in-test", "reject");
    const run = worker.run();
    worker.stop();
    await expect(run).rejects.toThrow("rejected-in-test failed");

    await expect(tracking.stopAll()).resolves.toBeUndefined();
    expect(worker.stops).toBe(1);
  });

  it("passes a rejection after stop to the promise of the test", async () => {
    const tracking = trackWorkerRuns(FakeWorker.prototype);
    const worker = new FakeWorker("rejects-on-stop", "reject");
    const run = worker.run();

    // The tracker does not handle this rejection. Without the handler below, it is unhandled.
    await expect(tracking.stopAll()).resolves.toBeUndefined();
    expect(worker.stops).toBe(1);
    await expect(run).rejects.toThrow("rejects-on-stop failed");
  });

  it("names a worker whose run does not end after stop", async () => {
    const tracking = trackWorkerRuns(FakeWorker.prototype, 20);
    const stopped = new FakeWorker("stops");
    const hanging = new FakeWorker("never-ends", "hang");
    void stopped.run();
    void hanging.run();

    await expect(tracking.stopAll()).rejects.toThrow(
      "A worker run started by this test did not end within 20 ms of stop(): never-ends",
    );
  });

  it("restores run and stops recording after stopAll", async () => {
    const originalRun = FakeWorker.prototype.run;
    const tracking = trackWorkerRuns(FakeWorker.prototype, 20);
    expect(FakeWorker.prototype.run).not.toBe(originalRun);
    void new FakeWorker("hangs", "hang").run();

    await expect(tracking.stopAll()).rejects.toThrow("hangs");
    expect(FakeWorker.prototype.run).toBe(originalRun);

    const later = new FakeWorker("after-restore");
    void later.run();
    await expect(trackWorkerRuns(FakeWorker.prototype).stopAll()).resolves.toBeUndefined();
    expect(later.stops).toBe(0);
  });
});
