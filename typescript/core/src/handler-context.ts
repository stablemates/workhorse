import { isDeepStrictEqual } from "node:util";
import { FastTierUnsupportedError } from "./errors.js";
import { ChildConflictError } from "./queue/child-tasks.js";
import type { ExternalWaitOptions } from "./queue/external-waits.js";
import type { TaskAttempt } from "./task-attempt.js";
import type {
  ChildTaskOptions,
  ChildTaskRequest,
  ClaimedTask,
  Json,
  TaskCheckpoint,
  TaskProgress,
  TaskWait,
} from "./types.js";
import type { HandlerContext, WorkerQueueApi } from "./worker.js";

/**
 * Builds the durable operations one handler activation sees.
 *
 * Each operation caches what it read for the rest of the activation, and joins a concurrent call
 * with the same name instead of repeating it. Every write first asks `attempt` to confirm that the
 * attempt still owns the task.
 *
 * A fast-tier task has no durable execution state (ADR 0077). Its context rejects every operation
 * that would write that state before any round trip, so the attempt fails with a clear error.
 */
export function createHandlerContext(
  queue: WorkerQueueApi,
  workerId: string,
  task: ClaimedTask,
  attempt: TaskAttempt,
  fastTier = false,
): HandlerContext {
  const context = createDurableHandlerContext(queue, workerId, task, attempt);
  if (!fastTier) return context;
  const reject = (feature: string) => (): Promise<never> =>
    Promise.reject(new FastTierUnsupportedError(task.queue, feature));
  return {
    ...context,
    setProgress: reject("progress"),
    checkpoint: reject("checkpoints"),
    sleep: reject("durable waits"),
    sleepUntil: reject("durable waits"),
    waitForSignal: reject("signal waits"),
    waitForHuman: reject("human waits"),
    runChild: reject("child tasks"),
    runChildren: reject("child tasks"),
    runChildrenAll: reject("child tasks"),
  };
}

function createDurableHandlerContext(
  queue: WorkerQueueApi,
  workerId: string,
  task: ClaimedTask,
  attempt: TaskAttempt,
): HandlerContext {
  let checkpoints: Map<string, TaskCheckpoint> | undefined;
  let checkpointsLoad: Promise<Map<string, TaskCheckpoint>> | undefined;
  const loadCheckpoints = (): Promise<Map<string, TaskCheckpoint>> => {
    checkpointsLoad ??= queue.listCheckpoints(task.id).then((items) => {
      checkpoints = new Map(items.map((item) => [item.name, item]));
      return checkpoints;
    });
    return checkpointsLoad;
  };
  let waits: Map<string, TaskWait> | undefined;
  let waitsLoad: Promise<Map<string, TaskWait>> | undefined;
  const loadWaits = (): Promise<Map<string, TaskWait>> => {
    waitsLoad ??= queue.listWaits(task.id).then((items) => {
      waits = new Map(items.map((item) => [item.name, item]));
      return waits;
    });
    return waitsLoad;
  };
  // No database transaction or row lock spans this call. Handlers are at least once and must
  // use external idempotency for effects that cannot safely repeat.
  const getCheckpoint: HandlerContext["getCheckpoint"] = async <TValue extends Json>(
    name: string,
  ) => ((await loadCheckpoints()).get(name) as TaskCheckpoint<TValue> | undefined) ?? null;
  const getWait: HandlerContext["getWait"] = async (name: string) =>
    (await loadWaits()).get(name) ?? null;
  let progressLoad: Promise<TaskProgress | null> | undefined;
  const getProgress: HandlerContext["getProgress"] = async <TValue extends Json>() => {
    progressLoad ??= queue.getProgress(task.id);
    return (await progressLoad) as TaskProgress<TValue> | null;
  };
  const setProgress: HandlerContext["setProgress"] = async <TValue extends Json>(value: TValue) => {
    attempt.requireLease();
    const updated = await queue.updateProgress(task, workerId, value);
    progressLoad = Promise.resolve(updated);
    return updated;
  };
  const inFlightCheckpoints = new Map<string, Promise<Json>>();
  const checkpoint: HandlerContext["checkpoint"] = async <TValue extends Json>(
    name: string,
    operation: () => Promise<TValue> | TValue,
  ): Promise<TValue> => {
    const pending = inFlightCheckpoints.get(name);
    if (pending) return (await pending) as TValue;
    const execution = (async (): Promise<TValue> => {
      const checkpointCache = await loadCheckpoints();
      const existing = checkpointCache.get(name) as TaskCheckpoint<TValue> | undefined;
      if (existing) return existing.value;
      attempt.requireLease();
      const value = await operation();
      const saved = await queue.saveCheckpoint(task, workerId, name, value);
      checkpointCache.set(name, saved);
      return saved.value;
    })();
    inFlightCheckpoints.set(name, execution);
    try {
      return await execution;
    } finally {
      if (inFlightCheckpoints.get(name) === execution) inFlightCheckpoints.delete(name);
    }
  };
  const inFlightWaits = new Map<string, Promise<void>>();
  const scheduleWait = (
    name: string,
    request: { durationMs: number } | { wakeAt: Date },
  ): Promise<void> => {
    const pending = inFlightWaits.get(name);
    if (pending) return pending;
    const execution = (async () => {
      attempt.requireLease();
      const scheduled = await queue.scheduleWait(task, workerId, name, request);
      waits?.set(name, scheduled.wait);
      if (scheduled.status === "scheduled") attempt.suspendForScheduledWait();
    })();
    inFlightWaits.set(name, execution);
    void execution
      .finally(() => {
        if (inFlightWaits.get(name) === execution) inFlightWaits.delete(name);
      })
      .catch(() => undefined);
    return execution;
  };
  const durableSleep: HandlerContext["sleep"] = (name, durationMs) =>
    scheduleWait(name, { durationMs });
  const sleepUntil: HandlerContext["sleepUntil"] = (name, wakeAt) => scheduleWait(name, { wakeAt });
  const inFlightSignals = new Map<string, Promise<Json>>();
  const waitForSignal: HandlerContext["waitForSignal"] = async <TPayload extends Json>(
    name: string,
    options: ExternalWaitOptions = {},
  ): Promise<TPayload> => {
    const pending = inFlightSignals.get(name);
    if (pending) return (await pending) as TPayload;
    const execution = (async (): Promise<TPayload> => {
      attempt.requireLease();
      const signal = await queue.waitForSignal<TPayload>(task, workerId, name, options);
      if (signal.status === "waiting") {
        attempt.suspend("suspended_for_wait");
      }
      return signal.payload as TPayload;
    })();
    inFlightSignals.set(name, execution);
    try {
      return await execution;
    } finally {
      if (inFlightSignals.get(name) === execution) inFlightSignals.delete(name);
    }
  };
  const inFlightHumanWaits = new Map<string, { context: Json; execution: Promise<Json> }>();
  const waitForHuman: HandlerContext["waitForHuman"] = async <
    TContext extends Json,
    TResult extends Json = Json,
  >(
    name: string,
    context: TContext,
    options: ExternalWaitOptions = {},
  ): Promise<TResult> => {
    const pending = inFlightHumanWaits.get(name);
    if (pending) {
      if (JSON.stringify(pending.context) !== JSON.stringify(context)) {
        throw new Error(`Human wait ${name} is already in flight with different context`);
      }
      return (await pending.execution) as TResult;
    }
    const execution = (async (): Promise<TResult> => {
      attempt.requireLease();
      const token = await queue.waitForHuman<TContext, TResult>(
        task,
        workerId,
        name,
        context,
        options,
      );
      if (token.status === "waiting") {
        attempt.suspend("suspended_for_wait");
      }
      return token.payload as TResult;
    })();
    inFlightHumanWaits.set(name, { context, execution });
    try {
      return await execution;
    } finally {
      const currentWait = inFlightHumanWaits.get(name);
      if (currentWait?.execution === execution) inFlightHumanWaits.delete(name);
    }
  };
  const inFlightChildren = new Map<string, { request: unknown; execution: Promise<Json> }>();
  const runChild: HandlerContext["runChild"] = <
    TChildPayload extends Json,
    TResult extends Json = Json,
  >(
    name: string,
    type: string,
    payload: TChildPayload,
    options?: ChildTaskOptions,
  ): Promise<TResult> => {
    const request = structuredClone({ type, payload, options: options ?? {} });
    const pending = inFlightChildren.get(name);
    if (pending) {
      if (!isDeepStrictEqual(pending.request, request)) {
        return Promise.reject(new ChildConflictError(task.id, name));
      }
      return pending.execution as Promise<TResult>;
    }
    const execution = (async (): Promise<TResult> => {
      attempt.requireLease();
      const processed = await queue.createChild<TChildPayload, TResult>(
        task,
        workerId,
        name,
        type,
        payload,
        options,
      );
      if (processed.status === "created") {
        attempt.suspend("suspended_for_child");
      }
      return processed.child.result as TResult;
    })();
    inFlightChildren.set(name, { request, execution: execution as Promise<Json> });
    void execution
      .finally(() => {
        if (inFlightChildren.get(name)?.execution === execution) inFlightChildren.delete(name);
      })
      .catch(() => undefined);
    return execution;
  };
  let inFlightChildSet: { request: unknown; execution: Promise<Record<string, Json>> } | undefined;
  const runChildSet = <TJoined extends Record<string, Json>>(
    children: readonly ChildTaskRequest[],
    mode: "settled" | "all_success",
  ): Promise<TJoined> => {
    const request = { children: structuredClone(children), mode };
    if (inFlightChildSet) {
      if (!isDeepStrictEqual(inFlightChildSet.request, request)) {
        return Promise.reject(new ChildConflictError(task.id, "child set"));
      }
      return inFlightChildSet.execution as Promise<TJoined>;
    }
    const execution = (async (): Promise<TJoined> => {
      attempt.requireLease();
      const processed =
        mode === "settled"
          ? await queue.createChildren(task, workerId, children)
          : await queue.createChildrenAll(task, workerId, children);
      if (processed.status === "created") {
        return attempt.suspend("suspended_for_child");
      }
      return processed.results as TJoined;
    })();
    inFlightChildSet = { request, execution: execution as Promise<Record<string, Json>> };
    void execution
      .finally(() => {
        if (inFlightChildSet?.execution === execution) inFlightChildSet = undefined;
      })
      .catch(() => undefined);
    return execution;
  };
  const runChildren: HandlerContext["runChildren"] = (children) => runChildSet(children, "settled");
  const runChildrenAll: HandlerContext["runChildrenAll"] = (children) =>
    runChildSet(children, "all_success");
  return {
    task,
    signal: attempt.signal,
    getCheckpoint,
    getWait,
    getProgress,
    setProgress,
    checkpoint,
    sleep: durableSleep,
    sleepUntil,
    waitForSignal,
    waitForHuman,
    runChild,
    runChildren,
    runChildrenAll,
  };
}
