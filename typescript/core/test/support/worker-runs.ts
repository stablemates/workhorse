import { Worker } from "../../src/index.js";

type RunnableWorker = {
  readonly id: string;
  run(signal?: AbortSignal): Promise<void>;
  stop(): void;
};

type RecordedRun = { worker: RunnableWorker; ended: Promise<void>; running: boolean };

/**
 * Records each `run()` that starts on `prototype` until `stopAll()`, so that a test hook can stop
 * the runs that a test leaves. If a test fails before it calls `stop()`, its worker continues to
 * run into the next test. That worker can deadlock the reset of the next test (SM-1436).
 *
 * The test gets a separate promise that settles as the run settles. The tracker reads only the
 * promise of the run. Thus a rejection that the test does not handle stays an unhandled rejection,
 * also when it occurs after `stopAll()`. `stopAll()` stops each run that did not end, and fails if
 * a run does not end in `stopTimeoutMs`.
 */
export function trackWorkerRuns(
  prototype: RunnableWorker = Worker.prototype,
  stopTimeoutMs = 30_000,
): { stopAll: () => Promise<void> } {
  const original = prototype.run;
  const runs: RecordedRun[] = [];
  prototype.run = function (this: RunnableWorker, signal?: AbortSignal) {
    const promise = original.call(this, signal);
    const run: RecordedRun = { worker: this, ended: Promise.resolve(), running: true };
    run.ended = promise.then(
      () => {
        run.running = false;
      },
      () => {
        run.running = false;
      },
    );
    runs.push(run);
    return new Promise<void>((resolve, reject) => {
      promise.then(resolve, reject);
    });
  };

  return {
    async stopAll() {
      try {
        const leftRunning = runs.filter((run) => run.running);
        for (const { worker } of leftRunning) worker.stop();
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.all(leftRunning.map((run) => run.ended)),
          new Promise((resolve) => {
            timer = setTimeout(resolve, stopTimeoutMs);
          }),
        ]).finally(() => clearTimeout(timer));
        const unstopped = leftRunning.filter((run) => run.running);
        if (unstopped.length > 0) {
          const ids = [...new Set(unstopped.map(({ worker }) => worker.id))].join(", ");
          throw new Error(
            `A worker run started by this test did not end within ${stopTimeoutMs} ms of stop(): ${ids}`,
          );
        }
      } finally {
        prototype.run = original;
      }
    },
  };
}
