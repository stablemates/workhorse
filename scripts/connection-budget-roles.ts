/**
 * The role analysis of the connection budget benchmark (SM-1566). The role sampler in
 * `scripts/benchmark-connection-budget.ts` reads `pg_stat_activity` in the database and returns
 * what each probe backend ran. These functions turn those observations into roles over time. They
 * read no database, so the unit tests replay observations through them.
 */
import { nearestRankPercentile } from "../typescript/core/benchmarks/statistics.js";

/** The interval of the role sampler, and the length of one sampler call. */
export const roleSampleIntervalMs = 2;
export const roleChunkMs = 1_000;
/** The interval of the role series and of the driver samples. */
export const roleSeriesIntervalMs = 250;

export function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

type RunKind = "listen" | "heartbeat" | "statement";
type Role = "listen" | "heartbeat" | "former-heartbeat" | "statement" | "unknown";

interface RoleRun {
  kind: RunKind;
  firstMs: number;
  lastMs: number;
}

interface Closure {
  /** The last sample that saw the backend. */
  lastPresentMs: number;
  /** The first later sample that did not see it. The backend closed between the two. */
  firstAbsentMs: number;
}

interface ObservedBackend {
  pid: number;
  backendStartMs: number;
  firstSeenMs: number;
  lastSeenMs: number;
  closure: Closure | null;
  /** Consecutive samples of one kind. A heartbeat run keeps the runs around it apart. */
  runs: RoleRun[];
  markersMs: number[];
  commitsMs: Set<number>;
}

interface SamplerCall {
  startMs: number;
  durationMs: number;
  iterations: number;
  relationBytes: number;
}

export interface RoleSampling {
  backends: Map<string, ObservedBackend>;
  calls: SamplerCall[];
  errors: string[];
  /** A call failed after the last call that succeeded, so a closure at the end can be unseen. */
  failedAfterLastSuccess: boolean;
  lastIterationMs: number | null;
  /** CPU time of the sampler backend, from `/proc`, when PostgreSQL runs on this host. */
  backendCpuMs: number | null;
  /** Wall-clock time from the first call to the end of the last call. */
  durationMs: number;
}

/** What one call of the sampler function returns. Times are epoch milliseconds. */
export interface RoleChunk {
  iterations: number;
  firstIterationMs: number;
  lastIterationMs: number;
  relationBytes: number;
  backends: {
    pid: number;
    backendStartMs: number;
    firstSeenMs: number;
    lastSeenMs: number;
    firstAbsentMs: number | null;
    markersMs: number[];
    commitsMs: number[];
  }[];
  runs: { pid: number; backendStartMs: number; kind: RunKind; firstMs: number; lastMs: number }[];
}

export function emptyRoleSampling(): RoleSampling {
  return {
    backends: new Map(),
    calls: [],
    errors: [],
    failedAfterLastSuccess: false,
    lastIterationMs: null,
    backendCpuMs: null,
    durationMs: 0,
  };
}

/**
 * Adds one successful sampler call to the backends, and records each closure it shows. `relative`
 * turns an epoch time into a time from the cell start.
 */
export function mergeChunk(
  sampling: RoleSampling,
  chunk: RoleChunk,
  relative: (epochMs: number) => number,
): void {
  const seen = new Set<string>();
  for (const entry of chunk.backends) {
    const key = `${entry.pid}@${entry.backendStartMs}`;
    seen.add(key);
    let known = sampling.backends.get(key);
    if (known === undefined) {
      known = {
        pid: entry.pid,
        backendStartMs: relative(entry.backendStartMs),
        firstSeenMs: relative(entry.firstSeenMs),
        lastSeenMs: relative(entry.lastSeenMs),
        closure: null,
        runs: [],
        markersMs: [],
        commitsMs: new Set(),
      };
      sampling.backends.set(key, known);
    }
    known.lastSeenMs = Math.max(known.lastSeenMs, relative(entry.lastSeenMs));
    for (const marker of entry.markersMs) known.markersMs.push(relative(marker));
    // A COMMIT stays the last statement until the next one, so later calls see it again.
    for (const commit of entry.commitsMs) known.commitsMs.add(round(relative(commit))!);
    if (entry.firstAbsentMs !== null && known.closure === null) {
      known.closure = {
        lastPresentMs: known.lastSeenMs,
        firstAbsentMs: relative(entry.firstAbsentMs),
      };
    }
  }
  // A backend that the previous call saw at its end, and that this call never saw, closed before
  // the first sample of this call.
  for (const [key, known] of sampling.backends) {
    if (known.closure === null && !seen.has(key)) {
      known.closure = {
        lastPresentMs: known.lastSeenMs,
        firstAbsentMs: relative(chunk.firstIterationMs),
      };
    }
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  const runs = [...chunk.runs].sort((left, right) => left.firstMs - right.firstMs);
  for (const run of runs) {
    const known = sampling.backends.get(`${run.pid}@${run.backendStartMs}`);
    if (known === undefined) continue;
    const last = known.runs.at(-1);
    // The chunk holds heartbeat runs too, so two statement runs that a heartbeat separated are
    // never next to each other here. A run that goes on from the previous call stays one run.
    if (last !== undefined && last.kind === run.kind) {
      last.lastMs = relative(run.lastMs);
    } else {
      known.runs.push({
        kind: run.kind,
        firstMs: relative(run.firstMs),
        lastMs: relative(run.lastMs),
      });
    }
  }
}

/** A run of `listen` or `statement` samples: a use of the backend that is not a heartbeat. */
function otherUses(backend: ObservedBackend): RoleRun[] {
  return backend.runs.filter((run) => run.kind !== "heartbeat");
}

/** One heartbeat round that the driver observed on a backend. */
interface ObservedRound {
  atMs: number;
  /** A sample saw the marker, or a later COMMIT inferred the round. */
  source: "marker" | "commit";
  /**
   * A marker, or a COMMIT at most one expiry time after a marker. Only a confirmed round counts
   * for coverage, so COMMITs alone cannot make the observation of a backend look complete.
   */
  confirmed: boolean;
}

/**
 * The heartbeat rounds that the driver observed on a backend, in time order.
 *
 * A sample that caught a heartbeat marker observes a round. With `commitInference`, a new COMMIT
 * also observes a round when the backend ran a marker before it and no `listen` or `statement`
 * sample came between them. Such a round renews the heartbeat role. It counts for coverage only
 * when it comes at most one expiry time after the last marker.
 *
 * COMMIT inference depends on one assumption: in the probes, every statement other than a
 * heartbeat round runs in autocommit, so only a heartbeat round ends with an explicit COMMIT. Both
 * psycopg probes set `autocommit` (`python/tools/connection_budget_probe.py`). The asyncpg
 * executor calls `fetch` (`python/src/workhorse/_drivers.py`), the Go executor calls `Query`
 * (`go/executor.go`), the Ruby executor calls `exec_params`
 * (`ruby/lib/stablemates/workhorse/executor.rb`), the Rust SDK sends one pooled query
 * (`rust/src/queue.rs`), and JVM worker calls use autocommit. A probe that adds an explicit
 * transaction must turn `commitInference` off (`--no-commit-inference`).
 *
 * Observations closer than half an interval belong to one round, and a marker wins over a COMMIT.
 */
function observedRounds(
  backend: ObservedBackend,
  heartbeatMs: number,
  expiryMs: number,
  commitInference: boolean,
): ObservedRound[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  const markers = [...backend.markersMs].sort((left, right) => left - right);
  const uses = otherUses(backend);
  const observations: ObservedRound[] = markers.map((atMs) => ({
    atMs,
    source: "marker",
    confirmed: true,
  }));
  if (commitInference) {
    for (const commit of backend.commitsMs) {
      let marker: number | undefined;
      for (const at of markers) {
        if (at > commit) break;
        marker = at;
      }
      if (marker === undefined) continue;
      const seenMarker = marker;
      const otherUse = uses.some((run) => run.lastMs >= seenMarker && run.firstMs <= commit);
      if (otherUse) continue;
      observations.push({
        atMs: commit,
        source: "commit",
        confirmed: commit - seenMarker <= expiryMs,
      });
    }
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  observations.sort((left, right) => left.atMs - right.atMs);
  const rounds: ObservedRound[] = [];
  for (const observation of observations) {
    const last = rounds.at(-1);
    if (last === undefined || observation.atMs - last.atMs >= heartbeatMs / 2) {
      rounds.push({ ...observation });
    } else if (observation.source === "marker") {
      last.source = "marker";
      last.confirmed = true;
    }
  }
  return rounds;
}

/** One continuous time in which a backend had the heartbeat role. */
interface HeartbeatEpisode {
  startMs: number;
  endMs: number;
  /** Why the role ended: another use, no round within the expiry, closure, or the cell end. */
  endReason: "statement" | "listen" | "expired" | "closed" | "open-at-end" | "unresolved";
  rounds: number[];
}

function heartbeatEpisodes(
  backend: ObservedBackend,
  rounds: readonly number[],
  expiryMs: number,
  samplerEndMs: number,
  closureUnresolved: boolean,
): HeartbeatEpisode[] {
  const episodes: HeartbeatEpisode[] = [];
  const uses = otherUses(backend);
  const goneMs = backend.closure?.lastPresentMs ?? samplerEndMs;
  let index = 0;
  while (index < rounds.length) {
    const startMs = rounds[index]!;
    const episodeRounds = [startMs];
    let endMs: number;
    let endReason: HeartbeatEpisode["endReason"];
    for (;;) {
      const last = episodeRounds.at(-1)!;
      const next = rounds[index + 1];
      const otherUse = uses.find(
        (run) => run.firstMs > last && run.firstMs <= (next ?? Number.POSITIVE_INFINITY),
      );
      const expiresMs = last + expiryMs;
      if (otherUse !== undefined && otherUse.firstMs <= expiresMs && otherUse.firstMs <= goneMs) {
        endMs = otherUse.firstMs;
        endReason = otherUse.kind === "listen" ? "listen" : "statement";
        break;
      }
      if (next !== undefined && next <= expiresMs) {
        episodeRounds.push(next);
        index += 1;
        continue;
      }
      if (goneMs <= expiresMs && goneMs < samplerEndMs) {
        endMs = goneMs;
        endReason = "closed";
      } else if (expiresMs >= samplerEndMs) {
        endMs = samplerEndMs;
        endReason = backend.closure === null && closureUnresolved ? "unresolved" : "open-at-end";
      } else {
        endMs = expiresMs;
        endReason = "expired";
      }
      break;
    }
    episodes.push({ startMs, endMs, endReason, rounds: episodeRounds });
    index += 1;
  }
  return episodes;
}

/** The role of a backend at a time. A role starts when the driver first observes it. */
function roleAt(
  backend: ObservedBackend,
  episodes: readonly HeartbeatEpisode[],
  atMs: number,
  samplerEndMs: number,
): Role | null {
  const goneMs = backend.closure?.lastPresentMs ?? samplerEndMs;
  if (atMs < backend.firstSeenMs || atMs > goneMs) return null;
  if (episodes.some((episode) => episode.startMs <= atMs && atMs < episode.endMs)) {
    return "heartbeat";
  }
  // The last evidence before the time: a use that had started, or a heartbeat episode that ended.
  let latest: { atMs: number; role: Role } | null = null;
  for (const run of otherUses(backend)) {
    if (run.firstMs > atMs) continue;
    const evidence = Math.min(run.lastMs, atMs);
    if (latest === null || evidence >= latest.atMs) {
      latest = { atMs: evidence, role: run.kind === "listen" ? "listen" : "statement" };
    }
  }
  for (const episode of episodes) {
    if (episode.endMs <= atMs && (latest === null || episode.endMs > latest.atMs)) {
      latest = { atMs: episode.endMs, role: "former-heartbeat" };
    }
  }
  return latest?.role ?? "unknown";
}

interface RoleEvent {
  atMs: number;
  pid: number;
  event: "heartbeat-start" | "heartbeat-end";
  reason?: HeartbeatEpisode["endReason"];
  /** For an end by closure: the last sample that saw the backend, and the first that did not. */
  closure?: Closure;
}

/** The mean time between two sampler iterations in some calls. */
function effectiveIntervalMs(calls: readonly SamplerCall[]): number | null {
  // A call of n iterations has n - 1 intervals between them.
  const intervals = calls.reduce((total, call) => total + Math.max(0, call.iterations - 1), 0);
  const duration = calls.reduce((total, call) => total + call.durationMs, 0);
  return intervals === 0 ? null : round(duration / intervals);
}

/** The most distinct backends with an observation in one interval of `windowMs`. */
function peakInInterval(times: readonly { pid: number; atMs: number }[], windowMs: number): number {
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  const sorted = [...times].sort((left, right) => left.atMs - right.atMs);
  let peak = 0;
  let start = 0;
  const inside = new Map<number, number>();
  for (const entry of sorted) {
    inside.set(entry.pid, (inside.get(entry.pid) ?? 0) + 1);
    while (sorted[start]!.atMs <= entry.atMs - windowMs) {
      const old = sorted[start]!;
      const left = (inside.get(old.pid) ?? 1) - 1;
      if (left === 0) inside.delete(old.pid);
      else inside.set(old.pid, left);
      start += 1;
    }
    peak = Math.max(peak, inside.size);
  }
  return peak;
}

export interface ConnectionRoleOptions {
  /** Where the measurement window starts, from the cell start. */
  windowStartMs: number;
  /** When the sampler stopped, from the cell start. */
  samplerEndMs: number;
  heartbeatMs: number;
  /** Count a COMMIT after a marker as a round. Turn it off for a probe with explicit transactions. */
  commitInference: boolean;
}

/**
 * Counts the backends in each role over time, from the observations of the sampler. A backend has
 * the heartbeat role from the first round that the driver observes on it. It keeps the role while
 * the driver observes a round at least once in each expiry time, max(2 x I, 2 s), and until it
 * runs another kind of statement. After an expiry it is a former heartbeat connection.
 */
export function connectionRoles(sampling: RoleSampling, options: ConnectionRoleOptions) {
  const { windowStartMs, samplerEndMs, heartbeatMs, commitInference } = options;
  const expiryMs = Math.max(2 * heartbeatMs, 2_000);
  const backends = [...sampling.backends.values()];
  const analysed = backends.map((backend) => {
    const rounds = observedRounds(backend, heartbeatMs, expiryMs, commitInference);
    const episodes = heartbeatEpisodes(
      backend,
      rounds.map((entry) => entry.atMs),
      expiryMs,
      samplerEndMs,
      sampling.failedAfterLastSuccess,
    );
    return { backend, rounds, episodes };
  });
  const series: number[][] = [];
  for (let at = 0; at <= samplerEndMs; at += roleSeriesIntervalMs) {
    const counts: Record<Role, number> = {
      listen: 0,
      heartbeat: 0,
      "former-heartbeat": 0,
      statement: 0,
      unknown: 0,
    };
    for (const { backend, episodes } of analysed) {
      const role = roleAt(backend, episodes, at, samplerEndMs);
      if (role !== null) counts[role] += 1;
    }
    series.push([
      at,
      counts.listen,
      counts.heartbeat,
      counts["former-heartbeat"],
      counts.statement,
      counts.unknown,
    ]);
  }
  const inWindow = series.filter(([at]) => at! >= windowStartMs);
  const describe = (column: number) => {
    const found = inWindow.map((row) => row[column]!);
    return {
      min: found.length === 0 ? null : Math.min(...found),
      p50: nearestRankPercentile(found, 0.5),
      max: found.length === 0 ? null : Math.max(...found),
    };
  };
  const events: RoleEvent[] = [];
  for (const { backend, episodes } of analysed) {
    for (const episode of episodes) {
      events.push({ atMs: round(episode.startMs)!, pid: backend.pid, event: "heartbeat-start" });
      if (episode.endReason === "open-at-end") continue;
      events.push({
        atMs: round(episode.endMs)!,
        pid: backend.pid,
        event: "heartbeat-end",
        reason: episode.endReason,
        ...(episode.endReason === "closed" && backend.closure !== null
          ? { closure: backend.closure }
          : {}),
      });
    }
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  events.sort((left, right) => left.atMs - right.atMs);
  const gapLimitMs = 1.5 * heartbeatMs;
  // Coverage: for each heartbeat backend, the heartbeat intervals with a confirmed round, against
  // the whole intervals of its heartbeat role. Gaps also use confirmed rounds only.
  const coverage = analysed
    .filter(({ episodes }) => episodes.length > 0)
    .map(({ backend, rounds, episodes }) => {
      let windowsInRole = 0;
      let windowsObserved = 0;
      let windowsWithMarker = 0;
      let maxRoundGapMs = 0;
      let missedRoundGaps = 0;
      let trailingGapMs = 0;
      let trailingGapsAboveLimit = 0;
      for (const episode of episodes) {
        const confirmed = rounds.filter(
          (entry) => entry.confirmed && entry.atMs >= episode.startMs && entry.atMs < episode.endMs,
        );
        const first = Math.ceil(episode.startMs / heartbeatMs);
        const last = Math.floor(episode.endMs / heartbeatMs);
        for (let window = first; window < last; window += 1) {
          windowsInRole += 1;
          const from = window * heartbeatMs;
          const inside = confirmed.filter(
            (entry) => entry.atMs >= from && entry.atMs < from + heartbeatMs,
          );
          if (inside.length > 0) windowsObserved += 1;
          if (inside.some((entry) => entry.source === "marker")) windowsWithMarker += 1;
        }
        for (let index = 1; index < confirmed.length; index += 1) {
          const gap = confirmed[index]!.atMs - confirmed[index - 1]!.atMs;
          maxRoundGapMs = Math.max(maxRoundGapMs, gap);
          if (gap > gapLimitMs) missedRoundGaps += 1;
        }
        // The gap from the last confirmed round to the end of the role. Up to 1.5 intervals is a
        // short final interval; above that, a round is missing or late. An episode with no
        // confirmed round counts its whole length.
        const trailing = episode.endMs - (confirmed.at(-1)?.atMs ?? episode.startMs);
        trailingGapMs = Math.max(trailingGapMs, trailing);
        maxRoundGapMs = Math.max(maxRoundGapMs, trailing);
        if (trailing > gapLimitMs || confirmed.length === 0) trailingGapsAboveLimit += 1;
      }
      const commitRounds = rounds.filter((entry) => entry.source === "commit");
      return {
        pid: backend.pid,
        roundsObserved: rounds.length,
        markerRounds: rounds.length - commitRounds.length,
        commitInferredRounds: commitRounds.length,
        // Inferred rounds more than one expiry time after a marker: they renew the role, but they
        // do not count for coverage.
        unconfirmedCommitRounds: commitRounds.filter((entry) => !entry.confirmed).length,
        markerSamples: backend.markersMs.length,
        windowsInRole,
        windowsObserved,
        windowsWithMarker,
        maxRoundGapMs: round(maxRoundGapMs),
        trailingGapMs: round(trailingGapMs),
        missedRoundGaps,
        trailingGapsAboveLimit,
        expiredWhileOpen: episodes.filter((episode) => episode.endReason === "expired").length,
      };
    });
  const heartbeatObserved = coverage.length > 0;
  const callsInWindow = sampling.calls.filter((call) => call.startMs >= windowStartMs);
  const roundTimes = analysed.flatMap(({ backend, rounds }) =>
    rounds.map((entry) => ({ pid: backend.pid, atMs: entry.atMs })),
  );
  const markerTimes = backends.flatMap((backend) =>
    backend.markersMs.map((atMs) => ({ pid: backend.pid, atMs })),
  );
  return {
    sampleIntervalMs: roleSampleIntervalMs,
    expiryMs,
    commitInference,
    calls: sampling.calls.length,
    iterations: sampling.calls.reduce((total, call) => total + call.iterations, 0),
    effectiveIntervalMs: {
      cell: effectiveIntervalMs(sampling.calls),
      windowStart: effectiveIntervalMs(callsInWindow.slice(0, 3)),
      windowEnd: effectiveIntervalMs(callsInWindow.slice(-3)),
    },
    maxRelationBytes: Math.max(0, ...sampling.calls.map((call) => call.relationBytes)),
    errors: sampling.errors,
    closureAtEndUncertain: sampling.failedAfterLastSuccess,
    // Distinct backends by the roles they ever had in the cell.
    listenerPids: backends.filter((backend) => backend.runs.some((run) => run.kind === "listen"))
      .length,
    heartbeatPids: coverage.length,
    statementPids: backends.filter((backend) =>
      backend.runs.some((run) => run.kind === "statement"),
    ).length,
    unclassifiedPids: backends.filter(
      (backend) => backend.runs.length === 0 && backend.markersMs.length === 0,
    ).length,
    // The backends in each role at one time, every 250 ms of the measurement window. These are
    // observed heartbeat-role connections: an estimate from SQL observation, not a count of
    // reservations.
    listenerConnections: describe(1),
    observedHeartbeatRoleConnections: heartbeatObserved ? describe(2) : "unknown",
    formerHeartbeatConnections: describe(3),
    statementConnections: describe(4),
    unclassifiedConnections: describe(5),
    peakHeartbeatBackendsInOneInterval: heartbeatObserved
      ? peakInInterval(roundTimes, heartbeatMs)
      : "unknown",
    peakMarkerBackendsInOneInterval: heartbeatObserved
      ? peakInInterval(markerTimes, heartbeatMs)
      : "unknown",
    markerRounds: coverage.reduce((total, entry) => total + entry.markerRounds, 0),
    commitInferredRounds: coverage.reduce((total, entry) => total + entry.commitInferredRounds, 0),
    unconfirmedCommitRounds: coverage.reduce(
      (total, entry) => total + entry.unconfirmedCommitRounds,
      0,
    ),
    heartbeatCoverage: coverage,
    heartbeatObservationIncomplete:
      !heartbeatObserved ||
      sampling.errors.length > 0 ||
      coverage.some(
        (entry) =>
          entry.missedRoundGaps > 0 ||
          entry.trailingGapsAboveLimit > 0 ||
          entry.expiredWhileOpen > 0,
      ),
    heartbeatStarts: events.filter((event) => event.event === "heartbeat-start").length,
    heartbeatEnds: events.filter((event) => event.event === "heartbeat-end").length,
    events,
    backends: analysed.map(({ backend, rounds }) => ({
      pid: backend.pid,
      backendStartMs: round(backend.backendStartMs),
      firstSeenMs: round(backend.firstSeenMs),
      lastSeenMs: round(backend.lastSeenMs),
      closure: backend.closure,
      runs: backend.runs.map((run) => ({
        kind: run.kind,
        firstMs: round(run.firstMs),
        lastMs: round(run.lastMs),
      })),
      rounds: rounds.map((entry) => ({
        atMs: round(entry.atMs),
        source: entry.source,
        confirmed: entry.confirmed,
      })),
    })),
    series: {
      columns: ["elapsedMs", "listen", "heartbeat", "formerHeartbeat", "statement", "unknown"],
      rows: series,
    },
  };
}
