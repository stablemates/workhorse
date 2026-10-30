import { createContext } from "react";
import type { DashboardClient } from "@stablemates/workhorse-dashboard-server";

type DashboardProcedure = keyof DashboardClient;

/**
 * Each client procedure, and if it reads state or changes durable state.
 *
 * The type requires each procedure of `DashboardClient` once, so a new procedure does not compile
 * until it is in this table. `mutation-observer.test.ts` compares the mutation entries with the
 * router procedures that carry the mutation flag, so a new mutation cannot skip the cache
 * invalidation.
 */
export const dashboardProcedureKinds = {
  meta: "read",
  taskCounts: "read",
  tasks: "read",
  tasksCursor: "read",
  taskFacets: "read",
  activity: "read",
  events: "read",
  eventDetail: "read",
  cron: "read",
  queues: "read",
  system: "read",
  workers: "read",
  settings: "read",
  previewRetentionPolicy: "read",
  taskDetail: "read",
  checkpointValue: "read",
  taskValue: "read",
  humanWaits: "read",
  taskGroups: "read",
  taskGroupDetail: "read",
  enqueueTest: "mutation",
  setSchedulePaused: "mutation",
  setQueuePaused: "mutation",
  purgeQueue: "mutation",
  setQueueTier: "mutation",
  setQueueHistory: "mutation",
  setWorkerPaused: "mutation",
  overrideMaintenancePolicy: "mutation",
  revertMaintenancePolicy: "mutation",
  overrideRetentionPolicy: "mutation",
  revertRetentionPolicy: "mutation",
  runTaskNow: "mutation",
  cancelTask: "mutation",
  signalTask: "mutation",
  completeHumanWait: "mutation",
  redriveTask: "mutation",
  redriveDeadLetters: "mutation",
  cancelTaskGroup: "mutation",
} as const satisfies { readonly [Name in DashboardProcedure]-?: "read" | "mutation" };

const dashboardProcedures = Object.keys(dashboardProcedureKinds).filter(
  (name): name is DashboardProcedure => Object.hasOwn(dashboardProcedureKinds, name),
);

/**
 * A new plain object with the client procedures, where `settled` runs after each mutation call ends.
 *
 * The wrapper calls each procedure on the host object, so a class method that reads a private
 * field or a frozen host object works. The wrapper does not change the host object. `settled` runs
 * when the call fails too, because a request can fail after the database committed the change.
 * Reads pass through unchanged, and a procedure that the host omits stays absent.
 */
export function observeMutations<
  Client extends { readonly [Name in DashboardProcedure]?: unknown },
>(client: Client, settled: () => void): Client {
  const observed: Partial<Record<DashboardProcedure, unknown>> = {};
  for (const name of dashboardProcedures) {
    const procedure: unknown = client[name];
    if (typeof procedure !== "function") continue;
    observed[name] =
      dashboardProcedureKinds[name] === "mutation"
        ? async (...args: unknown[]): Promise<unknown> => {
            try {
              return await Reflect.apply(procedure, client, args);
            } finally {
              settled();
            }
          }
        : (...args: unknown[]): unknown => Reflect.apply(procedure, client, args);
  }
  // Each procedure of `Client` that the host has is now a wrapper with the same signature, and
  // the dashboard reads no other property of the client.
  return observed as Client;
}

/** Tells the shell when a mutation ended, so it can drop page answers from before it. */
export interface DashboardMutationFeed {
  /** Runs `listener` after each mutation ends. The answer removes the listener. */
  subscribe(listener: () => void): () => void;
}

/** A feed and the call that tells its listeners that a mutation ended. */
export function createMutationFeed(): DashboardMutationFeed & { settled(): void } {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    settled() {
      for (const listener of listeners) listener();
    },
  };
}

/** The mutation feed of the dashboard client in `DashboardClientContext`. */
export const DashboardMutationFeedContext = createContext<DashboardMutationFeed | null>(null);
