import type {
  DashboardTaskFacetName,
  DashboardTaskFacets,
} from "@stablemates/workhorse-dashboard-server/wire";
import { describe, expect, it } from "vitest";
import { createTaskFacetLoader, taskFacetLoadError, type TaskFacetStates } from "./task-facets.js";

function deferred() {
  let resolve!: (value: DashboardTaskFacets) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<DashboardTaskFacets>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function harness() {
  const reads: { facet: DashboardTaskFacetName; answer: ReturnType<typeof deferred> }[] = [];
  let states: TaskFacetStates | null = null;
  const loader = createTaskFacetLoader(
    (facet) => {
      const answer = deferred();
      reads.push({ facet, answer });
      return answer.promise;
    },
    (next) => {
      states = next;
    },
  );
  return { loader, reads, states: () => states! };
}

const lists = (values: Partial<DashboardTaskFacets>): DashboardTaskFacets => ({
  queues: [],
  workers: [],
  taskTypes: [],
  tags: [],
  ...values,
});

describe("task facet loader", () => {
  it("reads only the list of the menu that opens", () => {
    const { loader, reads, states } = harness();

    loader.load("workers");

    expect(reads.map((read) => read.facet)).toEqual(["workers"]);
    expect(states().workers.loading).toBe(true);
    expect(states().queues).toEqual({ values: null, loading: false, error: null });
    expect(states().tags.loading).toBe(false);
  });

  it("loads a fast list while a slow list still waits", async () => {
    const { loader, reads, states } = harness();

    loader.load("workers");
    loader.load("queues");
    reads[1]!.answer.resolve(lists({ queues: ["billing"] }));
    await Promise.resolve();

    expect(states().queues).toEqual({ values: ["billing"], loading: false, error: null });
    expect(states().workers.loading).toBe(true);
  });

  it("keeps the other lists when one list fails, and reads a failed list again", async () => {
    const { loader, reads, states } = harness();

    loader.load("taskTypes");
    loader.load("workers");
    reads[0]!.answer.resolve(lists({ taskTypes: ["invoice"] }));
    reads[1]!.answer.reject(new Error("This read exceeded its time bound"));
    await Promise.resolve();
    await Promise.resolve();

    expect(states().taskTypes.values).toEqual(["invoice"]);
    expect(states().workers).toEqual({ values: null, loading: false, error: taskFacetLoadError });

    loader.load("workers");
    expect(reads.map((read) => read.facet)).toEqual(["taskTypes", "workers", "workers"]);
    expect(states().workers).toEqual({ values: null, loading: true, error: null });
  });

  it("does not read a list again while it loads or after it loaded", async () => {
    const { loader, reads } = harness();

    loader.load("tags");
    loader.load("tags");
    reads[0]!.answer.resolve(lists({ tags: ["weekly"] }));
    await Promise.resolve();
    loader.load("tags");

    expect(reads).toHaveLength(1);
  });

  it("uses only the asked list when an older schema returns all four", async () => {
    const { loader, reads, states } = harness();

    loader.load("queues");
    reads[0]!.answer.resolve(lists({ queues: ["billing"], workers: ["worker-1"] }));
    await Promise.resolve();

    expect(states().queues.values).toEqual(["billing"]);
    expect(states().workers.values).toBeNull();
  });

  it("ignores an answer that arrives after detach and reads again on the next open", async () => {
    const { loader, reads, states } = harness();

    loader.load("queues");
    loader.detach();
    expect(states().queues.loading).toBe(false);
    reads[0]!.answer.resolve(lists({ queues: ["stale"] }));
    await Promise.resolve();
    expect(states().queues.values).toBeNull();

    loader.load("queues");
    expect(reads).toHaveLength(2);
  });
});
