import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEMO_SHARED_QUEUE,
  DEMO_TASK_GROUP_LANGUAGES,
  LANGUAGE_WORKER_TASK_TYPE,
  SHARED_WORKER_TASK_TYPE,
} from "./constants.js";
import {
  demoTaskGroupCallbacks,
  demoTaskGroupDriverResult,
  demoTaskGroupMembers,
} from "./handlers.js";

describe("demo task groups", () => {
  it("puts one member on each language queue and misroutes the Ruby member of a failed group", () => {
    const succeeded = demoTaskGroupMembers("task-group-driver", "succeeded");
    expect(succeeded).toEqual(
      DEMO_TASK_GROUP_LANGUAGES.map(({ language, queue }, index) => ({
        type: LANGUAGE_WORKER_TASK_TYPE,
        payload: { language, source: "task-group-driver", member: index + 1 },
        options: { queue, maxAttempts: 1 },
        tags: ["task-group", language],
      })),
    );

    const failed = demoTaskGroupMembers("task-group-driver", "failed");
    expect(failed.slice(0, 3)).toEqual(succeeded.slice(0, 3));
    expect(failed[3]).toEqual({
      type: LANGUAGE_WORKER_TASK_TYPE,
      payload: { language: "python", source: "task-group-driver", member: 4 },
      options: { queue: "demo-ruby", maxAttempts: 1 },
      tags: ["task-group", "ruby", "misrouted"],
    });
  });

  it("holds only the members whose position names a run time", () => {
    const runAt = new Date("9999-12-31T23:59:59.999Z");
    const members = demoTaskGroupMembers("task-group-seed", "succeeded", new Map([[3, runAt]]));
    expect(members.map((member) => member.options?.runAt)).toEqual([
      undefined,
      undefined,
      undefined,
      runAt,
    ]);
  });

  it("requests every callback on the shared queue", () => {
    const callbacks = demoTaskGroupCallbacks("task-group-seed");
    expect(Object.keys(callbacks)).toEqual(["onFinish", "onSuccess", "onFailure"]);
    for (const callback of Object.values(callbacks)) {
      expect(callback).toMatchObject({
        type: SHARED_WORKER_TASK_TYPE,
        payload: { source: "task-group-seed" },
        options: { queue: DEMO_SHARED_QUEUE, maxAttempts: 1 },
      });
    }
  });

  it("picks a stable result per driver and fails about one group in three", () => {
    const results = Array.from({ length: 3_000 }, () => {
      const driverTaskId = randomUUID();
      const result = demoTaskGroupDriverResult(driverTaskId);
      expect(demoTaskGroupDriverResult(driverTaskId)).toBe(result);
      return result;
    });
    const failed = results.filter((result) => result === "failed").length;
    expect(failed).toBeGreaterThan(800);
    expect(failed).toBeLessThan(1_200);
  });
});
