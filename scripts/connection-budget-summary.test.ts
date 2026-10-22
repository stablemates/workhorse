import { describe, expect, it } from "vitest";
import { cellResult } from "./connection-budget-roles.js";
import { type FullArtifact, summarizeArtifact } from "./connection-budget-summary.js";

const source = { name: "sm1574/go.json", sha256: "0".repeat(64) };
const spread = (max: number) => ({ min: max, p50: max, max });

/** One held-task cell of two workers, with the fields that a schema 3 or 4 artifact stores. */
function heldRun(
  schemaVersion: 3 | 4,
  overrides: { killed?: boolean; workerErrors?: number } = {},
) {
  const killed = overrides.killed ?? false;
  const workerErrors = overrides.workerErrors ?? 0;
  const probe =
    schemaVersion === 4
      ? {
          exitedBeforeStopMs: null,
          exitCode: killed ? null : 0,
          signal: killed ? "SIGKILL" : null,
          shutdownGraceMs: 10_000,
          killDeadlineMs: 17_250,
          killedAtDeadline: killed,
          stopMs: killed ? 17_250 : 6,
          workerErrors,
          errorsAfterStop: 0,
          started: { event: "started", pollMs: null },
          waitedAcquires: 7,
        }
      : {
          exitedBeforeStopMs: null,
          exitCode: killed ? null : 0,
          signal: killed ? "SIGKILL" : null,
          killedAfterGrace: killed,
          stopMs: killed ? 20_000 : 9,
          events: [
            { event: "started" },
            ...Array.from({ length: workerErrors }, () => ({ event: "worker_error" })),
            { event: "stopped" },
          ],
          waitedAcquires: 11,
        };
  return {
    sdk: "go",
    cell: {
      id: "starvation-w2-c1-p4",
      ...(schemaVersion === 4 ? { kind: "held" as const } : {}),
      workers: 2,
      concurrency: 1,
      poolSize: 4,
      heartbeatMs: 1000,
      leaseMs: 3000,
      warmupMs: 10_000,
      measureMs: 30_000,
    },
    startedAt: "2026-10-21T21:53:31.000Z",
    guardWait: { waitedMs: 0, busyPolls: [] },
    machineBefore: { at: "x", loadAverage: [1.5, 1, 1], availableMemoryBytes: 80e9 },
    machineAfter: { at: "y", loadAverage: [1.2, 1, 1], availableMemoryBytes: 80e9 },
    outcome: {
      expectedSlots: 2,
      enqueuedTasks: 4,
      finalUnexpiredActiveTasks: 2,
      minUnexpiredActiveTasksInWindow: 2,
      finalClaimEvents: 2,
      lostLeases: 0,
      maxExpiredActiveTasks: 0,
      renewalAgeMs: { samples: 240, max: 973.8, p50: 477.5, p95: 970, p99: 972 },
      minLeaseMarginMs: 2026.2,
      connectionRoles: {
        listenerConnections: spread(1),
        observedHeartbeatRoleConnections: spread(1),
        peakHeartbeatBackendsInOneInterval: 1,
        heartbeatObservationIncomplete: false,
        errors: [],
        events: [{ atMs: 1021.6, pid: 1, event: "heartbeat-start" }],
        heartbeatCoverage: [{ pid: 1, roundsObserved: 40 }],
        backends: [{ pid: 1, rounds: [{ atMs: 1021.6 }] }],
      },
      roleSamplerError: null,
      maxConnections: { total: 4 },
      poolState: { checkedOut: spread(2), waitingMax: 0, outOfPoolSessions: spread(0) },
      sampleErrors: 0,
      finalErrors: [],
      ...(schemaVersion === 4 ? { refill: null, fault: null } : {}),
      leftoverProbeSessionsAfter: [],
      probe,
    },
    series: { columns: ["elapsedMs"], rows: [[0], [250]] },
    poolSeries: { columns: ["elapsedMs"], rows: [[0]] },
  };
}

function artifact(schemaVersion: 3 | 4, runs: ReturnType<typeof heldRun>[]): FullArtifact {
  return {
    benchmark: "connection-budget",
    schemaVersion,
    recordedAt: "2026-10-21T22:13:26.000Z",
    profile: "full",
    aborted: null,
    environment: { postgresVersion: "18.6" },
    provenance: { source: { commit: "b4e86d58", dirty: false }, runtime: { logicalCpuCount: 32 } },
    sdkVersions: { go: "0.9.0" },
    toolchains: { go: ["go version go1.26.10 linux/amd64"] },
    settings: {
      ...(schemaVersion === 3 ? { stopGraceMs: 20_000 } : { shutdownGraceMs: 10_000 }),
      matrix: runs.map((run) => run.cell),
    },
    wallTimeMs: 1,
    runs,
  } as unknown as FullArtifact;
}

/** A schema 4 artifact whose stored results and summary come from the summary of its own runs. */
function storedArtifact(runs: ReturnType<typeof heldRun>[]): FullArtifact {
  const unstored = summarizeArtifact(artifact(4, runs), source);
  const stored = artifact(4, runs);
  stored.runs.forEach((run, index) => {
    run.result = {
      ...unstored.runs[index]!.result,
      pass: unstored.runs[index]!.result.outcome === "pass",
    };
  });
  stored.summary = unstored.summary;
  return stored;
}

describe("connection budget summary", () => {
  it("keeps the stored results and rows of a schema 4 artifact when the rules agree", () => {
    const full = storedArtifact([heldRun(4)]);
    const summary = summarizeArtifact(full, source);

    expect(summary.summaryOf).toMatchObject({ source: source.name, sha256: source.sha256 });
    expect(summary.provenance).toMatchObject({ commit: "b4e86d58", dirty: false });
    expect(summary.runs[0]!.result.outcome).toBe("pass");
    expect(summary.runs[0]!.result.rules.map((rule) => rule.rule)).toEqual([
      "live leases",
      "renewal age and margin",
      "reserved backends",
      "no errors",
      "shutdown",
    ]);
    expect(summary.summary.rows).toEqual(full.summary!.rows);
    expect(summary.runs[0]!.metrics).toMatchObject({
      finalUnexpiredActiveTasks: 2,
      expectedSlots: 2,
      maxRenewalAgeMs: 973.8,
      minLeaseMarginMs: 2026.2,
      maxListenerConnections: 1,
      maxObservedHeartbeatRoleConnections: 1,
      probe: { stopMs: 6, sigkill: false, killDeadlineMs: 17_250 },
    });
    expect(summary.runs[0]!.machineBefore).toEqual({
      loadAverage: [1.5, 1, 1],
      availableMemoryBytes: 80e9,
    });
    expect(summary.settings["matrix"]).toEqual(["starvation-w2-c1-p4"]);
  });

  it("drops the sample series and the per-round coverage", () => {
    const text = JSON.stringify(summarizeArtifact(storedArtifact([heldRun(4)]), source));

    for (const key of ["series", "poolSeries", "heartbeatCoverage", "backends", "rounds"]) {
      expect(text).not.toContain(`"${key}"`);
    }
  });

  it("refuses a schema 4 artifact whose stored result differs from the rules", () => {
    const full = storedArtifact([heldRun(4)]);
    full.runs[0]!.result!.outcome = "fail";

    expect(() => summarizeArtifact(full, source)).toThrow(/another result than the stored one/);
  });

  it("refuses a schema 4 artifact whose stored summary row differs", () => {
    const full = storedArtifact([heldRun(4)]);
    full.summary!.rows[0]![15] = 7;

    expect(() => summarizeArtifact(full, source)).toThrow(/differ from the stored driver summary/);
  });

  it("computes the results of a schema 3 artifact with its stop grace as the kill deadline", () => {
    const summary = summarizeArtifact(
      artifact(3, [heldRun(3), heldRun(3, { workerErrors: 2 }), heldRun(3, { killed: true })]),
      source,
    );

    expect(summary.runs.map((run) => run.result.outcome)).toEqual(["pass", "fail", "fail"]);
    expect(summary.runs[1]!.result.failed).toEqual(["no errors"]);
    expect(summary.runs[1]!.metrics.workerErrors).toBe(2);
    expect(summary.runs[2]!.result.failed).toEqual(["shutdown"]);
    expect(summary.runs[2]!.metrics.probe).toMatchObject({ sigkill: true, killDeadlineMs: 20_000 });
    expect(summary.summaryOf.results).toMatch(/^Computed by the summary/);
    expect(summary.summary.rows[2]!.at(-1)).toBe("yes");
  });

  it("gives a schema 3 cell the result that cellResult gives for its facts", () => {
    const summary = summarizeArtifact(artifact(3, [heldRun(3)]), source);
    const expected = cellResult({
      kind: "held",
      heartbeatMs: 1000,
      leaseMs: 3000,
      slots: 2,
      finalUnexpiredActiveTasks: 2,
      lostLeases: 0,
      maxExpiredActiveTasks: 0,
      maxRenewalAgeMs: 973.8,
      minLeaseMarginMs: 2026.2,
      maxListenerConnections: 1,
      maxHeartbeatConnections: 1,
      workerErrors: 0,
      sampleErrors: 0,
      probe: {
        exitedBeforeStopMs: null,
        exitCode: 0,
        killed: false,
        stopMs: 9,
        killDeadlineMs: 20_000,
        errorsAfterStop: 0,
      },
    });

    expect(summary.runs[0]!.result.rules).toEqual(expected.rules);
  });
});
