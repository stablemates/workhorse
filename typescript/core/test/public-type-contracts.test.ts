import { expectTypeOf, it } from "vitest";
import type { Admin, ClaimedJob, JobSnapshot, Queue } from "../src/index.js";

function assertNonJsonTypeArgumentsFail(queue: Queue, admin: Admin): void {
  // @ts-expect-error Date cannot be stored in a JSON payload column.
  expectTypeOf<ClaimedJob<Date>>().toBeObject();
  // @ts-expect-error Date cannot be stored in a JSON result column.
  expectTypeOf<JobSnapshot<Date>>().toBeObject();
  // @ts-expect-error Date cannot be stored in a JSON payload column.
  void queue.claim<Date>("worker");
  // @ts-expect-error Date cannot be stored in a JSON result column.
  void (null as unknown as Admin).getJob<Date>("job");
}

it("constrains claimed payloads and snapshot results to JSON", () => {
  expectTypeOf<Awaited<ReturnType<Queue["claim"]>>>().toEqualTypeOf<ClaimedJob | null>();
  expectTypeOf<Awaited<ReturnType<Admin["getJob"]>>>().toEqualTypeOf<JobSnapshot | null>();
  expectTypeOf(assertNonJsonTypeArgumentsFail).toBeFunction();
});

it("separates application queue operations from administrative operations", () => {
  expectTypeOf<Queue>().not.toHaveProperty("getJob");
  expectTypeOf<Queue>().not.toHaveProperty("listJobs");
  expectTypeOf<Queue>().not.toHaveProperty("pauseQueue");
  expectTypeOf<Queue>().not.toHaveProperty("purgeQueue");
  expectTypeOf<Queue>().not.toHaveProperty("listCheckpoints");
  expectTypeOf<Queue>().not.toHaveProperty("getProgress");
  expectTypeOf<Queue>().not.toHaveProperty("listWaits");
  expectTypeOf<Queue>().not.toHaveProperty("readWorkerCheckpoints");
  expectTypeOf<Queue>().not.toHaveProperty("readWorkerProgress");
  expectTypeOf<Queue>().not.toHaveProperty("readWorkerWaits");

  expectTypeOf<Admin>().toHaveProperty("getJob");
  expectTypeOf<Admin>().toHaveProperty("listJobs");
  expectTypeOf<Admin>().toHaveProperty("pauseQueue");
  expectTypeOf<Admin>().toHaveProperty("purgeQueue");
  expectTypeOf<Admin>().toHaveProperty("listCheckpoints");
  expectTypeOf<Admin>().toHaveProperty("getProgress");
  expectTypeOf<Admin>().toHaveProperty("listWaits");
});
