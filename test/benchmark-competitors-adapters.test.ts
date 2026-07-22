/* oxlint-disable vitest/require-mock-type-parameters unicorn/consistent-function-scoping -- concise structural adapter fakes */
import { describe, expect, it, vi } from "vitest";
import { GraphileWorkerTarget, PgBossTarget } from "../benchmarks/targets/index.js";

const pool = {
  options: { connectionString: "postgres://test" },
  query: vi.fn(async () => ({ rows: [] })),
} as never;
const items = [
  { id: "a", payload: {} },
  { id: "b", payload: {} },
];

describe("pg-boss competitor adapter", () => {
  it("uses insert batching, queue semantics, localConcurrency, and graceful stop", async () => {
    let handler: (jobs: unknown) => Promise<void> = async () => {};
    const boss = {
      start: vi.fn(),
      stop: vi.fn(),
      createQueue: vi.fn(),
      insert: vi.fn(),
      work: vi.fn(async (_name, _options, value) => {
        handler = value;
      }),
    };
    const target = new PgBossTarget(pool, async () => boss);
    await target.setup();
    await target.enqueueMany(items);
    await target.startConsumers(4);
    await handler(items.map((data) => ({ data })));
    await target.observeExactCompletions(2, 10);
    await target.stop();
    expect(boss.createQueue).toHaveBeenCalledWith("competitor_baseline", {
      retryLimit: 0,
      deleteAfterSeconds: 0,
      notify: true,
    });
    expect(boss.insert).toHaveBeenCalledTimes(1);
    expect(boss.work).toHaveBeenCalledWith(
      "competitor_baseline",
      expect.objectContaining({ localConcurrency: 4, batchSize: 1 }),
      expect.any(Function),
    );
    expect(boss.stop).toHaveBeenCalledWith({ graceful: true });
    await expect(handler([{ data: items[0] }])).rejects.toThrow(/more than once/);
  });
});

describe("Graphile Worker competitor adapter", () => {
  it("migrates/addJobs and runs one-attempt tasks at configured concurrency", async () => {
    let task: (payload: (typeof items)[number]) => Promise<void> = async () => {};
    const utils = { migrate: vi.fn(), addJobs: vi.fn(), release: vi.fn() };
    const runner = { stop: vi.fn() };
    const factory = {
      makeWorkerUtils: vi.fn(async () => utils),
      run: vi.fn(async (options: any) => {
        task = options.taskList.competitor_baseline;
        return runner;
      }),
    };
    const target = new GraphileWorkerTarget(pool, factory);
    await target.setup();
    await target.enqueueMany(items);
    await target.startConsumers(3);
    await task(items[0]!);
    await task(items[1]!);
    await target.observeExactCompletions(2, 10);
    await target.close();
    expect(utils.addJobs).toHaveBeenCalledWith(
      items.map((item) => ({ identifier: "competitor_baseline", payload: item, maxAttempts: 1 })),
    );
    expect(factory.run).toHaveBeenCalledWith(
      expect.objectContaining({ concurrency: 3, noHandleSignals: true }),
    );
    expect(runner.stop).toHaveBeenCalledOnce();
  });
});
