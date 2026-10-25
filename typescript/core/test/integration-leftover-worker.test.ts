import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { Worker } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

// This file runs itself in a child Vitest process with the fixture switch set. The first test of the
// fixture fails while its worker still runs. A test does this when a wait fails before
// `worker.stop()`. A cleanup hook of the file also fails after that test. Before SM-1436, the
// worker ran into the later tests, and their reset could fail with `deadlock detected`. The parent
// checks that Vitest reports only the two failures of the first test.
const fixture = process.env.WORKHORSE_LEFTOVER_WORKER_FIXTURE === "1";
const firstFailure = "first failure: the test ends before it stops its worker";
const cleanupFailure = "cleanup failure: an afterEach hook of the file fails";
const laterTests = 40;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe.runIf(fixture)("leftover worker fixture", () => {
  const { admin, deferred, queue } = createIntegrationTestContext(import.meta.url);

  // Vitest skips the other afterEach hooks after a failed one, so the worker must stop without them.
  afterEach(({ task }) => {
    if (task.name === "fails while its worker still runs") throw new Error(cleanupFailure);
  });

  // On a loaded host, the first handler call can take many seconds. This test has no shorter wait,
  // so it fails only with its own error.
  it("fails while its worker still runs", { timeout: 120_000 }, async () => {
    await queue.enqueueMany(
      Array.from({ length: 200 }, () => ({ type: "leftover", payload: null })),
    );
    const handled = deferred();
    const worker = new Worker(queue, {
      workerId: "leftover-worker",
      concurrency: 8,
      pollMs: 1,
      registryIntervalMs: 100,
    }).handle("leftover", async () => {
      handled.resolve();
      await sleep(2);
      return null;
    });
    void worker.run();
    await handled.promise;
    expect(worker.runtimeState().activeSlots).toBeGreaterThan(0);
    throw new Error(firstFailure);
  });

  for (let index = 0; index < laterTests; index += 1) {
    it(`resets and enqueues after the failed test (${index})`, async () => {
      await queue.enqueueMany(
        Array.from({ length: 30 }, () => ({ type: "leftover", payload: null })),
      );
      await sleep(50);
      await expect(admin.listWorkers()).resolves.toEqual([]);
    });
  }
});

describe.skipIf(fixture)("leftover worker after a failed test", () => {
  it("reports only the failures of the first test", { timeout: 300_000 }, async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "workhorse-leftover-worker-"));
    const outputFile = path.join(outputDirectory, "report.json");
    try {
      const child = promisify(execFile)(
        process.execPath,
        [
          path.join(repositoryRoot, "node_modules/vitest/vitest.mjs"),
          "run",
          path.relative(repositoryRoot, fileURLToPath(import.meta.url)),
          "--reporter=json",
          `--outputFile=${outputFile}`,
        ],
        {
          cwd: repositoryRoot,
          // The parent's VITEST_* variables describe its own worker pool, not the child's.
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([name]) => !name.startsWith("VITEST")),
            ),
            WORKHORSE_LEFTOVER_WORKER_FIXTURE: "1",
          },
          timeout: 290_000,
        },
      );
      // The fixture fails on purpose, so the child exits with a nonzero status.
      await expect(child).rejects.toMatchObject({ code: 1 });

      const report = JSON.parse(await readFile(outputFile, "utf8")) as {
        testResults: {
          message: string;
          assertionResults: { title: string; status: string; failureMessages: string[] }[];
        }[];
      };
      const results = report.testResults.flatMap((file) => file.assertionResults);
      expect(JSON.stringify(report)).not.toContain("deadlock detected");
      expect(report.testResults.map((file) => file.message)).toEqual([""]);
      expect(results.filter((result) => result.status === "failed")).toEqual([
        expect.objectContaining({
          title: "fails while its worker still runs",
          failureMessages: [
            expect.stringContaining(firstFailure),
            expect.stringContaining(cleanupFailure),
          ],
        }),
      ]);
      expect(results.filter((result) => result.status === "passed")).toHaveLength(laterTests);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});
