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
  void admin.getJob<Date>("job");
  // @ts-expect-error Operator reads belong to Admin.
  void queue.getJob("job");
}

it("constrains claimed payloads and snapshot results to JSON", () => {
  expectTypeOf<Awaited<ReturnType<Queue["claim"]>>>().toEqualTypeOf<ClaimedJob | null>();
  expectTypeOf<Awaited<ReturnType<Admin["getJob"]>>>().toEqualTypeOf<JobSnapshot | null>();
  expectTypeOf(assertNonJsonTypeArgumentsFail).toBeFunction();
});
