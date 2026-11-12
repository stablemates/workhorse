import { expectTypeOf, it } from "vitest";
import { Pool, replayHandler } from "../src/index.js";
import type {
  Admin,
  ChildTaskOptions,
  ChildTaskRequest,
  ClaimedTask,
  DurableState,
  Handler,
  HandlerContext,
  HandlerReplayReport,
  HandlerResult,
  Json,
  TaskSnapshot,
  Queryable,
  Queue,
  Worker,
} from "../src/index.js";

function assertNonJsonTypeArgumentsFail(queue: Queue, admin: Admin): void {
  // @ts-expect-error Date cannot be stored in a JSON payload column.
  expectTypeOf<ClaimedTask<Date>>().toBeObject();
  // @ts-expect-error Date cannot be stored in a JSON result column.
  expectTypeOf<TaskSnapshot<Date>>().toBeObject();
  // @ts-expect-error Date cannot be stored in a JSON payload column.
  void queue.claim<Date>("worker");
  // @ts-expect-error Date cannot be stored in a JSON result column.
  void admin.getTask<Date>("task");
}

it("constrains claimed payloads and snapshot results to JSON", () => {
  expectTypeOf<Awaited<ReturnType<Queue["claim"]>>>().toEqualTypeOf<ClaimedTask | null>();
  expectTypeOf<Awaited<ReturnType<Admin["getTask"]>>>().toEqualTypeOf<TaskSnapshot | null>();
  expectTypeOf(assertNonJsonTypeArgumentsFail).toBeFunction();
});

it("exports the options type that child task requests name", () => {
  expectTypeOf<NonNullable<ChildTaskRequest["options"]>>().toEqualTypeOf<ChildTaskOptions>();
});

it("exports the default node-postgres pool as a queryable", () => {
  expectTypeOf<InstanceType<typeof Pool>>().toMatchTypeOf<Queryable>();
});

it("separates application queue operations from administrative operations", () => {
  expectTypeOf<Queue>().not.toHaveProperty("getTask");
  expectTypeOf<Queue>().not.toHaveProperty("listTasks");
  expectTypeOf<Queue>().not.toHaveProperty("pauseQueue");
  expectTypeOf<Queue>().not.toHaveProperty("purgeQueue");
  expectTypeOf<Queue>().not.toHaveProperty("listCheckpoints");
  expectTypeOf<Queue>().not.toHaveProperty("getProgress");
  expectTypeOf<Queue>().not.toHaveProperty("listWaits");
  expectTypeOf<Queue>().not.toHaveProperty("readWorkerCheckpoints");
  expectTypeOf<Queue>().not.toHaveProperty("readWorkerProgress");
  expectTypeOf<Queue>().not.toHaveProperty("readWorkerWaits");

  expectTypeOf<Admin>().toHaveProperty("getTask");
  expectTypeOf<Admin>().toHaveProperty("listTasks");
  expectTypeOf<Admin>().toHaveProperty("pauseQueue");
  expectTypeOf<Admin>().toHaveProperty("purgeQueue");
  expectTypeOf<Admin>().toHaveProperty("listCheckpoints");
  expectTypeOf<Admin>().toHaveProperty("getProgress");
  expectTypeOf<Admin>().toHaveProperty("listWaits");
});

// SM-1969 and SM-2012 (ADR 0119): the run time stores null for a handler or a checkpoint operation
// that returns no value. A handler whose result type includes null can return no value, and a
// handler whose result type excludes null must return a value of that type.
const noValueHandler: Handler<{ id: string }> = async () => {};
const syncNoValueHandler: Handler<{ id: string }> = () => {};
const nullableResult: Handler<{ id: string }, { id: string } | null> = async () => {};
// @ts-expect-error A handler typed with a result that excludes null must return its value.
const requiredResult: Handler<{ id: string }, { id: string }> = async () => {};
// @ts-expect-error The same holds for a handler that returns at once.
const requiredSyncResult: Handler<{ id: string }, { id: string }> = () => {};
const nullResult: Handler<{ id: string }> = async () => null;
const valueResult: Handler<{ id: string }, { id: string }> = async (payload) => payload;

// A caller of a handler reads a HandlerResult, which can be undefined. The wrapper of SM-2012 that
// returned the value as Json compiled before this change, and now needs `?? null`.
const wrapped = async (handler: Handler<null>, context: HandlerContext<null>): Promise<Json> =>
  // @ts-expect-error The value of a handler call can be undefined.
  await handler(null, context);
const fixedWrapper = async (handler: Handler<null>, context: HandlerContext<null>): Promise<Json> =>
  (await handler(null, context)) ?? null;
const forwardingWrapper = async (
  handler: Handler<null>,
  context: HandlerContext<null>,
): Promise<HandlerResult> => await handler(null, context);

// A generic wrapper with the result type R returns HandlerResult<R>. `?? null` does not give R,
// because R can exclude null.
async function genericWrapper<P extends Json, R extends Json>(
  handler: Handler<P, R>,
  payload: P,
  context: HandlerContext<P>,
): Promise<HandlerResult<R>> {
  return await handler(payload, context);
}
async function genericNullWrapper<P extends Json, R extends Json>(
  handler: Handler<P, R>,
  payload: P,
  context: HandlerContext<P>,
): Promise<R> {
  // @ts-expect-error `R | null` is not R for a generic R.
  return (await handler(payload, context)) ?? null;
}

function assertHandlerRegistration(worker: Worker, state: DurableState): void {
  worker.handle("welcome", async () => {});
  worker.handle("welcome", () => {});
  worker.handle("welcome", async (payload: { id: string }) => payload);
  // @ts-expect-error An explicit result type that excludes null requires a value.
  worker.handle<{ id: string }, { id: string }>("welcome", async () => {});
  expectTypeOf(replayHandler(async () => {}, null, state)).toEqualTypeOf<
    Promise<HandlerReplayReport<Json>>
  >();
  expectTypeOf(replayHandler(async () => ({ id: "a1" }), null, state)).toEqualTypeOf<
    Promise<HandlerReplayReport<{ id: string }>>
  >();
}

function assertCheckpointTypes(context: HandlerContext): void {
  expectTypeOf(context.checkpoint("welcome", async () => {})).toEqualTypeOf<Promise<null>>();
  expectTypeOf(context.checkpoint("count", () => 1)).toMatchTypeOf<Promise<number>>();
  expectTypeOf(context.checkpoint("account", async () => ({ id: "a1" }))).toEqualTypeOf<
    Promise<{ id: string }>
  >();
  expectTypeOf(context.checkpoint<{ id: string }>("account", () => ({ id: "a1" }))).toEqualTypeOf<
    Promise<{ id: string }>
  >();
  // @ts-expect-error A checkpoint whose value type excludes null must return a value.
  void context.checkpoint<{ id: string }>("account", async () => {});
}

it("lets a handler return no value and adds a void checkpoint signature", () => {
  expectTypeOf(assertCheckpointTypes).toBeFunction();
  expectTypeOf(assertHandlerRegistration).toBeFunction();
  expectTypeOf([genericWrapper, genericNullWrapper]).toBeArray();
  expectTypeOf([
    noValueHandler,
    syncNoValueHandler,
    nullableResult,
    requiredResult,
    requiredSyncResult,
    nullResult,
    valueResult,
  ]).toBeArray();
  expectTypeOf<HandlerResult<{ id: string }>>().toEqualTypeOf<{ id: string }>();
  expectTypeOf<HandlerResult<{ id: string } | null>>().toEqualTypeOf<{
    id: string;
  } | null | void>();
  expectTypeOf<ReturnType<Handler<null>>>().toEqualTypeOf<Promise<HandlerResult> | HandlerResult>();
  expectTypeOf(wrapped).returns.toEqualTypeOf<Promise<Json>>();
  expectTypeOf(fixedWrapper).returns.toEqualTypeOf<Promise<Json>>();
  expectTypeOf(forwardingWrapper).returns.toEqualTypeOf<Promise<HandlerResult>>();
  expectTypeOf<
    Awaited<ReturnType<typeof replayHandler<{ id: string }, { id: string }>>>
  >().toEqualTypeOf<HandlerReplayReport<{ id: string }>>();
});
