import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { dueOccurrences } from "../src/worker.js";

interface CronOccurrenceFixture {
  id: string;
  expression: string;
  timezone: string;
  lastOccurrenceAt: string | null;
  now: string;
  limit: number;
  expected: string[];
}

const fixtures = JSON.parse(
  await readFile(new URL("../../../protocol/v1/cron-occurrences.json", import.meta.url), "utf8"),
) as CronOccurrenceFixture[];

describe("cron occurrence compatibility", () => {
  it.each(fixtures)("matches the shared table for $id", (fixture) => {
    const actual = dueOccurrences(
      fixture.expression,
      fixture.lastOccurrenceAt === null ? null : new Date(fixture.lastOccurrenceAt),
      new Date(fixture.now),
      fixture.limit,
      fixture.timezone,
    );

    expect(actual.map((occurrence) => occurrence.toISOString())).toEqual(
      fixture.expected.map((occurrence) => new Date(occurrence).toISOString()),
    );
  });
});
