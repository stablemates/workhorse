import { isDeepStrictEqual } from "node:util";
import { canonicalText, checkpointInputFingerprint } from "./checkpoint-fingerprint.js";
import { WorkhorseError } from "./errors.js";
import type {
  CheckpointOptions,
  ChildOutcome,
  ChildOutcomes,
  ChildTaskOptions,
  ChildTaskRequest,
  ClaimedTask,
  Json,
  TaskCheckpoint,
  TaskProgress,
  TaskWait,
} from "./types.js";
import type { Handler, HandlerContext } from "./worker.js";

/** The kind of a named durable boundary. Each kind has its own names. */
export type DurableKind = "checkpoint" | "wait" | "signal" | "humanWait" | "child";

/** One named durable boundary of a task. */
export interface DurableName {
  kind: DurableKind;
  name: string;
}

/**
 * A stored checkpoint. `inputFingerprint` is the stored fingerprint of the input, as
 * `TaskCheckpoint.inputFingerprint` reads it. Omit it for a checkpoint saved without an input.
 */
export interface DurableStateCheckpoint {
  value: Json;
  inputFingerprint?: string;
}

/**
 * A stored timer wait. `wakeAt` is the durable target as an ISO 8601 string. `pending` marks the
 * wait on which the task is suspended now.
 */
export type DurableStateWait =
  | { mode: "relative"; durationMs: number; wakeAt: string; pending?: boolean }
  | { mode: "absolute"; wakeAt: string; pending?: boolean };

/** A stored signal wait: the delivered payload, or a wait that has no delivery yet. */
export type DurableStateSignal = { payload: Json } | { pending: true };

/** A stored human decision: its context and the result, or a decision that has no result yet. */
export type DurableStateHumanWait =
  | { context: Json; result: Json }
  | { context: Json; pending: true };

/**
 * A stored child. `payload` and `options` are the request in JSON form. `set` is the join mode of
 * a child that `runChildren` (`settled`) or `runChildrenAll` (`all_success`) created. It is absent
 * for a child of `runChild`. A child without an `outcome` is not terminal, so the task is
 * suspended on it.
 */
export interface DurableStateChild {
  type: string;
  payload: Json;
  options?: Json;
  set?: "settled" | "all_success";
  outcome?: ChildOutcome;
}

/**
 * The stored durable state of one task, as a plain JSON value. Each record is keyed by name. A
 * test writes it by hand or loads it from a fixture file.
 */
export interface DurableState {
  checkpoints?: Record<string, DurableStateCheckpoint>;
  waits?: Record<string, DurableStateWait>;
  signals?: Record<string, DurableStateSignal>;
  humanWaits?: Record<string, DurableStateHumanWait>;
  children?: Record<string, DurableStateChild>;
}

export interface ReplayHandlerOptions {
  /**
   * Names that the new code adds on purpose before a stored name, for example a version
   * checkpoint. The replay reports them as new and does not fail on them.
   */
  allowNew?: readonly string[];
  /** Fields of the claimed task that the handler sees. The replay supplies the others. */
  task?: Partial<Omit<ClaimedTask, "payload">>;
}

/** The names that a replay saw, in the order the handler first asked for each one. */
export interface HandlerReplayNames {
  /** Stored names that the handler asked for. */
  replayed: DurableName[];
  /** Names that the state does not hold. */
  new: DurableName[];
  /** Stored names that the handler did not ask for. */
  unused: DurableName[];
}

/** The result of a replay that found no problem. */
export interface HandlerReplayReport<TResult extends Json = Json> extends HandlerReplayNames {
  /**
   * `completed` when the handler returned. `suspended` when it reached a stored pending boundary
   * or a new wait or child, where a live task suspends.
   */
  outcome: { status: "completed"; result: TResult } | { status: "suspended"; at: DurableName };
}

/**
 * Why a replay failed. `new_before_stored`: the handler asked for a new name while the state held
 * a name that it had not asked for. `conflict`: the request differs from the stored request.
 */
export interface HandlerReplayProblem {
  reason: "new_before_stored" | "conflict";
  at: DurableName;
}

/** Raised when new handler code does not match the stored durable state of a task. */
export class HandlerReplayError extends WorkhorseError {
  constructor(
    readonly problem: HandlerReplayProblem,
    readonly names: HandlerReplayNames,
    detail: string,
  ) {
    super(
      `Handler replay failed at ${problem.at.kind} ${JSON.stringify(problem.at.name)}: ${detail}`,
    );
    this.name = "HandlerReplayError";
  }
}

class ReplaySuspension {
  constructor(readonly at: DurableName) {}
}

const KINDS: readonly DurableKind[] = ["checkpoint", "wait", "signal", "humanWait", "child"];
const STATE_FIELDS = {
  checkpoint: "checkpoints",
  wait: "waits",
  signal: "signals",
  humanWait: "humanWaits",
  child: "children",
} as const satisfies Record<DurableKind, keyof DurableState>;

/**
 * Run a handler against the stored durable state of one task, without a database or a worker.
 *
 * The replay returns each stored value as a live worker does. It runs the operation of a new
 * checkpoint, and it stops where a live task suspends. It fails with {@link HandlerReplayError}
 * when the handler asks for a new name before every stored name, or when a request conflicts
 * with the stored request. An error that the handler throws reaches the caller unchanged.
 */
export async function replayHandler<TPayload extends Json, TResult extends Json>(
  handler: Handler<TPayload, TResult>,
  payload: TPayload,
  state: DurableState,
  options: ReplayHandlerOptions = {},
): Promise<HandlerReplayReport<TResult>> {
  const replay = new Replay(state, options.allowNew ?? []);
  const task: ClaimedTask<TPayload> = {
    id: "replay",
    queue: "default",
    type: "replay",
    priority: 0,
    contractVersion: null,
    resultMaxBytes: 1_048_576,
    redactErrorDetails: false,
    traceContext: null,
    attempt: 1,
    maxAttempts: 1,
    retryPolicy: null,
    deadlineAt: null,
    executionTimeoutMs: null,
    attemptTimeoutAt: null,
    fenceToken: 1n,
    leaseExpiresAt: new Date(8_640_000_000_000_000),
    ...options.task,
    payload,
  };
  let result: TResult | undefined;
  let thrown: unknown;
  let failed = false;
  try {
    result = await handler(payload, replay.context(task));
  } catch (error) {
    failed = true;
    thrown = error;
  }
  replay.throwProblem();
  if (replay.suspendedAt !== undefined) {
    return { ...replay.names(), outcome: { status: "suspended", at: replay.suspendedAt } };
  }
  if (failed) throw thrown;
  return { ...replay.names(), outcome: { status: "completed", result: result as TResult } };
}

class Replay {
  private readonly seen = new Map<DurableKind, Set<string>>(KINDS.map((kind) => [kind, new Set()]));
  private readonly replayed: DurableName[] = [];
  private readonly added: DurableName[] = [];
  private readonly newCheckpoints = new Map<string, { value: Json; fingerprint: string | null }>();
  // The first request for each name in this replay. A live handler compares an overlapping call
  // with the call in flight, in the same form as these values.
  private readonly childRequests = new Map<string, unknown>();
  private childSetRequest: unknown;
  private readonly humanContexts = new Map<string, string>();
  private progress: TaskProgress | null = null;
  private problem: { problem: HandlerReplayProblem; detail: string } | undefined;
  suspendedAt: DurableName | undefined;

  constructor(
    private readonly state: DurableState,
    private readonly allowNew: readonly string[],
  ) {}

  private stored<TKind extends DurableKind>(
    kind: TKind,
    name: string,
  ): NonNullable<DurableState[(typeof STATE_FIELDS)[TKind]]>[string] | undefined {
    const record = this.state[STATE_FIELDS[kind]] as Record<string, unknown> | undefined;
    if (record === undefined || !Object.hasOwn(record, name)) return undefined;
    return record[name] as NonNullable<DurableState[(typeof STATE_FIELDS)[TKind]]>[string];
  }

  private storedNames(): DurableName[] {
    return KINDS.flatMap((kind) =>
      Object.keys(this.state[STATE_FIELDS[kind]] ?? {}).map((name) => ({ kind, name })),
    );
  }

  names(): HandlerReplayNames {
    return {
      replayed: [...this.replayed],
      new: [...this.added],
      unused: this.storedNames().filter(({ kind, name }) => !this.seen.get(kind)?.has(name)),
    };
  }

  throwProblem(): void {
    if (this.problem) throw this.problemError(this.problem);
  }

  private problemError(problem: {
    problem: HandlerReplayProblem;
    detail: string;
  }): HandlerReplayError {
    return new HandlerReplayError(problem.problem, this.names(), problem.detail);
  }

  private fail(reason: HandlerReplayProblem["reason"], at: DurableName, detail: string): never {
    this.problem ??= { problem: { reason, at }, detail };
    throw this.problemError(this.problem);
  }

  private suspend(at: DurableName): never {
    this.suspendedAt ??= at;
    throw new ReplaySuspension(at);
  }

  private stop(): void {
    this.throwProblem();
    if (this.suspendedAt !== undefined) throw new ReplaySuspension(this.suspendedAt);
  }

  /** Record that the handler asked for a name, and return whether the state holds it. */
  private ask(kind: DurableKind, name: string): boolean {
    this.stop();
    const at = { kind, name };
    const isStored = this.stored(kind, name) !== undefined;
    const seen = this.seen.get(kind) as Set<string>;
    if (seen.has(name)) return isStored;
    seen.add(name);
    if (isStored) {
      this.replayed.push(at);
      return true;
    }
    this.added.push(at);
    if (!this.allowNew.includes(name)) {
      const waiting = this.names().unused[0];
      if (waiting !== undefined) {
        this.fail(
          "new_before_stored",
          at,
          `the state does not hold this name, and it still holds ${waiting.kind} ${JSON.stringify(waiting.name)}, which the handler has not asked for`,
        );
      }
    }
    return false;
  }

  /** Read a stored name without recording a new one, as a read writes nothing. */
  private read(kind: DurableKind, name: string): void {
    this.stop();
    if (this.stored(kind, name) === undefined) return;
    const seen = this.seen.get(kind) as Set<string>;
    if (seen.has(name)) return;
    seen.add(name);
    this.replayed.push({ kind, name });
  }

  context<TPayload extends Json>(task: ClaimedTask<TPayload>): HandlerContext<TPayload> {
    const checkpointRow = <TValue extends Json>(
      name: string,
      value: Json,
      inputFingerprint: string | null,
    ): TaskCheckpoint<TValue> => ({
      taskId: task.id,
      name,
      value: value as TValue,
      attempt: task.attempt,
      fenceToken: task.fenceToken,
      workerId: "replay",
      createdAt: new Date(0),
      inputFingerprint,
    });
    const inFlightCheckpoints = new Map<
      string,
      { execution: Promise<Json>; fingerprint: string | null }
    >();
    // As in a live handler, inputs are compared only when both sides carry a fingerprint.
    const checkInput = (
      name: string,
      stored: string | null | undefined,
      requested: string | null,
      source: string,
    ): void => {
      if (stored == null || requested === null || stored === requested) return;
      this.fail(
        "conflict",
        { kind: "checkpoint", name },
        `the checkpoint input differs from the input of ${source}`,
      );
    };
    return {
      task,
      signal: new AbortController().signal,
      getCheckpoint: async <TValue extends Json>(name: string) => {
        this.read("checkpoint", name);
        const stored = this.stored("checkpoint", name);
        if (stored !== undefined) {
          return checkpointRow<TValue>(name, stored.value, stored.inputFingerprint ?? null);
        }
        const added = this.newCheckpoints.get(name);
        if (added !== undefined) return checkpointRow<TValue>(name, added.value, added.fingerprint);
        return null;
      },
      getWait: async (name: string): Promise<TaskWait | null> => {
        this.read("wait", name);
        const stored = this.stored("wait", name);
        if (stored === undefined) return null;
        return {
          taskId: task.id,
          name,
          mode: stored.mode,
          durationMs: stored.mode === "relative" ? stored.durationMs : null,
          requestedWakeAt: stored.mode === "absolute" ? new Date(stored.wakeAt) : null,
          wakeAt: new Date(stored.wakeAt),
          attempt: task.attempt,
          fenceToken: task.fenceToken,
          workerId: "replay",
          createdAt: new Date(0),
        };
      },
      getProgress: async <TValue extends Json>() => this.progress as TaskProgress<TValue> | null,
      setProgress: async <TValue extends Json>(value: TValue) => {
        this.stop();
        const revision = (this.progress?.revision ?? 0n) + 1n;
        const now = new Date();
        this.progress = {
          taskId: task.id,
          value,
          revision,
          attempt: task.attempt,
          fenceToken: task.fenceToken,
          workerId: "replay",
          createdAt: this.progress?.createdAt ?? now,
          updatedAt: now,
        };
        return this.progress as TaskProgress<TValue>;
      },
      checkpoint: async <TValue extends Json>(
        name: string,
        operation: () => Promise<TValue> | TValue,
        options: CheckpointOptions = {},
      ): Promise<TValue> => {
        const fingerprint =
          options.input === undefined ? null : checkpointInputFingerprint(options.input);
        const pending = inFlightCheckpoints.get(name);
        if (pending) {
          this.throwProblem();
          checkInput(name, pending.fingerprint, fingerprint, "an earlier call in this replay");
          return (await pending.execution) as TValue;
        }
        const execution = (async (): Promise<TValue> => {
          if (this.ask("checkpoint", name)) {
            const stored = this.stored("checkpoint", name) as DurableStateCheckpoint;
            checkInput(name, stored.inputFingerprint, fingerprint, "the stored result");
            return stored.value as TValue;
          }
          const added = this.newCheckpoints.get(name);
          if (added !== undefined) {
            checkInput(name, added.fingerprint, fingerprint, "an earlier call in this replay");
            return added.value as TValue;
          }
          const value = await operation();
          this.stop();
          this.newCheckpoints.set(name, { value, fingerprint });
          return value;
        })();
        inFlightCheckpoints.set(name, { execution, fingerprint });
        try {
          return await execution;
        } finally {
          if (inFlightCheckpoints.get(name)?.execution === execution) {
            inFlightCheckpoints.delete(name);
          }
        }
      },
      sleep: async (name: string) => this.timer(name, "relative", null),
      sleepUntil: async (name: string, wakeAt: Date) => this.timer(name, "absolute", wakeAt),
      waitForSignal: async <TSignal extends Json>(name: string): Promise<TSignal> => {
        const at: DurableName = { kind: "signal", name };
        if (!this.ask("signal", name)) return this.suspend(at);
        const stored = this.stored("signal", name) as DurableStateSignal;
        if ("pending" in stored) return this.suspend(at);
        return stored.payload as TSignal;
      },
      waitForHuman: async <TContext extends Json, TResult extends Json = Json>(
        name: string,
        context: TContext,
      ): Promise<TResult> => {
        const at: DurableName = { kind: "humanWait", name };
        // An overlapping call can arrive after the first call suspends, so compare it first.
        this.throwProblem();
        const first = this.humanContexts.get(name);
        if (first === undefined) {
          this.humanContexts.set(name, JSON.stringify(context));
        } else if (first !== JSON.stringify(context)) {
          this.fail("conflict", at, "the human decision context differs from an earlier call");
        }
        if (!this.ask("humanWait", name)) return this.suspend(at);
        const stored = this.stored("humanWait", name) as DurableStateHumanWait;
        if (!sameJson(stored.context, context)) {
          this.fail("conflict", at, "the human decision context differs from the stored context");
        }
        if ("pending" in stored) return this.suspend(at);
        return stored.result as TResult;
      },
      runChild: async <TChildPayload extends Json, TResult extends Json = Json>(
        name: string,
        type: string,
        payload: TChildPayload,
        options?: ChildTaskOptions,
      ): Promise<TResult> => {
        const outcome = this.child({ name, type, payload, options });
        const at: DurableName = { kind: "child", name };
        if (outcome === undefined) return this.suspend(at);
        if (outcome.status !== "succeeded") {
          throw new TypeError(
            `The stored child ${JSON.stringify(name)} is ${outcome.status}, so its parent task does not resume`,
          );
        }
        return outcome.result as TResult;
      },
      runChildren: async <TJoined extends Record<string, Json>>(
        children: readonly ChildTaskRequest[],
      ) => this.childSet(children, "settled") as ChildOutcomes<TJoined>,
      runChildrenAll: async <TJoined extends Record<string, Json>>(
        children: readonly ChildTaskRequest[],
      ) => this.childSet(children, "all_success") as TJoined,
      taskGroup: {
        get: async () => null,
        add: () => Promise.reject(new TypeError("A handler replay does not support task groups")),
      },
    };
  }

  private timer(name: string, mode: "relative" | "absolute", wakeAt: Date | null): void {
    const at: DurableName = { kind: "wait", name };
    if (!this.ask("wait", name)) this.suspend(at);
    const stored = this.stored("wait", name) as DurableStateWait;
    if (stored.mode !== mode) {
      this.fail(
        "conflict",
        at,
        `the stored wait is ${stored.mode}, and the handler asks for ${mode}`,
      );
    }
    if (wakeAt !== null && new Date(stored.wakeAt).getTime() !== wakeAt.getTime()) {
      this.fail(
        "conflict",
        at,
        `the stored target is ${stored.wakeAt}, and the handler asks for ${wakeAt.toISOString()}`,
      );
    }
    if (stored.pending === true) this.suspend(at);
  }

  /** Compare a child request and its join call with the stored child. */
  private checkChildRequest(request: ChildTaskRequest, set: ChildJoinMode | undefined): void {
    const at: DurableName = { kind: "child", name: request.name };
    const requested = childRequestJson(request);
    const stored = this.stored("child", request.name);
    if (stored === undefined) return;
    if (requested !== childRequestJson(stored)) {
      this.fail("conflict", at, "the child request differs from the stored request");
    }
    if (stored.set !== set) {
      this.fail(
        "conflict",
        at,
        `the stored child was created by ${joinCall(stored.set)}, and the handler calls ${joinCall(set)}`,
      );
    }
  }

  /** Replay one child of `runChild`. Returns its stored outcome, or undefined when it suspends. */
  private child(request: ChildTaskRequest): ChildOutcome | undefined {
    // An overlapping call can arrive after the first call suspends, so compare it first. A live
    // handler joins overlapping calls with one name only for an equal request.
    this.throwProblem();
    const call = structuredClone({
      type: request.type,
      payload: request.payload,
      options: request.options ?? {},
    });
    const first = this.childRequests.get(request.name);
    if (first === undefined) {
      this.childRequests.set(request.name, call);
    } else if (!isDeepStrictEqual(first, call)) {
      this.fail(
        "conflict",
        { kind: "child", name: request.name },
        "the child request differs from an earlier request in this replay",
      );
    }
    this.checkChildRequest(request, undefined);
    const other =
      Object.keys(this.state.children ?? {}).find((name) => name !== request.name) ??
      [...this.childRequests.keys()].find((name) => name !== request.name);
    if (other !== undefined) {
      this.fail(
        "conflict",
        { kind: "child", name: request.name },
        `a task creates one child through runChild, and it already has child ${JSON.stringify(other)}`,
      );
    }
    if (!this.ask("child", request.name)) return undefined;
    return (this.stored("child", request.name) as DurableStateChild).outcome;
  }

  /**
   * Replay a child set. As in PostgreSQL, a stored set replays only when the request names the
   * same children with the same requests and the same join mode. A task holds one child set.
   */
  private childSet(
    children: readonly ChildTaskRequest[],
    mode: ChildJoinMode,
  ): Record<string, Json> {
    this.throwProblem();
    const names = children.map(({ name }) => name);
    if (new Set(names).size !== names.length) throw new TypeError("Child names must be unique");
    const requested = { children: structuredClone(children), mode };
    if (this.childSetRequest === undefined) {
      this.childSetRequest = requested;
    } else if (!isDeepStrictEqual(this.childSetRequest, requested)) {
      const at: DurableName = { kind: "child", name: names[0] ?? "child set" };
      this.fail("conflict", at, "the child set differs from an earlier child set in this replay");
    }
    const storedNames = Object.keys(this.state.children ?? {});
    if (storedNames.length > 0) {
      const missing =
        names.find((name) => this.stored("child", name) === undefined) ??
        storedNames.find((name) => !names.includes(name));
      if (missing !== undefined) {
        this.fail(
          "conflict",
          { kind: "child", name: missing },
          "the child set names differ from the stored children",
        );
      }
    }
    for (const request of children) this.checkChildRequest(request, mode);
    const outcomes = children.map((request) =>
      this.ask("child", request.name)
        ? ([
            request.name,
            (this.stored("child", request.name) as DurableStateChild).outcome,
          ] as const)
        : ([request.name, undefined] as const),
    );
    const waiting = outcomes.find(([, outcome]) => outcome === undefined);
    if (waiting !== undefined) this.suspend({ kind: "child", name: waiting[0] });
    const settled = outcomes as ReadonlyArray<readonly [string, ChildOutcome]>;
    if (mode === "settled") {
      return Object.fromEntries(settled.map(([name, outcome]) => [name, outcome as Json]));
    }
    const failed = settled.find(([, outcome]) => outcome.status !== "succeeded");
    if (failed !== undefined) {
      throw new TypeError(
        `The stored child ${JSON.stringify(failed[0])} is ${failed[1].status}, so its parent task does not resume`,
      );
    }
    return Object.fromEntries(
      settled.map(([name, outcome]) => [name, (outcome as { result: Json }).result]),
    );
  }
}

type ChildJoinMode = "settled" | "all_success";

function joinCall(set: ChildJoinMode | undefined): string {
  if (set === undefined) return "runChild";
  return set === "settled" ? "runChildren" : "runChildrenAll";
}

function childRequestJson(request: { type: string; payload: unknown; options?: unknown }): string {
  return toJson({ type: request.type, payload: request.payload, options: request.options ?? {} });
}

// This writes the JSON.stringify text of a value with the keys of each object in sorted order, so
// two values are equal as JSON exactly when their texts are equal. It reads the text with
// canonicalText and does not copy the value through JSON.parse, because JSON.parse before Node
// 24.22.1 and 26.12.1 can read an escaped key as a key that an earlier parse made
// (nodejs/node#63785).
function toJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError("A replayed value must be JSON serializable");
  return canonicalText(text, (decoded) => decoded, replayedNumber);
}

// A JSON.rawJSON token can hold -0 or a number beyond the double range. JSON.parse reads them as
// -0 and as an infinity, which differ from 0 and from null, so their texts differ too.
function replayedNumber(value: number): string {
  if (Object.is(value, -0)) return "-0";
  return Number.isFinite(value) ? JSON.stringify(value) : String(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return toJson(left) === toJson(right);
}
