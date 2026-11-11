import { expectTypeOf, it } from "vitest";
import { Pool, replayHandler } from "../src/index.js";
import type {
  Admin,
  ChildTaskOptions,
  ChildTaskRequest,
  ClaimedTask,
  Handler,
  HandlerContext,
  HandlerReplayReport,
  Json,
  TaskSnapshot,
  Queryable,
  Queue,
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

// SM-1969 (ADR 0119): the run time stores null for a handler or a checkpoint operation that returns
// no value. The Handler type does not change, so a typed handler with no result returns null, and
// code that calls a Handler keeps the type of its value. The checkpoint gains a void signature.
// @ts-expect-error The Handler type requires a value, also for the default Json result.
const noValueHandler: Handler<{ id: string }> = async () => {};
// @ts-expect-error A handler typed with a result must return its value.
const requiredResult: Handler<{ id: string }, { id: string }> = async () => {};
const nullResult: Handler<{ id: string }> = async () => null;
const valueResult: Handler<{ id: string }, { id: string }> = async (payload) => payload;
// A wrapper that calls a handler and returns its value as Json compiles as on main.
const wrapped = async (handler: Handler<null>, context: HandlerContext<null>): Promise<Json> =>
  await handler(null, context);

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

it("keeps the Handler type and adds a void checkpoint signature", () => {
  expectTypeOf(assertCheckpointTypes).toBeFunction();
  expectTypeOf([noValueHandler, requiredResult, nullResult, valueResult]).toBeArray();
  expectTypeOf(wrapped).returns.toEqualTypeOf<Promise<Json>>();
  expectTypeOf<
    Awaited<ReturnType<typeof replayHandler<{ id: string }, { id: string }>>>
  >().toEqualTypeOf<HandlerReplayReport<{ id: string }>>();
});
