#!/usr/bin/env node
/**
 * Turns one full artifact of the connection budget benchmark into a summary of a few kilobytes.
 * The repository keeps the summary and the verdicts, and the Linear issue of the run keeps the full
 * artifact with its sample series (SM-1574).
 *
 * A schema 4 artifact has a result for each cell. The summary rebuilds the facts of each cell,
 * applies the rules of `cellResult` again, and refuses to write when a result or a row of the
 * driver summary differs from the stored one. A schema 3 artifact has no results, so the summary
 * computes them with the same rules and the kill deadline that the run used.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { type CellFacts, type CellKind, cellResult, round } from "./connection-budget-roles.js";

const help = `Connection budget summary

Writes the summary of one full connection budget artifact.

Usage:
  pnpm benchmark:connection-budget:summary -- <artifact.json> <summary.json> [--source NAME]

Options:
  --source NAME  The name of the full artifact in the Linear attachment
                 (default: <directory>/<file> of the artifact)
  --help         Show this help`;

type Spread = { min: number; p50: number; max: number } | "unknown";

interface Roles {
  listenerConnections: Spread;
  observedHeartbeatRoleConnections: Spread;
  formerHeartbeatConnections?: Spread;
  statementConnections?: Spread;
  peakHeartbeatBackendsInOneInterval?: number;
  peakMarkerBackendsInOneInterval?: number;
  listenerPids?: number;
  heartbeatPids?: number;
  statementPids?: number;
  heartbeatStarts?: number;
  heartbeatEnds?: number;
  heartbeatObservationIncomplete?: boolean;
  markerRounds?: number;
  commitInferredRounds?: number;
  unconfirmedCommitRounds?: number;
  errors?: unknown[];
  events?: unknown[];
}

interface Gap {
  lengthMs: number;
  startMs: number | null;
  endMs: number | null;
  worker: string | null;
}

interface Refill {
  tasks: number;
  completedOnce: number;
  completed?: number;
  completedMoreThanOnce?: number;
  neverClaimed?: number;
  tasksWithMoreThanOneAttempt?: number;
  tasksWithMoreThanOneClaim?: number;
  remainingActive: number | null;
  remainingReady: number | null;
  certainGap: Gap;
  possibleGap: Gap;
  perTask?: unknown;
}

interface Fault {
  atMs: number | null;
  inRound: { pid: number; state: string } | null;
  roleBackends: unknown[];
  roleBackendsEndedMs: number | null;
  inFlightEndedMs: number | null;
  replacement: { pid: number; firstRoundMs: number; readyNotBeforeMs: number } | null;
  freshClaimsMs: number[];
  unattributedClaimsMs: number[];
  claimsFromStatementsBeforeFault: number;
  nextRound: unknown;
  watchdog: unknown;
  recoveries: unknown[];
  firstClaimAfterReplacementRoundMs: number | null;
  lastRoundBeforeFaultMs: number | null;
  searchTimedOut: boolean;
  error: unknown;
  facts: NonNullable<CellFacts["fault"]>;
}

interface Probe {
  exitedBeforeStopMs: number | null;
  exitCode: number | null;
  signal: string | null;
  stopMs: number | null;
  /** Schema 4. */
  killedAtDeadline?: boolean;
  killDeadlineMs?: number;
  shutdownGraceMs?: number;
  workerErrors?: number;
  errorsAfterStop?: number;
  started?: { pollMs?: number | null } | null;
  /** Schema 3. */
  killedAfterGrace?: boolean;
  events?: { event: string }[];
  waitedAcquires?: number | null;
}

interface Outcome {
  expectedSlots: number;
  enqueuedTasks: number;
  finalUnexpiredActiveTasks: number | null;
  maxUnexpiredActiveTasks?: number | null;
  minUnexpiredActiveTasksInWindow?: number | null;
  finalClaimEvents: number | null;
  finalClaimedTasks?: number | null;
  firstClaimMs?: number | null;
  fullOccupancyMs?: number | null;
  initialCapacityFailure?: boolean;
  longestClaimGapMs?: number | null;
  progressFailure?: boolean;
  lostLeases: number | null;
  leaseExpiredEvents?: number | null;
  otherClosedAttempts?: number | null;
  maxAttempt?: number | null;
  maxExpiredActiveTasks: number | null;
  renewalAgeMs: {
    samples: number;
    max: number | null;
    p50: number | null;
    p95: number | null;
    p99: number | null;
  };
  minLeaseMarginMs: number | null;
  connectionRoles: Roles | null;
  roleSamplerError: unknown;
  poolState?: unknown;
  maxConnections?: unknown;
  sampleErrors: number;
  finalErrors: unknown[];
  refill?: Refill | null;
  fault?: Fault | null;
  strayProbeSessionsBefore?: unknown[];
  leftoverProbeSessionsAfter?: unknown[];
  probe: Probe;
}

interface Cell {
  id: string;
  kind?: CellKind;
  workers: number;
  concurrency: number;
  poolSize: number;
  heartbeatMs: number;
  leaseMs: number;
}

type Result = ReturnType<typeof cellResult>;

interface Run {
  sdk: string;
  cell: Cell;
  startedAt: string;
  guardWait: { waitedMs: number };
  machineBefore: unknown;
  machineAfter: unknown;
  outcome: Outcome;
  result?: Result;
}

/** The parts of a full artifact that the summary reads. */
export interface FullArtifact {
  benchmark: string;
  schemaVersion: number;
  recordedAt: string;
  profile: string;
  aborted: string | null;
  environment: unknown;
  provenance: { source: { commit: string | null; dirty: boolean | null }; runtime?: unknown };
  sdkVersions: unknown;
  toolchains: unknown;
  settings: { stopGraceMs?: number } & Record<string, unknown>;
  wallTimeMs: number;
  summary?: { columns: string[]; rows: (string | number | null)[][] };
  runs: Run[];
}

const summaryColumns = [
  "sdk",
  "cell",
  "kind",
  "result",
  "failedRules",
  "tasks",
  "lostLeases",
  "expiredActiveTasks",
  "maxRenewalAgeMs",
  "minLeaseMarginMs",
  "claimGapMs",
  "outageClaims",
  "firstFreshClaimMs",
  "listeners",
  "heartbeatRole",
  "stopMs",
  "sigkill",
];

const kindOf = (run: Run): CellKind => run.cell.kind ?? "held";
const killedOf = (probe: Probe): boolean =>
  probe.killedAtDeadline ?? probe.killedAfterGrace ?? false;
const count = (list: unknown[] | undefined | null): number => list?.length ?? 0;

function maxOf(spread: Spread | undefined): number | "unknown" | null {
  if (spread === undefined) return null;
  return typeof spread === "string" ? "unknown" : spread.max;
}

/**
 * The facts that `cellResult` reads, from a stored cell. Schema 3 records no kill deadline and no
 * error count after SIGTERM: the deadline is the stop grace of the run, and the count is 0.
 */
function cellFacts(run: Run, schemaVersion: number, stopGraceMs: number | undefined): CellFacts {
  const { outcome, cell } = run;
  const { probe } = outcome;
  const roles = outcome.connectionRoles;
  const heartbeat = maxOf(roles?.observedHeartbeatRoleConnections);
  const listener = maxOf(roles?.listenerConnections);
  const workerErrors =
    probe.workerErrors ??
    (probe.events ?? []).filter((entry) => entry.event === "worker_error").length;
  const killDeadlineMs = probe.killDeadlineMs ?? stopGraceMs;
  if (killDeadlineMs === undefined) throw new Error(`${run.sdk} ${cell.id}: no kill deadline`);
  if (schemaVersion >= 4 && probe.errorsAfterStop === undefined) {
    throw new Error(
      `${run.sdk} ${cell.id}: no errorsAfterStop in a schema ${schemaVersion} artifact`,
    );
  }
  const refill = outcome.refill ?? null;
  const fault = outcome.fault ?? null;
  return {
    kind: kindOf(run),
    heartbeatMs: cell.heartbeatMs,
    leaseMs: cell.leaseMs,
    slots: outcome.expectedSlots,
    finalUnexpiredActiveTasks: outcome.finalUnexpiredActiveTasks,
    lostLeases: outcome.lostLeases,
    maxExpiredActiveTasks: outcome.maxExpiredActiveTasks,
    maxRenewalAgeMs: outcome.renewalAgeMs.max,
    minLeaseMarginMs: outcome.minLeaseMarginMs,
    maxListenerConnections: listener === "unknown" ? null : listener,
    maxHeartbeatConnections: heartbeat,
    workerErrors,
    sampleErrors:
      outcome.sampleErrors +
      count(outcome.finalErrors) +
      (outcome.roleSamplerError === null || outcome.roleSamplerError === undefined ? 0 : 1) +
      count(roles?.errors) +
      (fault?.error ? 1 : 0),
    probe: {
      exitedBeforeStopMs: probe.exitedBeforeStopMs,
      exitCode: probe.exitCode,
      killed: killedOf(probe),
      stopMs: probe.stopMs,
      killDeadlineMs,
      errorsAfterStop: probe.errorsAfterStop ?? 0,
    },
    ...(refill === null
      ? {}
      : {
          refill: {
            tasks: refill.tasks,
            completedOnce: refill.completedOnce,
            remainingActive: refill.remainingActive,
            remainingReady: refill.remainingReady,
            pollMs: probe.started?.pollMs ?? null,
            certainGapMs: refill.certainGap.lengthMs,
            possibleGapMs: refill.possibleGap.lengthMs,
          },
        }),
    ...(fault === null ? {} : { fault: fault.facts }),
  };
}

/** One row of the driver summary table, as `summaryRow` in the driver writes it. */
function summaryRow(run: Run, result: Result): (string | number | null)[] {
  const { outcome } = run;
  const kind = kindOf(run);
  const roles = outcome.connectionRoles;
  const heartbeat = roles?.observedHeartbeatRoleConnections;
  const fault = outcome.fault ?? null;
  const refill = outcome.refill ?? null;
  const roundMs = fault?.replacement?.firstRoundMs ?? Number.POSITIVE_INFINITY;
  const outageFresh = fault?.freshClaimsMs.filter((atMs) => atMs < roundMs).length ?? 0;
  const outageUnattributed =
    fault?.unattributedClaimsMs.filter((atMs) => atMs < roundMs).length ?? 0;
  const tasks =
    kind === "refill"
      ? `${refill?.completedOnce}/${refill?.tasks} once`
      : kind === "held"
        ? `${outcome.finalUnexpiredActiveTasks}/${outcome.expectedSlots} live`
        : `${outcome.finalClaimEvents} claims`;
  const row: Record<string, string | number | null> = {
    sdk: run.sdk,
    cell: run.cell.id,
    kind,
    result: result.outcome === "fail" ? "FAIL" : result.outcome,
    failedRules:
      [...result.failed, ...result.inconclusive.map((rule) => `${rule}?`)].join("; ") || "-",
    tasks,
    lostLeases: outcome.lostLeases,
    expiredActiveTasks: outcome.maxExpiredActiveTasks,
    maxRenewalAgeMs: outcome.renewalAgeMs.max,
    minLeaseMarginMs: outcome.minLeaseMarginMs,
    claimGapMs:
      refill === null ? null : `${refill.certainGap.lengthMs}/${refill.possibleGap.lengthMs}`,
    outageClaims: fault === null ? null : `${outageFresh}/${outageUnattributed}`,
    firstFreshClaimMs:
      fault === null || fault.atMs === null || fault.freshClaimsMs[0] === undefined
        ? null
        : round(fault.freshClaimsMs[0] - fault.atMs),
    listeners: maxOf(roles?.listenerConnections),
    heartbeatRole: heartbeat === undefined ? null : maxOf(heartbeat),
    stopMs: outcome.probe.stopMs,
    sigkill: killedOf(outcome.probe) ? "yes" : "no",
  };
  return summaryColumns.map((column) => row[column] ?? null);
}

/** The claims in `list` that came before `limitMs`. */
const before = (list: number[], limitMs: number) => list.filter((atMs) => atMs < limitMs).length;

/** The values of one fault cell that the analysis reads, without the claim lists. */
function faultSummary(fault: Fault) {
  const lowerMs = fault.replacement?.readyNotBeforeMs ?? Number.POSITIVE_INFINITY;
  const roundMs = fault.replacement?.firstRoundMs ?? Number.POSITIVE_INFINITY;
  return {
    atMs: round(fault.atMs),
    interruptedRound: fault.inRound !== null,
    roleBackendsEnded: fault.roleBackends.length,
    roleBackendsEndedMs: fault.roleBackendsEndedMs,
    inFlightEndedMs: fault.inFlightEndedMs,
    replacement:
      fault.replacement === null
        ? null
        : {
            readyNotBeforeMs: round(fault.replacement.readyNotBeforeMs),
            firstRoundMs: round(fault.replacement.firstRoundMs),
          },
    freshClaims: fault.freshClaimsMs.length,
    firstFreshClaimMs: round(fault.freshClaimsMs[0] ?? null),
    unattributedClaims: fault.unattributedClaimsMs.length,
    freshClaimsBeforeReadyLowerBound: before(fault.freshClaimsMs, lowerMs),
    freshClaimsBeforeFirstRound: before(fault.freshClaimsMs, roundMs),
    unattributedClaimsBeforeFirstRound: before(fault.unattributedClaimsMs, roundMs),
    claimsFromStatementsBeforeFault: fault.claimsFromStatementsBeforeFault,
    nextRound: fault.nextRound,
    watchdog: fault.watchdog,
    recoveredAttempts: fault.recoveries.length,
    firstClaimAfterReplacementRoundMs: fault.firstClaimAfterReplacementRoundMs,
    lastRoundBeforeFaultMs: fault.lastRoundBeforeFaultMs,
    searchTimedOut: fault.searchTimedOut,
    error: fault.error,
  };
}

/** The highest value of a field of the pool state, or null when the artifact has none. */
function poolMax(pool: unknown, key: string): number | null {
  const entry = (pool as Record<string, unknown> | null | undefined)?.[key];
  if (typeof entry === "number") return entry;
  const max = (entry as { max?: unknown } | null | undefined)?.max;
  return typeof max === "number" ? max : null;
}

function machine(reading: unknown) {
  const { loadAverage, availableMemoryBytes } = reading as {
    loadAverage: number[];
    availableMemoryBytes: number;
  };
  return { loadAverage, availableMemoryBytes };
}

const gap = ({ lengthMs, startMs, endMs }: Gap) => ({
  lengthMs,
  startMs: round(startMs),
  endMs: round(endMs),
});

function runSummary(run: Run, result: Result, facts: CellFacts) {
  const { outcome } = run;
  const roles = outcome.connectionRoles;
  const refill = outcome.refill ?? null;
  const fault = outcome.fault ?? null;
  return {
    sdk: run.sdk,
    cell: run.cell,
    startedAt: run.startedAt,
    guardWaitMs: run.guardWait.waitedMs,
    machineBefore: machine(run.machineBefore),
    machineAfter: machine(run.machineAfter),
    result: {
      outcome: result.outcome,
      failed: result.failed,
      inconclusive: result.inconclusive,
      rules: result.rules,
    },
    metrics: {
      expectedSlots: outcome.expectedSlots,
      enqueuedTasks: outcome.enqueuedTasks,
      finalUnexpiredActiveTasks: outcome.finalUnexpiredActiveTasks,
      minUnexpiredActiveTasksInWindow: outcome.minUnexpiredActiveTasksInWindow ?? null,
      finalClaimEvents: outcome.finalClaimEvents,
      lostLeases: outcome.lostLeases,
      maxExpiredActiveTasks: outcome.maxExpiredActiveTasks,
      maxRenewalAgeMs: outcome.renewalAgeMs.max,
      minLeaseMarginMs: outcome.minLeaseMarginMs,
      maxListenerConnections: maxOf(roles?.listenerConnections),
      maxObservedHeartbeatRoleConnections: maxOf(roles?.observedHeartbeatRoleConnections),
      peakHeartbeatBackendsInOneInterval: roles?.peakHeartbeatBackendsInOneInterval ?? null,
      heartbeatEvents: roles?.events ?? null,
      heartbeatObservationIncomplete: roles?.heartbeatObservationIncomplete ?? null,
      maxSessions: poolMax(outcome.maxConnections, "total"),
      maxPoolCheckedOut: poolMax(outcome.poolState, "checkedOut"),
      maxPoolWaiting: poolMax(outcome.poolState, "waitingMax"),
      maxOutOfPoolSessions: poolMax(outcome.poolState, "outOfPoolSessions"),
      workerErrors: facts.workerErrors,
      sampleErrors: facts.sampleErrors,
      leftoverProbeSessionsAfter: count(outcome.leftoverProbeSessionsAfter),
      probe: {
        exitCode: outcome.probe.exitCode,
        stopMs: outcome.probe.stopMs,
        sigkill: facts.probe.killed,
        killDeadlineMs: facts.probe.killDeadlineMs,
        errorsAfterStop: outcome.probe.errorsAfterStop ?? null,
        pollMs: outcome.probe.started?.pollMs ?? null,
      },
      refill:
        refill === null
          ? null
          : {
              tasks: refill.tasks,
              completedOnce: refill.completedOnce,
              remainingActive: refill.remainingActive,
              remainingReady: refill.remainingReady,
              certainGap: gap(refill.certainGap),
              possibleGap: gap(refill.possibleGap),
            },
      fault: fault === null ? null : faultSummary(fault),
    },
  };
}

/**
 * The summary of `artifact`. `source` names the full artifact and gives the sha256 of its bytes,
 * so a reader can find it in the Linear attachment and check it.
 */
export function summarizeArtifact(
  artifact: FullArtifact,
  source: { name: string; sha256: string },
) {
  if (artifact.benchmark !== "connection-budget")
    throw new Error("not a connection budget artifact");
  const computed = artifact.runs.map((run) => {
    const facts = cellFacts(run, artifact.schemaVersion, artifact.settings.stopGraceMs);
    const result = cellResult(facts);
    if (run.result !== undefined && !isDeepStrictEqual(result, run.result)) {
      throw new Error(
        `${run.sdk} ${run.cell.id}: the rules give another result than the stored one`,
      );
    }
    return { run, facts, result };
  });
  const rows = computed.map(({ run, result }) => summaryRow(run, result));
  if (artifact.summary !== undefined && !isDeepStrictEqual(rows, artifact.summary.rows)) {
    throw new Error("the summary rows differ from the stored driver summary");
  }
  return {
    benchmark: artifact.benchmark,
    summaryOf: {
      source: source.name,
      sha256: source.sha256,
      schemaVersion: artifact.schemaVersion,
      results: artifact.runs.every((run) => run.result !== undefined)
        ? "Stored by the driver. The summary applied cellResult again and got the same results."
        : "Computed by the summary with cellResult. Schema 3 records no error count after SIGTERM, so the shutdown rule counts 0; every cell with a worker error also fails the rule no errors.",
    },
    recordedAt: artifact.recordedAt,
    profile: artifact.profile,
    aborted: artifact.aborted,
    environment: artifact.environment,
    provenance: {
      commit: artifact.provenance.source.commit,
      dirty: artifact.provenance.source.dirty,
      runtime: artifact.provenance.runtime ?? null,
    },
    sdkVersions: artifact.sdkVersions,
    toolchains: artifact.toolchains,
    // Each run keeps its cell settings, so the matrix lists only the cell ids.
    settings: { ...artifact.settings, matrix: artifact.runs.map((run) => run.cell.id) },
    wallTimeMs: artifact.wallTimeMs,
    summary: { columns: summaryColumns, rows },
    runs: computed.map(({ run, result, facts }) => runSummary(run, result, facts)),
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--help")) {
    console.log(help);
    process.exit(0);
  }
  const sourceName = argument("--source");
  const paths = process.argv
    .slice(2)
    .filter(
      (entry, index, all) =>
        entry !== "--" && entry !== "--source" && all[index - 1] !== "--source",
    );
  const [input, output] = paths;
  if (input === undefined || output === undefined || paths.length !== 2) {
    console.error(help);
    process.exit(2);
  }
  const bytes = readFileSync(input);
  const summary = summarizeArtifact(JSON.parse(bytes.toString("utf8")) as FullArtifact, {
    name: sourceName ?? `${basename(dirname(input))}/${basename(input)}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  writeFileSync(output, `${JSON.stringify(summary)}\n`);
  console.error(`Wrote ${output}`);
}
