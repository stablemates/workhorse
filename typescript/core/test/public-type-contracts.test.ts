import { expectTypeOf, it } from "vitest";
import type { ClaimedJob, JobSnapshot, Queue } from "../src/index.js";

function assertNonJsonTypeArgumentsFail(queue: Queue): void {
  // @ts-expect-error Date cannot be stored in a JSON payload column.
  expectTypeOf<ClaimedJob<Date>>().toBeObject();
  // @ts-expect-error Date cannot be stored in a JSON result column.
  expectTypeOf<JobSnapshot<Date>>().toBeObject();
  // @ts-expect-error Date cannot be stored in a JSON payload column.
  void queue.claim<Date>("worker");
  // @ts-expect-error Date cannot be stored in a JSON result column.
  void queue.getJob<Date>("job");
}

it("constrains claimed payloads and snapshot results to JSON", () => {
  expectTypeOf<Awaited<ReturnType<Queue["claim"]>>>().toEqualTypeOf<ClaimedJob | null>();
  expectTypeOf<Awaited<ReturnType<Queue["getJob"]>>>().toEqualTypeOf<JobSnapshot | null>();
  expectTypeOf(assertNonJsonTypeArgumentsFail).toBeFunction();
});
