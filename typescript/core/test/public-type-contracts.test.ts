import { expectTypeOf, it } from "vitest";
import { Pool } from "../src/index.js";
import type { Admin, ClaimedTask, TaskSnapshot, Queryable, Queue } from "../src/index.js";

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
