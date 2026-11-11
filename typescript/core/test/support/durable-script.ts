import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import type {
  DurableScriptOperation,
  DurableScriptRuntimeFixture,
  DurableScriptStep,
  JsonValue,
} from "../../../../scripts/verify-sql-protocol.js";
import { Queue, Worker, type HandlerContext, type Json } from "../../src/index.js";

/**
 * The phases of a `durable-script` fixture. `all` runs every step in this process. `suspend` runs
 * the steps before `handOff`, and `replay` runs the steps after it, so two SDKs can share one task.
 */
export type DurableScriptPhase = "all" | "suspend" | "replay";

interface Counters {
  handlerRuns: number;
  checkpointOperations: number;
  caughtSuspensions: number;
  /** Handler runs that reached the end of the script. A run that suspends never does. */
  completedScripts: number;
  /** Timer, wait, and child calls that returned. A call that suspends never returns. */
  returnedSuspendingCalls: number;
}

/** The operations that can suspend the task. */
const SUSPENDING = new Set(["sleep", "sleepUntil", "waitForSignal", "waitForHuman", "runChild"]);

/** The SDK name of this runner in the worker names of a cross-SDK run. */
const SDK = "typescript";

/** A bound on the claims of one `run` step, so a defect cannot loop for ever. */
const MAXIMUM_DRAIN_PASSES = 20;

/**
 * Runs the steps of `phase` against the database of `pool`. The queue name depends only on the
 * fixture, so a phase in another SDK finds the same task.
 */
export async function runDurableScriptPhase(options: {
  pool: Pool;
  fixture: DurableScriptRuntimeFixture;
  phase: DurableScriptPhase;
}): Promise<void> {
  const { pool, fixture, phase } = options;
  const queueName = `runtime-${fixture.id}`;
  const queue = new Queue(pool, queueName);
  const handOff = fixture.steps.findIndex((step) => step.action === "handOff");
  const steps = selectSteps(fixture.steps, handOff, phase);
  const taskId =
    phase === "replay"
      ? await findRootTask(pool, fixture)
      : await queue.enqueue(fixture.taskType, await readPayload(pool, fixture), {
          queue: queueName,
        });
  const counters: Counters = {
    handlerRuns: 0,
    checkpointOperations: 0,
    caughtSuspensions: 0,
    completedScripts: 0,
    returnedSuspendingCalls: 0,
  };
  const worker = new Worker(queue, {
    workerId: `${SDK}-${fixture.id}`,
    queue: queueName,
    concurrency: 1,
    registryIntervalMs: 0,
  }).handle(fixture.taskType, (payload, context) =>
    runScript({ fixture, payload, context, counters }),
  );
  const workers: Record<"task" | "child", Worker | undefined> = { task: worker, child: undefined };
  if (fixture.childTaskType !== undefined && fixture.childQueue !== undefined) {
    workers.child = new Worker(new Queue(pool, fixture.childQueue), {
      workerId: `${SDK}-${fixture.id}-children`,
      queue: fixture.childQueue,
      concurrency: 1,
      registryIntervalMs: 0,
    }).handle(fixture.childTaskType, (payload) => ({ echo: payload }));
  }
  for (const [index, step] of steps.entries()) {
    const where = `${fixture.id} step ${index + 1} (${step.action})`;
    switch (step.action) {
      case "run": {
        const selected = workers[step.worker ?? "task"];
        if (selected === undefined) throw new Error(`${where}: the fixture has no child queue`);
        await drain(selected, where);
        break;
      }
      case "sql":
        await pool.query(step.sql, [taskId]);
        break;
      case "handOff":
        counters.handlerRuns = 0;
        counters.checkpointOperations = 0;
        counters.caughtSuspensions = 0;
        counters.completedScripts = 0;
        counters.returnedSuspendingCalls = 0;
        break;
      case "expect":
        await expectObserved({ pool, fixture, taskId, step, counters, where });
        break;
      default: {
        const unknown: never = step;
        throw new Error(`${where}: unknown step ${JSON.stringify(unknown)}`);
      }
    }
  }
}

/**
 * Runs the worker until a claim finds no task. The `runOnce` of each SDK can claim more than one
 * task, so a step names the work that ends, not a count of claims.
 */
async function drain(worker: Worker, where: string): Promise<void> {
  if (!(await worker.runOnce())) throw new Error(`${where}: the worker claimed no task`);
  for (let pass = 0; await worker.runOnce(); pass += 1) {
    if (pass >= MAXIMUM_DRAIN_PASSES) throw new Error(`${where}: the queue did not drain`);
  }
}

function selectSteps(
  steps: DurableScriptStep[],
  handOff: number,
  phase: DurableScriptPhase,
): DurableScriptStep[] {
  if (phase === "all") return steps;
  if (handOff < 0) throw new Error(`a ${phase} phase needs a handOff step`);
  return phase === "suspend" ? steps.slice(0, handOff) : steps.slice(handOff + 1);
}

async function readPayload(pool: Pool, fixture: DurableScriptRuntimeFixture): Promise<Json> {
  if (fixture.payloadSql === undefined) return {};
  const rows = await pool.query<{ payload: string }>(fixture.payloadSql);
  const [row] = rows.rows;
  if (row === undefined) throw new Error(`${fixture.id}: payloadSql returned no row`);
  const payload: Json = JSON.parse(row.payload);
  return payload;
}

async function findRootTask(pool: Pool, fixture: DurableScriptRuntimeFixture): Promise<string> {
  const rows = await pool.query<{ id: string }>(
    "SELECT id::text AS id FROM workhorse.task WHERE task_type = $1",
    [fixture.taskType],
  );
  const [row, ...others] = rows.rows;
  if (row === undefined || others.length > 0) {
    throw new Error(`${fixture.id}: expected one ${fixture.taskType} task, found ${rows.rowCount}`);
  }
  return row.id;
}

async function expectObserved(options: {
  pool: Pool;
  fixture: DurableScriptRuntimeFixture;
  taskId: string;
  step: Extract<DurableScriptStep, { action: "expect" }>;
  counters: Counters;
  where: string;
}): Promise<void> {
  const { pool, fixture, taskId, step, counters, where } = options;
  const rows = await pool.query<{ observed: string }>(fixture.observe, [taskId]);
  const observed: JsonValue = JSON.parse(rows.rows[0]?.observed ?? "null");
  const wanted = expectedObserved(step, where);
  if (!isDeepStrictEqual(observed, wanted)) {
    throw new Error(
      `${where}: observed ${JSON.stringify(observed)}, expected ${JSON.stringify(wanted)}`,
    );
  }
  for (const name of [
    "handlerRuns",
    "checkpointOperations",
    "caughtSuspensions",
    "completedScripts",
    "returnedSuspendingCalls",
  ] as const) {
    const expected = step[name];
    if (expected !== undefined && counters[name] !== expected) {
      throw new Error(`${where}: ${name} is ${counters[name]}, expected ${expected}`);
    }
  }
}

/** The observed value of `step`, with the error name of this SDK when the step names one. */
function expectedObserved(
  step: Extract<DurableScriptStep, { action: "expect" }>,
  where: string,
): JsonValue {
  if (step.errorNames === undefined) return step.observed;
  const errorName = step.errorNames[SDK];
  const observed = step.observed;
  if (
    errorName === undefined ||
    observed === null ||
    typeof observed !== "object" ||
    Array.isArray(observed)
  ) {
    throw new TypeError(`${where}: errorNames needs an observed object and a name for ${SDK}`);
  }
  return { ...observed, errorName };
}

async function runScript(options: {
  fixture: DurableScriptRuntimeFixture;
  payload: Json;
  context: HandlerContext;
  counters: Counters;
}): Promise<Json> {
  const { fixture, payload, context, counters } = options;
  counters.handlerRuns += 1;
  const result: Record<string, Json> = {};
  for (const operation of fixture.script) {
    if (operation.op === "catchSuspension") {
      try {
        await runOperation({ fixture, operation: operation.step, payload, context, counters });
      } catch {
        // The handler catches the suspension and returns. The worker must suspend the task anyway.
        counters.caughtSuspensions += 1;
        return { [operation.key]: true };
      }
      result[operation.key] = false;
      continue;
    }
    const value = await runOperation({ fixture, operation, payload, context, counters });
    if ("key" in operation) result[operation.key] = value;
  }
  counters.completedScripts += 1;
  return result;
}

async function runOperationOnce(options: {
  fixture: DurableScriptRuntimeFixture;
  operation: DurableScriptOperation;
  payload: Json;
  context: HandlerContext;
  counters: Counters;
}): Promise<Json> {
  const { fixture, operation, payload, context, counters } = options;
  switch (operation.op) {
    case "checkpoint":
      return context.checkpoint(
        operation.name,
        () => {
          counters.checkpointOperations += 1;
          return operation.value;
        },
        operation.input === undefined ? {} : { input: operation.input },
      );
    case "sleep":
      await context.sleep(operation.name, operation.durationMs);
      return null;
    case "sleepUntil":
      await context.sleepUntil(
        operation.name,
        new Date(payloadText(payload, operation.wakeAtField)),
      );
      return null;
    case "waitForSignal":
      return context.waitForSignal(operation.name);
    case "waitForHuman":
      return context.waitForHuman(operation.name, operation.context);
    case "runChild":
      return context.runChild(operation.name, childType(fixture), operation.payload, {
        queue: childQueue(fixture),
        ...(operation.deadlineField === undefined
          ? {}
          : { deadline: new Date(payloadText(payload, operation.deadlineField)) }),
        ...(operation.runAtField === undefined
          ? {}
          : { runAt: new Date(payloadText(payload, operation.runAtField)) }),
      });
    case "runChildren": {
      const outcomes = await context.runChildren(
        operation.children.map((child) => ({
          name: child.name,
          type: childType(fixture),
          payload: child.payload,
          options: { queue: childQueue(fixture) },
        })),
      );
      // The set join counts as returned before the runner reads its outcomes, so a wrong value
      // still counts.
      counters.returnedSuspendingCalls += 1;
      const joined: Record<string, Json> = {};
      for (const [name, outcome] of Object.entries(outcomes)) {
        joined[name] =
          outcome.status === "succeeded"
            ? { status: outcome.status, result: outcome.result }
            : { status: outcome.status };
      }
      return joined;
    }
    case "overlappingCheckpoints":
      return overlappingCheckpoints({ operation, context, counters });
    case "catchSuspension":
      throw new Error("catchSuspension cannot be nested");
    default: {
      const unknown: never = operation;
      throw new Error(`unknown durable-script operation ${JSON.stringify(unknown)}`);
    }
  }
}

async function runOperation(options: {
  fixture: DurableScriptRuntimeFixture;
  operation: DurableScriptOperation;
  payload: Json;
  context: HandlerContext;
  counters: Counters;
}): Promise<Json> {
  const value = await runOperationOnce(options);
  if (SUSPENDING.has(options.operation.op)) options.counters.returnedSuspendingCalls += 1;
  return value;
}

/**
 * Starts a second call with one name while the operation of the first call runs. The operation
 * waits until a second operation starts or the window ends, so a call that does not join the call
 * in flight runs the operation again.
 */
async function overlappingCheckpoints(options: {
  operation: Extract<DurableScriptOperation, { op: "overlappingCheckpoints" }>;
  context: HandlerContext;
  counters: Counters;
}): Promise<Json> {
  const { operation, context, counters } = options;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const checkpointOperation = async (): Promise<Json> => {
    counters.checkpointOperations += 1;
    const ordinal = counters.checkpointOperations;
    markStarted();
    const deadline = Date.now() + operation.overlapWindowMs;
    while (counters.checkpointOperations < 2 && Date.now() < deadline) {
      await sleep(10);
    }
    return { operation: ordinal };
  };
  const first = context.checkpoint(operation.name, checkpointOperation);
  await started;
  const second = context.checkpoint(operation.name, checkpointOperation);
  return Promise.all([first, second]);
}

function childType(fixture: DurableScriptRuntimeFixture): string {
  if (fixture.childTaskType === undefined) throw new Error(`${fixture.id} has no childTaskType`);
  return fixture.childTaskType;
}

function childQueue(fixture: DurableScriptRuntimeFixture): string {
  if (fixture.childQueue === undefined) throw new Error(`${fixture.id} has no childQueue`);
  return fixture.childQueue;
}

function payloadText(payload: Json, field: string): string {
  const value =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? payload[field]
      : undefined;
  if (typeof value !== "string") throw new TypeError(`the payload field ${field} is not text`);
  return value;
}
