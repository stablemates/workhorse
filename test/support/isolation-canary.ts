import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Queue } from "../../src/index.js";
import { createDatabaseTestHarness } from "./db.js";

/**
 * Deliberate cross-file state-leak canary.
 *
 * Two sibling test files each run this suite with mirrored job types. Both files believe they own
 * a private database, so each writes its own job type in rounds and asserts after every round that
 * no other job type is visible. If per-file isolation ever regresses — two files hashing to one
 * database, a harness edit that shares a pool, a suite writing to the guarded shared database —
 * the sibling's rows appear here and the canary names the intruder in its failure.
 *
 * The rounds are spaced so the two files overlap in wall-clock time under parallel execution.
 * Overlap is what arms the canary; a serialized run still passes but only proves half as much.
 */
export function runIsolationCanary(fileUrl: string, ownType: string, foreignType: string): void {
  const database = createDatabaseTestHarness(fileUrl);
  const queue = new Queue(database.pool);
  const rounds = 8;
  const jobsPerRound = 5;
  const roundSpacingMs = 100;

  beforeAll(async () => {
    await database.setup();
  });

  afterAll(async () => {
    await database.teardown();
  });

  it(`sees only ${ownType} while the ${foreignType} canary runs`, async () => {
    for (let round = 1; round <= rounds; round += 1) {
      for (let job = 0; job < jobsPerRound; job += 1) {
        await queue.enqueue(ownType, { round, job });
      }
      await sleep(roundSpacingMs);
      const observed = await database.pool.query<{ job_type: string; jobs: number }>(
        `SELECT job_type, count(*)::int AS jobs
           FROM workhorse.job
          GROUP BY job_type
          ORDER BY job_type`,
      );
      // A foreign job type in this result means per-file isolation is broken: another test file
      // reached this file's database. The failure diff names the intruding type.
      expect(observed.rows).toEqual([{ job_type: ownType, jobs: round * jobsPerRound }]);
    }
  });
}
