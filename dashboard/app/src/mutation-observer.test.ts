import {
  dashboardRouter,
  isDashboardMutation,
} from "@stablemates/workhorse-dashboard-server/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createMutationFeed,
  dashboardProcedureKinds,
  observeMutations,
} from "./mutation-observer.js";

const rootSource = readFileSync(new URL("./dashboard-root.tsx", import.meta.url), "utf8");
const controllerSource = readFileSync(new URL("./shell/controller.tsx", import.meta.url), "utf8");

function fakeClient() {
  const calls: string[] = [];
  return {
    calls,
    client: {
      queues: async () => {
        calls.push("queues");
        return { queues: [] };
      },
      setQueuePaused: async ({ paused }: { paused: boolean }) => {
        calls.push(`setQueuePaused ${paused}`);
        return { paused };
      },
      cancelTask: async (): Promise<never> => {
        calls.push("cancelTask");
        throw new Error("Workhorse could not cancel the task");
      },
    },
  };
}

describe("mutation observer", () => {
  it("names every router procedure that carries the mutation flag", () => {
    const mutations = Object.keys(dashboardRouter.dashboard).filter((name) =>
      isDashboardMutation(`dashboard.${name}`),
    );
    const named = Object.entries(dashboardProcedureKinds)
      .filter(([, kind]) => kind === "mutation")
      .map(([name]) => name);
    expect(named.toSorted()).toEqual(mutations.toSorted());
  });

  it("names every router procedure once", () => {
    expect(Object.keys(dashboardProcedureKinds).toSorted()).toEqual(
      Object.keys(dashboardRouter.dashboard).toSorted(),
    );
  });

  it("reports a mutation after it ends, and a read never", async () => {
    const { client, calls } = fakeClient();
    let settled = 0;
    const observed = observeMutations(client, () => {
      calls.push("settled");
      settled += 1;
    });

    expect(await observed.queues()).toEqual({ queues: [] });
    expect(settled).toBe(0);

    expect(await observed.setQueuePaused({ paused: true })).toEqual({ paused: true });
    expect(calls).toEqual(["queues", "setQueuePaused true", "settled"]);
  });

  it("reports a failed mutation too, because the change can be committed", async () => {
    const { client } = fakeClient();
    let settled = 0;
    const observed = observeMutations(client, () => (settled += 1));
    await expect(observed.cancelTask()).rejects.toThrow("could not cancel");
    expect(settled).toBe(1);
  });

  it("calls a class client with private fields on the host object", async () => {
    class HostClient {
      readonly #calls: string[] = [];
      get calls(): readonly string[] {
        return this.#calls;
      }
      async queues() {
        this.#calls.push("queues");
        return { queues: [] };
      }
      async setQueuePaused({ paused }: { paused: boolean }) {
        this.#calls.push(`setQueuePaused ${paused}`);
        return { paused };
      }
    }
    const host = new HostClient();
    let settled = 0;
    const observed = observeMutations(host, () => (settled += 1));
    expect(observed).not.toBe(host);
    expect(await observed.queues()).toEqual({ queues: [] });
    expect(await observed.setQueuePaused({ paused: true })).toEqual({ paused: true });
    expect(host.calls).toEqual(["queues", "setQueuePaused true"]);
    expect(settled).toBe(1);
  });

  it("calls a frozen client and leaves it unchanged", async () => {
    const { client, calls } = fakeClient();
    const host = Object.freeze(client);
    let settled = 0;
    const observed = observeMutations(host, () => (settled += 1));
    expect(await observed.queues()).toEqual({ queues: [] });
    expect(await observed.setQueuePaused({ paused: false })).toEqual({ paused: false });
    expect(calls).toEqual(["queues", "setQueuePaused false"]);
    expect(settled).toBe(1);
    expect(host.setQueuePaused).toBe(client.setQueuePaused);
  });

  it("keeps a procedure that the host omits absent", () => {
    const host: { queues: () => Promise<object>; setQueueTier?: () => void } = {
      queues: async () => ({}),
    };
    const observed = observeMutations(host, () => undefined);
    expect(observed.setQueueTier).toBeUndefined();
  });
});

describe("mutation feed", () => {
  it("tells each listener after a mutation ends, until the listener leaves", async () => {
    const feed = createMutationFeed();
    const heard: string[] = [];
    const leave = feed.subscribe(() => heard.push("shell"));
    const observed = observeMutations(fakeClient().client, feed.settled);
    await observed.setQueuePaused({ paused: false });
    leave();
    await observed.setQueuePaused({ paused: true });
    expect(heard).toEqual(["shell"]);
  });

  it("wraps the client of every page and drawer, and the shell drops its cache on each event", () => {
    // The root hands the observed client to the context that every page reads.
    expect(rootSource).toContain("<DashboardClientContext.Provider value={observedClient}>");
    expect(rootSource).toContain("demoTools={observedDemoTools}");
    expect(controllerSource).toMatch(
      /mutations\?\.subscribe\(\(\) => \{\s*pageCache\.invalidate\(\);\s*refreshRequests\.forget\(\);/,
    );
  });
});
