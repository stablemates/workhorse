import { describe, expect, it } from "vitest";
import {
  connectionRoles,
  emptyRoleSampling,
  mergeChunk,
  type RoleChunk,
  type RoleSampling,
} from "./connection-budget-roles.js";

type Run = RoleChunk["runs"][number];

/** One sampler call that saw one backend, with times already relative to the cell start. */
function chunk(options: {
  first: number;
  last: number;
  seen?: { first: number; last: number; absent?: number | null };
  markers?: number[];
  commits?: number[];
  runs?: Omit<Run, "pid" | "backendStartMs">[];
}): RoleChunk {
  const { first, last, seen, markers = [], commits = [], runs = [] } = options;
  return {
    iterations: Math.round((last - first) / 2) + 1,
    firstIterationMs: first,
    lastIterationMs: last,
    relationBytes: 8192,
    backends:
      seen === undefined
        ? []
        : [
            {
              pid: 7,
              backendStartMs: -10,
              firstSeenMs: seen.first,
              lastSeenMs: seen.last,
              firstAbsentMs: seen.absent ?? null,
              markersMs: markers,
              commitsMs: commits,
            },
          ],
    runs: runs.map((run) => ({
      pid: 7,
      backendStartMs: -10,
      kind: run.kind,
      firstMs: run.firstMs,
      lastMs: run.lastMs,
    })),
  };
}

function sample(...chunks: RoleChunk[]): RoleSampling {
  const sampling = emptyRoleSampling();
  for (const entry of chunks) mergeChunk(sampling, entry, (epochMs) => epochMs);
  return sampling;
}

function roles(sampling: RoleSampling, samplerEndMs: number, commitInference = true) {
  return connectionRoles(sampling, {
    windowStartMs: 0,
    samplerEndMs,
    heartbeatMs: 1_000,
    commitInference,
  });
}

/** The role column of the series at a time: 2 is heartbeat, 3 former heartbeat, 4 statement. */
function countAt(result: ReturnType<typeof roles>, atMs: number, column: number): number {
  return result.series.rows.find((row) => row[0] === atMs)![column]!;
}

describe("connection roles", () => {
  it("ends the heartbeat role at a statement that follows heartbeats in one call", () => {
    const result = roles(
      sample(
        chunk({
          first: 0,
          last: 8_000,
          seen: { first: 0, last: 8_000 },
          markers: [1_000, 2_000, 3_000],
          commits: [1_001, 2_001, 3_001],
          runs: [
            { kind: "statement", firstMs: 0, lastMs: 900 },
            { kind: "heartbeat", firstMs: 1_000, lastMs: 3_000 },
            { kind: "statement", firstMs: 3_500, lastMs: 8_000 },
          ],
        }),
      ),
      8_000,
    );
    expect(result.backends[0]!.runs.map((run) => run.kind)).toEqual([
      "statement",
      "heartbeat",
      "statement",
    ]);
    expect(result.events).toContainEqual({
      atMs: 3_500,
      pid: 7,
      event: "heartbeat-end",
      reason: "statement",
    });
    expect(countAt(result, 3_250, 2)).toBe(1);
    expect(countAt(result, 4_000, 2)).toBe(0);
    expect(countAt(result, 4_000, 4)).toBe(1);
  });

  it("keeps statement runs apart when a heartbeat separates them across calls", () => {
    const result = roles(
      sample(
        chunk({
          first: 0,
          last: 1_500,
          seen: { first: 0, last: 1_500 },
          markers: [1_000],
          runs: [
            { kind: "statement", firstMs: 0, lastMs: 900 },
            { kind: "heartbeat", firstMs: 1_000, lastMs: 1_000 },
          ],
        }),
        chunk({
          first: 1_502,
          last: 8_000,
          seen: { first: 1_502, last: 8_000 },
          markers: [2_000, 3_000],
          runs: [
            { kind: "heartbeat", firstMs: 2_000, lastMs: 3_000 },
            { kind: "statement", firstMs: 3_500, lastMs: 8_000 },
          ],
        }),
      ),
      8_000,
    );
    expect(result.backends[0]!.runs).toEqual([
      { kind: "statement", firstMs: 0, lastMs: 900 },
      { kind: "heartbeat", firstMs: 1_000, lastMs: 3_000 },
      { kind: "statement", firstMs: 3_500, lastMs: 8_000 },
    ]);
    expect(result.events.at(-1)).toEqual({
      atMs: 3_500,
      pid: 7,
      event: "heartbeat-end",
      reason: "statement",
    });
  });

  it("confirms a COMMIT round only within one expiry time after a marker", () => {
    const result = roles(
      sample(
        chunk({
          first: 0,
          last: 8_000,
          seen: { first: 0, last: 8_000 },
          markers: [1_000],
          commits: [1_001, 2_001, 3_001],
          runs: [
            { kind: "statement", firstMs: 0, lastMs: 900 },
            { kind: "heartbeat", firstMs: 1_000, lastMs: 1_000 },
            { kind: "statement", firstMs: 3_500, lastMs: 8_000 },
          ],
        }),
      ),
      8_000,
    );
    const coverage = result.heartbeatCoverage[0]!;
    expect(coverage.markerRounds).toBe(1);
    expect(coverage.commitInferredRounds).toBe(2);
    expect(coverage.unconfirmedCommitRounds).toBe(1);
    expect(result.backends[0]!.rounds).toEqual([
      { atMs: 1_000, source: "marker", confirmed: true },
      { atMs: 2_001, source: "commit", confirmed: true },
      { atMs: 3_001, source: "commit", confirmed: false },
    ]);
    expect(result.events.at(-1)).toMatchObject({ atMs: 3_500, reason: "statement" });
  });

  it("does not count COMMITs long after the last marker as coverage", () => {
    const commits = Array.from({ length: 14 }, (_, index) => 2_000 + index * 1_000);
    const observations = () =>
      sample(
        chunk({
          first: 0,
          last: 16_000,
          seen: { first: 0, last: 16_000 },
          markers: [1_000],
          commits,
          runs: [{ kind: "heartbeat", firstMs: 1_000, lastMs: 1_000 }],
        }),
      );
    const inferred = roles(observations(), 16_000);
    const coverage = inferred.heartbeatCoverage[0]!;
    // Under the autocommit assumption the COMMITs renew the role, but only three rounds are
    // confirmed, so the observation is incomplete.
    expect(coverage.roundsObserved).toBe(15);
    expect(coverage.unconfirmedCommitRounds).toBe(12);
    expect(coverage.windowsObserved).toBe(3);
    expect(coverage.windowsInRole).toBe(15);
    expect(coverage.trailingGapMs).toBe(13_000);
    expect(inferred.heartbeatObservationIncomplete).toBe(true);
    expect(countAt(inferred, 10_000, 2)).toBe(1);
    // Without COMMIT inference, the role expires two seconds after the only marker.
    const markersOnly = roles(observations(), 16_000, false);
    expect(markersOnly.events.at(-1)).toMatchObject({ atMs: 3_000, reason: "expired" });
    expect(countAt(markersOnly, 10_000, 3)).toBe(1);
  });

  it("counts only markers when COMMIT inference is off", () => {
    const result = roles(
      sample(
        chunk({
          first: 0,
          last: 4_000,
          seen: { first: 0, last: 4_000 },
          markers: [1_000],
          commits: [2_001],
          runs: [{ kind: "heartbeat", firstMs: 1_000, lastMs: 1_000 }],
        }),
      ),
      4_000,
      false,
    );
    expect(result.commitInference).toBe(false);
    expect(result.commitInferredRounds).toBe(0);
    expect(result.markerRounds).toBe(1);
  });

  it("reports the gap from the last round to the end of the role", () => {
    const result = roles(
      sample(
        chunk({
          first: 0,
          last: 2_750,
          seen: { first: 0, last: 2_750 },
          markers: [100, 1_100],
          runs: [{ kind: "heartbeat", firstMs: 100, lastMs: 1_100 }],
        }),
      ),
      2_750,
    );
    const coverage = result.heartbeatCoverage[0]!;
    expect(coverage.maxRoundGapMs).toBe(1_650);
    expect(coverage.trailingGapMs).toBe(1_650);
    expect(coverage.trailingGapsAboveLimit).toBe(1);
    expect(result.heartbeatObservationIncomplete).toBe(true);
  });

  it("accepts a short final interval when every round was observed", () => {
    const markers = Array.from({ length: 10 }, (_, index) => 100 + index * 1_000);
    const result = roles(
      sample(
        chunk({
          first: 0,
          last: 9_500,
          seen: { first: 0, last: 9_500 },
          markers,
          runs: [{ kind: "heartbeat", firstMs: 100, lastMs: 9_100 }],
        }),
      ),
      9_500,
    );
    const coverage = result.heartbeatCoverage[0]!;
    expect(coverage.trailingGapMs).toBe(400);
    expect(coverage.windowsObserved).toBe(coverage.windowsInRole);
    expect(result.heartbeatObservationIncomplete).toBe(false);
  });

  it("records a closure near the end with the last-present and first-absent bounds", () => {
    const result = roles(
      sample(
        chunk({
          first: 0,
          last: 9_000,
          seen: { first: 0, last: 9_000 },
          markers: [1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000],
          runs: [{ kind: "heartbeat", firstMs: 1_000, lastMs: 9_000 }],
        }),
        chunk({ first: 9_002, last: 10_000 }),
      ),
      10_000,
    );
    expect(result.events.at(-1)).toEqual({
      atMs: 9_000,
      pid: 7,
      event: "heartbeat-end",
      reason: "closed",
      closure: { lastPresentMs: 9_000, firstAbsentMs: 9_002 },
    });
  });
});
