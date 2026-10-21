import { describe, expect, it } from "vitest";
import {
  type AttemptRecords,
  attributeFaultClaims,
  type CellFacts,
  cellResult,
  connectionRoles,
  emptyRoleSampling,
  faultRecovery,
  heartbeatReadyIntervals,
  heartbeatRoleBackendsAt,
  latestNextSlot,
  mergeChunk,
  replayDispatch,
  type RoleChunk,
  type RoleSampling,
  watchdogVerdict,
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
      { kind: "statement", firstMs: 0, lastMs: 900, lastUseMs: null },
      { kind: "heartbeat", firstMs: 1_000, lastMs: 3_000, lastUseMs: null },
      { kind: "statement", firstMs: 3_500, lastMs: 8_000, lastUseMs: null },
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

/** One sampler call that saw several backends, each with its own runs. Times are relative. */
function multiChunk(
  first: number,
  last: number,
  backends: {
    pid: number;
    seen: { first: number; last: number; absent?: number | null };
    markers?: number[];
    commits?: number[];
    runs?: Omit<Run, "pid" | "backendStartMs">[];
  }[],
): RoleChunk {
  return {
    iterations: Math.round((last - first) / 2) + 1,
    firstIterationMs: first,
    lastIterationMs: last,
    relationBytes: 8192,
    backends: backends.map((backend) => ({
      pid: backend.pid,
      backendStartMs: -10,
      firstSeenMs: backend.seen.first,
      lastSeenMs: backend.seen.last,
      firstAbsentMs: backend.seen.absent ?? null,
      markersMs: backend.markers ?? [],
      commitsMs: backend.commits ?? [],
    })),
    runs: backends.flatMap((backend) =>
      (backend.runs ?? []).map((run) =>
        Object.assign({ pid: backend.pid, backendStartMs: -10 }, run),
      ),
    ),
  };
}

const faultOptions = {
  windowStartMs: 0,
  samplerEndMs: 40_000,
  heartbeatMs: 10_000,
  commitInference: true,
};

// Backend 1 is the heartbeat connection until the fault at 20 s. Backend 2 runs claims until
// 21.5 s, and then becomes the replacement with its first round at 22 s.
function faultObservations(): RoleSampling {
  return sample(
    multiChunk(0, 40_000, [
      {
        pid: 1,
        seen: { first: 0, last: 19_999, absent: 20_001 },
        markers: [0, 10_000, 19_998],
        runs: [{ kind: "heartbeat", firstMs: 0, lastMs: 19_998 }],
      },
      {
        pid: 2,
        seen: { first: 0, last: 40_000 },
        markers: [22_000, 32_000],
        runs: [
          { kind: "statement", firstMs: 0, lastMs: 21_500, lastUseMs: 21_500 },
          { kind: "heartbeat", firstMs: 22_000, lastMs: 32_000 },
        ],
      },
    ]),
  );
}

const ended = { pid: 1, backendStartMs: -10 };

describe("fault recovery", () => {
  it("finds the heartbeat backends at a time", () => {
    expect(heartbeatRoleBackendsAt(faultObservations(), faultOptions, 15_000)).toEqual([
      { pid: 1, backendStartMs: -10 },
    ]);
  });

  it("keeps a role that is open at the end of the observations", () => {
    // The sampler has returned up to 19.5 s, and the fault comes at 20 s.
    const options = { ...faultOptions, samplerEndMs: 19_500 };
    const observed = sample(
      multiChunk(0, 19_500, [
        {
          pid: 3,
          seen: { first: 0, last: 19_500 },
          markers: [10_000],
          runs: [{ kind: "heartbeat", firstMs: 10_000, lastMs: 10_000 }],
        },
      ]),
    );
    expect(heartbeatRoleBackendsAt(observed, options, 19_500)).toEqual([
      { pid: 3, backendStartMs: -10 },
    ]);
    expect(heartbeatRoleBackendsAt(observed, options, 20_000)).toEqual([
      { pid: 3, backendStartMs: -10 },
    ]);
  });

  it("bounds the time when the replacement was ready", () => {
    const recovery = faultRecovery(faultObservations(), faultOptions, {
      faultAtMs: 20_000,
      interrupted: ended,
      terminated: [ended],
    });
    expect(recovery.replacement).toEqual({
      pid: 2,
      backendStartMs: -10,
      firstRoundMs: 22_000,
      readyNotBeforeMs: 21_500,
    });
    // The interrupted round at 19,998 ms renewed nothing, so the last renewal came at 10 s.
    expect(recovery.lastRoundBeforeFaultMs).toBe(10_000);
  });

  it("does not move the readiness bound with the text that an idle backend keeps", () => {
    // Finding 3: backend 2 ends a claim at 20,010 ms and stays idle with that text until its
    // first round at 20,060 ms. Only the end of the claim shows a use.
    const recovery = faultRecovery(
      sample(
        multiChunk(0, 40_000, [
          {
            pid: 1,
            seen: { first: 0, last: 19_999, absent: 20_001 },
            markers: [10_000, 19_998],
            runs: [{ kind: "heartbeat", firstMs: 10_000, lastMs: 19_998 }],
          },
          {
            pid: 2,
            seen: { first: 0, last: 40_000 },
            markers: [20_060],
            runs: [
              { kind: "statement", firstMs: 0, lastMs: 20_050, lastUseMs: 20_010 },
              { kind: "heartbeat", firstMs: 20_060, lastMs: 20_060 },
            ],
          },
        ]),
      ),
      faultOptions,
      { faultAtMs: 20_000, interrupted: ended, terminated: [ended] },
    );
    expect(recovery.replacement).toMatchObject({ readyNotBeforeMs: 20_010, firstRoundMs: 20_060 });
  });

  it("does not move the readiness bound without a sample that shows a use", () => {
    const recovery = faultRecovery(
      sample(
        multiChunk(0, 40_000, [
          {
            pid: 1,
            seen: { first: 0, last: 19_999, absent: 20_001 },
            markers: [10_000, 19_998],
            runs: [{ kind: "heartbeat", firstMs: 10_000, lastMs: 19_998 }],
          },
          {
            pid: 2,
            seen: { first: 0, last: 40_000 },
            markers: [20_060],
            runs: [
              { kind: "statement", firstMs: 0, lastMs: 20_050 },
              { kind: "heartbeat", firstMs: 20_060, lastMs: 20_060 },
            ],
          },
        ]),
      ),
      faultOptions,
      { faultAtMs: 20_000, interrupted: ended, terminated: [ended] },
    );
    expect(recovery.replacement).toMatchObject({ readyNotBeforeMs: 20_000 });
  });

  it("keeps the last round of a backend that the fault did not interrupt", () => {
    const recovery = faultRecovery(faultObservations(), faultOptions, {
      faultAtMs: 20_000,
      interrupted: null,
      terminated: [ended],
    });
    expect(recovery.lastRoundBeforeFaultMs).toBe(19_998);
  });

  it("reports no replacement when no other backend runs a round", () => {
    const recovery = faultRecovery(faultObservations(), faultOptions, {
      faultAtMs: 20_000,
      interrupted: ended,
      terminated: [ended, { pid: 2, backendStartMs: -10 }],
    });
    expect(recovery.replacement).toBeNull();
  });

  it("gives the times with a heartbeat role as readiness", () => {
    expect(heartbeatReadyIntervals(faultObservations(), faultOptions)).toEqual([
      { fromMs: 0, toMs: 19_999 },
      { fromMs: 22_000, toMs: 40_000 },
    ]);
  });
});

/** Claims and settlements of one worker. */
const by = (worker: string) => (atMs: number) => ({ atMs, worker });
const settled =
  (worker: string, returnsToReady = false) =>
  (atMs: number) => ({ atMs, worker, returnsToReady });
const alwaysReady = { ready: [{ fromMs: 0, toMs: 1_000_000 }], notReady: [] };

describe("dispatch replay", () => {
  it("does not count a fused completion as a gap", () => {
    const replay = replayDispatch({
      claims: [100, 1_300, 2_500].map(by("w")),
      closes: [1_300, 2_500].map(settled("w")),
      tasks: 10,
      workers: [{ worker: "w", atMs: 100 }],
      slotsPerWorker: 1,
      readiness: alwaysReady,
      endMs: 2_600,
    });
    expect(replay.certain.lengthMs).toBe(0);
    expect(replay.possible.lengthMs).toBe(0);
  });

  it("counts the time from a free slot to the next claim while a task is ready", () => {
    const replay = replayDispatch({
      claims: [100, 4_000].map(by("w")),
      closes: [1_300].map(settled("w")),
      tasks: 10,
      workers: [{ worker: "w", atMs: 100 }],
      slotsPerWorker: 1,
      readiness: alwaysReady,
      endMs: 5_000,
    });
    expect(replay.certain).toEqual({ lengthMs: 2_700, startMs: 1_300, endMs: 4_000, worker: "w" });
  });

  it("counts a task that a lost lease made ready again", () => {
    const replay = replayDispatch({
      claims: [0, 9_000].map(by("w")),
      closes: [3_000].map(settled("w", true)),
      tasks: 1,
      workers: [{ worker: "w", atMs: 0 }],
      slotsPerWorker: 1,
      readiness: alwaysReady,
      endMs: 10_000,
    });
    expect(replay.certain).toEqual({ lengthMs: 6_000, startMs: 3_000, endMs: 9_000, worker: "w" });
  });

  it("finds a worker with a free slot while another worker claims", () => {
    const replay = replayDispatch({
      claims: [
        ...[0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000].map(by("a")),
        ...[0, 7_500].map(by("b")),
      ],
      closes: [
        ...[1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000].map(settled("a")),
        ...[1_000].map(settled("b")),
      ],
      tasks: 100,
      workers: [
        { worker: "a", atMs: 0 },
        { worker: "b", atMs: 0 },
      ],
      slotsPerWorker: 1,
      readiness: alwaysReady,
      endMs: 8_000,
    });
    expect(replay.certain).toEqual({ lengthMs: 6_500, startMs: 1_000, endMs: 7_500, worker: "b" });
  });

  it("ends the gap of a worker that never claims when no task is ready", () => {
    // Finding 5: the validator's case. Two workers, one task claimed at 100 ms, and the end at
    // 10 s. The worker that never claims has no ready task after 100 ms.
    const replay = replayDispatch({
      claims: [100].map(by("a")),
      closes: [],
      tasks: 1,
      workers: [
        { worker: "a", atMs: 0 },
        { worker: "b", atMs: 0 },
      ],
      slotsPerWorker: 1,
      readiness: alwaysReady,
      endMs: 10_000,
    });
    expect(replay.certain.lengthMs).toBe(100);
    expect(replay.possible.lengthMs).toBe(100);
    expect(replay.demand).toEqual([{ fromMs: 0, toMs: 100 }]);
  });

  it("counts the startup of a worker before its first claim", () => {
    // Finding 5: the worker starts at 0. The first heartbeat round, at 6 s, shows the reservation.
    const replay = replayDispatch({
      claims: [7_000].map(by("w")),
      closes: [],
      tasks: 10,
      workers: [{ worker: "w", atMs: 0 }],
      slotsPerWorker: 1,
      readiness: { ready: [{ fromMs: 6_000, toMs: 20_000 }], notReady: [] },
      endMs: 8_000,
    });
    expect(replay.certain).toEqual({ lengthMs: 1_000, startMs: 6_000, endMs: 7_000, worker: "w" });
    expect(replay.possible).toEqual({ lengthMs: 7_000, startMs: 0, endMs: 7_000, worker: "w" });
  });

  it("does not count a replacement of the heartbeat connection as a ready time", () => {
    // Finding 5: one heartbeat connection ends at 10 s, and the next one shows at 13 s.
    const replay = replayDispatch({
      claims: [0, 17_000].map(by("w")),
      closes: [10_000].map(settled("w")),
      tasks: 10,
      workers: [{ worker: "w", atMs: 0 }],
      slotsPerWorker: 1,
      readiness: {
        ready: [
          { fromMs: 0, toMs: 10_000 },
          { fromMs: 13_000, toMs: 30_000 },
        ],
        notReady: [],
      },
      endMs: 18_000,
    });
    expect(replay.certain).toEqual({
      lengthMs: 4_000,
      startMs: 13_000,
      endMs: 17_000,
      worker: "w",
    });
    expect(replay.possible.lengthMs).toBe(7_000);
  });

  it("ends a gap when the reservation is not ready", () => {
    const replay = replayDispatch({
      claims: [0, 17_000].map(by("w")),
      closes: [10_000].map(settled("w")),
      tasks: 10,
      workers: [{ worker: "w", atMs: 0 }],
      slotsPerWorker: 1,
      readiness: { ready: [], notReady: [{ fromMs: 11_000, toMs: 16_000 }] },
      endMs: 18_000,
    });
    // The gaps from 10 s to 11 s and from 16 s to 17 s are 1 s each; the time not ready is none.
    expect(replay.possible.lengthMs).toBe(1_000);
    expect(replay.certain.lengthMs).toBe(0);
  });
});

describe("claim attribution after a fault", () => {
  it("sorts claims by the start of their claim function", () => {
    const claims = [
      { atMs: 20_001, worker: "a", acquiredMs: 19_999 },
      { atMs: 20_005, worker: "a", acquiredMs: 20_004 },
      { atMs: 20_030, worker: "b", acquiredMs: 20_030 },
      { atMs: 20_040, worker: "b", acquiredMs: null },
    ];
    expect(attributeFaultClaims(claims, 20_000, 20_010)).toEqual({
      fresh: [20_030],
      uncertain: [20_005, 20_040],
      beforeFault: 1,
    });
    // Without the end of the running statements, no claim after the fault is fresh.
    expect(attributeFaultClaims(claims, 20_000, null).fresh).toEqual([]);
  });
});

/**
 * The rows that the driver reads for one long task "t:1" across a fault at 20 s: its claim at
 * 5 s, its last sample with the renewal at 15 s and the deadline at 45 s, and the end of the
 * observation at 50 s.
 */
function records(overrides: Partial<AttemptRecords> = {}): AttemptRecords {
  return {
    claimed: [{ attempt: "t:1", atMs: 5_000 }],
    closed: [],
    lastSamples: [{ attempt: "t:1", renewalMs: 15_000, deadlineMs: 45_000 }],
    liveAtEnd: [],
    observedUntilMs: 50_000,
    ...overrides,
  };
}

describe("watchdog bound of the attempts of a fault cell", () => {
  it("cannot decide an early local loss that the database recovers later", () => {
    // Round 2, finding 2: the worker aborts the attempt at 20 s, early. The database recovers
    // it at 45.2 s, after its deadline, so `finished_at` does not show the early abort.
    const verdict = watchdogVerdict(
      records({ closed: [{ attempt: "t:1", outcome: "lease_expired", finishedAtMs: 45_200 }] }),
      20_000,
    );
    expect(verdict).toMatchObject({ pass: null, earlyRecoveries: 0, undecided: 1 });
  });

  it("fails a recovery before the deadline that the samples show", () => {
    const verdict = watchdogVerdict(
      records({ closed: [{ attempt: "t:1", outcome: "lease_expired", finishedAtMs: 30_000 }] }),
      20_000,
    );
    expect(verdict).toMatchObject({ pass: false, earlyRecoveries: 1 });
  });

  it("cannot decide an attempt with no settlement that is not proven live", () => {
    // Round 2, finding 2: zero history rows prove nothing about an early local abort.
    expect(watchdogVerdict(records(), 20_000).pass).toBeNull();
    // Live at the end, but its last renewal came before the fault.
    expect(
      watchdogVerdict(
        records({
          liveAtEnd: ["t:1"],
          lastSamples: [{ attempt: "t:1", renewalMs: 15_000, deadlineMs: 52_000 }],
        }),
        20_000,
      ).pass,
    ).toBeNull();
  });

  it("passes an attempt that is live and renewed after the fault, or settled by the worker", () => {
    const live = records({
      liveAtEnd: ["t:1"],
      lastSamples: [{ attempt: "t:1", renewalMs: 30_000, deadlineMs: 60_000 }],
    });
    expect(watchdogVerdict(live, 20_000)).toMatchObject({ pass: true, live: 1 });
    const done = records({
      closed: [{ attempt: "t:1", outcome: "succeeded", finishedAtMs: 21_000 }],
    });
    expect(watchdogVerdict(done, 20_000)).toMatchObject({ pass: true, settled: 1 });
  });

  it("does not judge an attempt claimed after the last sample", () => {
    const verdict = watchdogVerdict(
      records({
        claimed: [
          { attempt: "t:1", atMs: 5_000 },
          { attempt: "t:2", atMs: 50_100 },
        ],
        closed: [{ attempt: "t:1", outcome: "succeeded", finishedAtMs: 21_000 }],
      }),
      20_000,
    );
    expect(verdict.pass).toBe(true);
  });
});

describe("latest possible next slot after a fault", () => {
  it("adds one interval to the start of the interrupted round", () => {
    expect(
      latestNextSlot({ faultAtMs: 29_001, interruptedStartMs: 29_000, heartbeatMs: 10_000 }),
    ).toEqual({ latestMs: 39_000, basis: "interrupted round" });
  });

  it("adds one interval to the fault without an interrupted round", () => {
    // A round that the sampler did not see can move the slot past an older observation.
    expect(
      latestNextSlot({ faultAtMs: 25_000, interruptedStartMs: null, heartbeatMs: 10_000 }),
    ).toEqual({ latestMs: 35_000, basis: "fault" });
  });
});

function facts(overrides: Partial<CellFacts> = {}): CellFacts {
  return {
    kind: "held",
    heartbeatMs: 1_000,
    leaseMs: 3_000,
    slots: 4,
    finalUnexpiredActiveTasks: 4,
    lostLeases: 0,
    maxExpiredActiveTasks: 0,
    maxRenewalAgeMs: 980,
    minLeaseMarginMs: 2_020,
    maxListenerConnections: 1,
    maxHeartbeatConnections: 1,
    workerErrors: 0,
    sampleErrors: 0,
    probe: {
      exitedBeforeStopMs: null,
      exitCode: 0,
      killed: false,
      stopMs: 40,
      killDeadlineMs: 15_250,
      errorsAfterStop: 0,
    },
    ...overrides,
  };
}

const refillValues = {
  tasks: 40,
  completedOnce: 40,
  remainingActive: 0,
  remainingReady: 0,
  pollMs: 1_000,
  certainGapMs: 120,
  possibleGapMs: 120,
};

/** A fault at 20 s, a replacement ready between 20.01 s and 20.02 s, and claims at once. */
const faultValues: NonNullable<CellFacts["fault"]> = {
  terminated: 1,
  faultAtMs: 20_000,
  claims: [
    { atMs: 20_500, worker: "a", acquiredMs: 20_499 },
    { atMs: 21_000, worker: "b", acquiredMs: 20_999 },
  ],
  inFlightEndedMs: 20_002,
  readyNotBeforeMs: 20_010,
  replacementRoundMs: 20_020,
  observationEndMs: 50_000,
  nextRound: { latestMs: 30_000 },
  demand: [{ fromMs: 20_000, toMs: 50_000 }],
  attempts: {
    claimed: [{ attempt: "t:1", atMs: 20_500 }],
    closed: [{ attempt: "t:1", outcome: "succeeded", finishedAtMs: 21_500 }],
    lastSamples: [{ attempt: "t:1", renewalMs: 20_500, deadlineMs: 50_500 }],
    liveAtEnd: [],
    observedUntilMs: 50_000,
  },
  maxListenerAfterRecovery: 1,
  maxHeartbeatAfterRecovery: 1,
};

/** A fault cell at the default timing, I = 10 s and L = 30 s. */
function faultFacts(overrides: Partial<CellFacts>, values: Partial<typeof faultValues> = {}) {
  return facts({
    kind: "fault",
    heartbeatMs: 10_000,
    leaseMs: 30_000,
    fault: { ...faultValues, ...values },
    ...overrides,
  });
}

/**
 * A fault at 29.001 s that interrupts a round started at 29 s, a replacement ready by 29.02 s, and
 * one fresh claim. The slot bound comes from `latestNextSlot`.
 */
function afterInterruptedRetry(claimMs: number, demand: { fromMs: number; toMs: number }[]) {
  return cellResult(
    faultFacts(
      {},
      {
        faultAtMs: 29_001,
        readyNotBeforeMs: 29_010,
        replacementRoundMs: 29_020,
        claims: [{ atMs: claimMs, worker: "a", acquiredMs: claimMs - 1 }],
        demand,
        nextRound: latestNextSlot({
          faultAtMs: 29_001,
          interruptedStartMs: 29_000,
          heartbeatMs: 10_000,
        }),
      },
    ),
  );
}

function refillWithGaps(certainGapMs: number, possibleGapMs = certainGapMs) {
  return cellResult(
    facts({ kind: "refill", refill: { ...refillValues, certainGapMs, possibleGapMs } }),
  );
}

describe("cell results", () => {
  it("passes a healthy held-task cell", () => {
    expect(cellResult(facts())).toMatchObject({ outcome: "pass", pass: true, failed: [] });
  });

  it("fails a held-task cell on its renewal age, its roles, and a SIGKILL", () => {
    const result = cellResult(
      facts({
        maxRenewalAgeMs: 2_000,
        maxHeartbeatConnections: "unknown",
        probe: { ...facts().probe, killed: true, exitCode: null, stopMs: 15_250 },
      }),
    );
    expect(result.failed).toEqual(["renewal age and margin", "reserved backends", "shutdown"]);
  });

  it("applies the age and margin limits as strict bounds", () => {
    expect(cellResult(facts({ maxRenewalAgeMs: 1_999.9, minLeaseMarginMs: 1_000.1 })).pass).toBe(
      true,
    );
    expect(cellResult(facts({ maxRenewalAgeMs: 2_000 })).failed).toEqual([
      "renewal age and margin",
    ]);
    expect(cellResult(facts({ minLeaseMarginMs: 1_000 })).failed).toEqual([
      "renewal age and margin",
    ]);
  });

  it("fails a held-task cell with an expired active task and no recorded loss", () => {
    expect(cellResult(facts({ maxExpiredActiveTasks: 3 })).failed).toEqual(["live leases"]);
  });

  it("fails a stop that ended with an incomplete shutdown", () => {
    const result = cellResult(facts({ probe: { ...facts().probe, errorsAfterStop: 1 } }));
    expect(result.failed).toEqual(["shutdown"]);
  });

  it("passes a refill cell without the held-task lease rules", () => {
    const result = cellResult(
      facts({
        kind: "refill",
        finalUnexpiredActiveTasks: 0,
        maxRenewalAgeMs: null,
        refill: refillValues,
      }),
    );
    expect(result).toMatchObject({ pass: true, failed: [] });
  });

  it("allows a claim gap of exactly 5 s", () => {
    expect(refillWithGaps(5_000).pass).toBe(true);
    expect(refillWithGaps(5_000.1).failed).toEqual(["claim gap"]);
  });

  it("cannot decide a refill gap while the readiness is unknown", () => {
    // Finding 5: the long gap fell in a time without an observed heartbeat role.
    const result = refillWithGaps(1_000, 7_000);
    expect(result).toMatchObject({ outcome: "inconclusive", inconclusive: ["claim gap"] });
  });

  it("fails a refill cell on a long claim gap, a default poll, and a second attempt", () => {
    const result = cellResult(
      facts({
        kind: "refill",
        refill: { ...refillValues, completedOnce: 39, pollMs: null, certainGapMs: 5_001 },
      }),
    );
    expect(result.failed).toEqual(["complete once", "claim gap"]);
  });

  it("passes a fault cell with a short outage and no lost lease", () => {
    expect(cellResult(faultFacts({}))).toMatchObject({ outcome: "pass", failed: [] });
  });

  it("fails a fresh claim in the first 100 ms of a short outage", () => {
    // Finding 1: the replacement is in use until 20.04 s and runs its first round at 20.05 s. A
    // claim function starts at 20.02 s, after the statements of the fault time ended.
    const result = cellResult(
      faultFacts(
        {},
        {
          claims: [{ atMs: 20_025, worker: "a", acquiredMs: 20_020 }, ...faultValues.claims],
          readyNotBeforeMs: 20_040,
          replacementRoundMs: 20_050,
        },
      ),
    );
    expect(result.failed).toEqual(["no claim in outage"]);
  });

  it("cannot decide a claim from a statement that ran at the fault", () => {
    // Finding 1: a statement that ran at the fault ended at 20.03 s. Its claim function can have
    // started after the fault, so the claim at 20.015 s cannot be attributed.
    const result = cellResult(
      faultFacts(
        {},
        {
          claims: [{ atMs: 20_015, worker: "a", acquiredMs: 20_012 }, ...faultValues.claims],
          inFlightEndedMs: 20_030,
        },
      ),
    );
    expect(result).toMatchObject({ outcome: "inconclusive", inconclusive: ["no claim in outage"] });
  });

  it("does not count a claim whose claim function started before the fault", () => {
    const result = cellResult(
      faultFacts(
        {},
        { claims: [{ atMs: 20_003, worker: "a", acquiredMs: 19_999 }, ...faultValues.claims] },
      ),
    );
    expect(result.outcome).toBe("pass");
  });

  it("fails a fault cell on a late first claim", () => {
    const result = cellResult(
      faultFacts({}, { claims: [{ atMs: 40_001, worker: "a", acquiredMs: 40_000 }], demand: [] }),
    );
    expect(result.failed).toEqual(["claim after recovery"]);
  });

  it("does not detect a delayed dispatch that the latest slot cannot show", () => {
    // Round 4: the validator's two examples. The regular round at 20 s is missed, or a busy retry
    // at 24 s is missed. Either way the fault interrupts a busy retry at 29 s, and the claim at
    // 30.5 s comes after the real slot of 30 s. The latest possible slot is 39 s.
    const result = afterInterruptedRetry(30_500, [{ fromMs: 29_050, toMs: 60_000 }]);
    expect(result).toMatchObject({ outcome: "pass", failed: [], inconclusive: [] });
    expect(result.rules).toContainEqual(
      expect.objectContaining({ rule: "dispatch before next round", detected: "notDetected" }),
    );
  });

  it("fails a claim after the latest possible slot with a free slot before it", () => {
    const result = afterInterruptedRetry(39_500, [{ fromMs: 29_050, toMs: 60_000 }]);
    expect(result).toMatchObject({ outcome: "fail", failed: ["dispatch before next round"] });
    expect(result.rules).toContainEqual(
      expect.objectContaining({ rule: "dispatch before next round", detected: "violated" }),
    );
  });

  it("compares claims with the latest possible slot at full precision", () => {
    // Round 5: the round starts at 20,000.04 ms, so the latest possible slot is 30,000.04 ms. A
    // claim at 30,000.02 ms is on time; one at 30,000.06 ms is not.
    const nextRound = latestNextSlot({
      faultAtMs: 20_000.05,
      interruptedStartMs: 20_000.04,
      heartbeatMs: 10_000,
    });
    expect(nextRound.latestMs).toBeCloseTo(30_000.04, 6);
    const detected = (claimMs: number) =>
      cellResult(
        faultFacts(
          {},
          {
            faultAtMs: 20_000.05,
            readyNotBeforeMs: 20_010,
            replacementRoundMs: 20_020,
            claims: [{ atMs: claimMs, worker: "a", acquiredMs: claimMs - 0.005 }],
            demand: [{ fromMs: 20_100, toMs: 60_000 }],
            nextRound,
          },
        ),
      ).rules.find((entry) => entry.rule === "dispatch before next round");
    expect(detected(30_000.02)).toMatchObject({ detected: "notDetected" });
    expect(detected(30_000.06)).toMatchObject({ detected: "violated" });
  });

  it("does not detect a violation without a free slot before the latest possible slot", () => {
    const result = afterInterruptedRetry(39_500, [{ fromMs: 38_800, toMs: 60_000 }]);
    expect(result.outcome).toBe("pass");
  });

  it("does not pass a lost lease from its database recovery time", () => {
    // Round 2, finding 2: the database recovered the attempt after its deadline. The local
    // watchdog time is not known.
    const result = cellResult(
      faultFacts(
        { lostLeases: 1 },
        {
          attempts: records({
            closed: [{ attempt: "t:1", outcome: "lease_expired", finishedAtMs: 45_200 }],
          }),
        },
      ),
    );
    expect(result).toMatchObject({
      outcome: "inconclusive",
      inconclusive: ["lease loss in watchdog bound"],
    });
  });

  it("fails a recovery before the sampled deadline", () => {
    const result = cellResult(
      faultFacts(
        { lostLeases: 1 },
        {
          attempts: records({
            closed: [{ attempt: "t:1", outcome: "lease_expired", finishedAtMs: 30_000 }],
          }),
        },
      ),
    );
    expect(result.failed).toContain("lease loss in watchdog bound");
  });

  it("fails a fault cell that ended no heartbeat connection", () => {
    const result = cellResult(faultFacts({}, { terminated: 0 }));
    expect(result.failed).toEqual(["no claim in outage"]);
  });

  it("fails a fault cell with a failed driver query", () => {
    expect(cellResult(faultFacts({ sampleErrors: 1 })).failed).toEqual(["no sample errors"]);
  });
});
