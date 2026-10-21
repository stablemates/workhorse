/**
 * The analysis of the connection budget benchmark (SM-1566, SM-1570). The role sampler in
 * `scripts/benchmark-connection-budget.ts` reads `pg_stat_activity` in the database and returns
 * what each probe backend ran. These functions turn those observations into roles over time, find
 * the replacement of a heartbeat connection after a fault, measure claim gaps from the claim and
 * settlement times, and give the pass or fail result of a cell. They read no database, so the unit
 * tests replay observations through them.
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
  /**
   * The last time that the run used the backend: a sample of a running statement, or the
   * `state_change` of an idle sample, which is when the statement ended. An idle backend keeps
   * the text of its last statement, so `lastMs` can be later than the use. Null when no sample
   * shows a use.
   */
  lastUseMs: number | null;
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
  runs: {
    pid: number;
    backendStartMs: number;
    kind: RunKind;
    firstMs: number;
    lastMs: number;
    lastUseMs?: number | null;
  }[];
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
    const lastUseMs =
      run.lastUseMs === null || run.lastUseMs === undefined ? null : relative(run.lastUseMs);
    if (last !== undefined && last.kind === run.kind) {
      last.lastMs = relative(run.lastMs);
      if (lastUseMs !== null) last.lastUseMs = Math.max(last.lastUseMs ?? lastUseMs, lastUseMs);
    } else {
      known.runs.push({
        kind: run.kind,
        firstMs: relative(run.firstMs),
        lastMs: relative(run.lastMs),
        lastUseMs,
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

/** The roles of every backend: its observed rounds and its heartbeat episodes. */
function analyseBackends(sampling: RoleSampling, options: ConnectionRoleOptions) {
  const expiryMs = Math.max(2 * options.heartbeatMs, 2_000);
  return [...sampling.backends.values()].map((backend) => {
    const rounds = observedRounds(backend, options.heartbeatMs, expiryMs, options.commitInference);
    const episodes = heartbeatEpisodes(
      backend,
      rounds.map((entry) => entry.atMs),
      expiryMs,
      options.samplerEndMs,
      sampling.failedAfterLastSuccess,
    );
    return { backend, rounds, episodes };
  });
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
  const analysed = analyseBackends(sampling, options);
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
        lastUseMs: round(run.lastUseMs),
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

/** A probe backend, by its process ID and its start time from the cell start. */
export interface BackendIdentity {
  pid: number;
  backendStartMs: number;
}

/**
 * The backends that have the heartbeat role at `atMs`, from the observations so far. The fault of
 * a fault cell ends these backends together with the one that it finds in a heartbeat round.
 *
 * The observations can end at `atMs` or before it, because each call of the sampler returns only
 * when it ends. A role that is open at the end of the observations goes on until it expires, so the
 * observations count as open up to just after `atMs`.
 */
export function heartbeatRoleBackendsAt(
  sampling: RoleSampling,
  options: ConnectionRoleOptions,
  atMs: number,
): BackendIdentity[] {
  const samplerEndMs = Math.max(options.samplerEndMs, atMs + 1);
  return analyseBackends(sampling, { ...options, samplerEndMs })
    .filter(
      ({ backend, episodes }) => roleAt(backend, episodes, atMs, samplerEndMs) === "heartbeat",
    )
    .map(({ backend }) => ({ pid: backend.pid, backendStartMs: backend.backendStartMs }));
}

/**
 * What the observations show about the recovery after a fault ended the heartbeat connections at
 * `faultAtMs`.
 *
 * The replacement is the first other backend with an observed heartbeat round after the fault. The
 * driver cannot see when the SDK reserves it. It can only see the last time at which the backend
 * was in ordinary use: its start, or the end of the last other statement that it ran. Only a
 * sample of a running statement or the end time of an idle one moves this bound. The text that
 * an idle backend keeps does not move it. Thus `readyNotBeforeMs` is a lower bound of the time
 * when the replacement was ready, and `firstRoundMs` is an upper bound.
 *
 * `lastRoundBeforeFaultMs` is the last round that can have renewed a lease before the fault. The
 * fault interrupts the round on the `interrupted` backend, and that round renews nothing.
 * Observations less than half an interval apart are one round, so a round on that backend counts
 * only when it came at least half an interval before the fault.
 */
export function faultRecovery(
  sampling: RoleSampling,
  options: ConnectionRoleOptions,
  fault: {
    faultAtMs: number;
    interrupted: BackendIdentity | null;
    terminated: readonly BackendIdentity[];
  },
) {
  const { faultAtMs, interrupted, terminated } = fault;
  const same = (entry: BackendIdentity, backend: ObservedBackend) =>
    entry.pid === backend.pid && Math.abs(entry.backendStartMs - backend.backendStartMs) < 1;
  const ended = (backend: ObservedBackend) => terminated.some((entry) => same(entry, backend));
  let lastRoundBeforeFaultMs: number | null = null;
  let replacement: { backend: ObservedBackend; firstRoundMs: number } | null = null;
  for (const { backend, rounds } of analyseBackends(sampling, options)) {
    const interruptedFromMs =
      interrupted !== null && same(interrupted, backend)
        ? faultAtMs - options.heartbeatMs / 2
        : faultAtMs;
    for (const entry of rounds) {
      if (entry.atMs <= faultAtMs) {
        if (entry.atMs < interruptedFromMs) {
          lastRoundBeforeFaultMs = Math.max(lastRoundBeforeFaultMs ?? entry.atMs, entry.atMs);
        }
      } else if (
        !ended(backend) &&
        (replacement === null || entry.atMs < replacement.firstRoundMs)
      ) {
        replacement = { backend, firstRoundMs: entry.atMs };
      }
    }
  }
  if (replacement === null) return { lastRoundBeforeFaultMs, replacement: null };
  const { backend, firstRoundMs } = replacement;
  const notReservedMs = otherUses(backend)
    .filter((run) => run.firstMs < firstRoundMs && run.lastUseMs !== null)
    .map((run) => Math.min(run.lastUseMs!, firstRoundMs));
  return {
    lastRoundBeforeFaultMs,
    replacement: {
      pid: backend.pid,
      backendStartMs: round(backend.backendStartMs),
      firstRoundMs: round(firstRoundMs),
      readyNotBeforeMs: round(Math.max(faultAtMs, backend.backendStartMs, ...notReservedMs)),
    },
  };
}

/** A time interval from the cell start, with its end excluded. */
export interface Interval {
  fromMs: number;
  toMs: number;
}

/**
 * The times in which some backend has the heartbeat role: the observed evidence that the heartbeat
 * reservation of the pool is ready. The benchmark has one pool identity, so one heartbeat
 * connection serves every worker. Outside these times the readiness is unknown, not false.
 */
export function heartbeatReadyIntervals(
  sampling: RoleSampling,
  options: ConnectionRoleOptions,
): Interval[] {
  const episodes = analyseBackends(sampling, options)
    .flatMap(({ episodes: own }) => own)
    .map((episode) => ({ fromMs: episode.startMs, toMs: episode.endMs }))
    .filter((entry) => entry.toMs > entry.fromMs);
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  episodes.sort((left, right) => left.fromMs - right.fromMs);
  const merged: Interval[] = [];
  for (const entry of episodes) {
    const last = merged.at(-1);
    if (last !== undefined && entry.fromMs <= last.toMs)
      last.toMs = Math.max(last.toMs, entry.toMs);
    else merged.push({ ...entry });
  }
  return merged;
}

// --- Claims ----------------------------------------------------------------------------------

/**
 * One claim: when the `claimed` event came, the worker that claimed, and when the claim function
 * started, from the `expires_at` of the event less the lease. Null when the event has no lease end.
 */
export interface Claim {
  atMs: number;
  worker: string;
  acquiredMs?: number | null;
}

/** One closed attempt: when the worker settled it, and whether its task became ready again. */
export interface ClosedAttempt {
  atMs: number;
  worker: string;
  returnsToReady: boolean;
}

/** One worker, and the time from which it has slots: its registration or its first claim. */
export interface WorkerStart {
  worker: string;
  atMs: number;
}

/** The readiness of the heartbeat reservation over time. Other times are unknown. */
export interface Readiness {
  ready: readonly Interval[];
  notReady: readonly Interval[];
}

/** A claim gap: its length, its bounds, and its worker. */
export interface ClaimGap {
  lengthMs: number;
  startMs: number | null;
  endMs: number | null;
  worker: string | null;
}

const noGap: ClaimGap = { lengthMs: 0, startMs: null, endMs: null, worker: null };

/**
 * Replays the dispatch state of a cell, once, for its whole observation. A claim takes one slot of
 * its worker and one ready task. A closed attempt frees the slot of its worker, and a retry or a
 * lost lease makes its task ready again. A worker has `slotsPerWorker` slots from its start. Every
 * task is ready at the start.
 *
 * A worker is eligible while it has a free slot and a task is ready. A claim gap of a worker is a
 * time in which it stays eligible and claims nothing. The gap ends at its next claim, or when any
 * of its conditions ends. The replay gives two gaps:
 *
 * - `certain`: the heartbeat reservation was ready, from the observations, for the whole gap.
 * - `possible`: the reservation was ready or of unknown state for the whole gap.
 *
 * It also gives `demand`: the times in which some worker was eligible, with no condition on the
 * reservation. A claim and a settlement at the same time are a fused completion: the settlement
 * counts first.
 */
export function replayDispatch(input: {
  claims: readonly Claim[];
  closes: readonly ClosedAttempt[];
  tasks: number;
  workers: readonly WorkerStart[];
  slotsPerWorker: number;
  readiness: Readiness;
  endMs: number;
}): { certain: ClaimGap; possible: ClaimGap; demand: Interval[] } {
  // Event order at one time: readiness changes and worker starts, then settlements, then claims.
  type Event =
    | { atMs: number; order: 0; type: "boundary" }
    | { atMs: number; order: 0; type: "start"; worker: string }
    | { atMs: number; order: 1; type: "close"; worker: string; back: boolean }
    | { atMs: number; order: 2; type: "claim"; worker: string };
  const events: Event[] = [
    ...[...input.readiness.ready, ...input.readiness.notReady].flatMap((entry) => [
      { atMs: entry.fromMs, order: 0 as const, type: "boundary" as const },
      { atMs: entry.toMs, order: 0 as const, type: "boundary" as const },
    ]),
    ...input.workers.map((entry) => ({
      atMs: entry.atMs,
      order: 0 as const,
      type: "start" as const,
      worker: entry.worker,
    })),
    ...input.closes.map((close) => ({
      atMs: close.atMs,
      order: 1 as const,
      type: "close" as const,
      worker: close.worker,
      back: close.returnsToReady,
    })),
    ...input.claims.map((claim) => ({
      atMs: claim.atMs,
      order: 2 as const,
      type: "claim" as const,
      worker: claim.worker,
    })),
  ];
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  events.sort((left, right) => left.atMs - right.atMs || left.order - right.order);
  const inside = (list: readonly Interval[], atMs: number) =>
    list.some((entry) => entry.fromMs <= atMs && atMs < entry.toMs);
  const readinessAt = (atMs: number): "yes" | "no" | "unknown" =>
    inside(input.readiness.notReady, atMs)
      ? "no"
      : inside(input.readiness.ready, atMs)
        ? "yes"
        : "unknown";
  const occupied = new Map<string, number>();
  const started = new Set<string>();
  const certainStart = new Map<string, number>();
  const possibleStart = new Map<string, number>();
  let ready = input.tasks;
  let certain = noGap;
  let possible = noGap;
  const demand: Interval[] = [];
  let demandFrom: number | null = null;
  const measure = (starts: Map<string, number>, best: ClaimGap, atMs: number): ClaimGap => {
    let result = best;
    for (const [worker, startMs] of starts) {
      if (atMs - startMs > result.lengthMs) {
        result = { lengthMs: round(atMs - startMs)!, startMs, endMs: atMs, worker };
      }
    }
    return result;
  };
  for (const event of events) {
    if (event.atMs > input.endMs) break;
    certain = measure(certainStart, certain, event.atMs);
    possible = measure(possibleStart, possible, event.atMs);
    if (event.type === "start") {
      started.add(event.worker);
      if (!occupied.has(event.worker)) occupied.set(event.worker, 0);
    } else if (event.type === "claim") {
      // A worker that claims before its registration starts at its first claim.
      started.add(event.worker);
      occupied.set(event.worker, (occupied.get(event.worker) ?? 0) + 1);
      ready -= 1;
      certainStart.delete(event.worker);
      possibleStart.delete(event.worker);
    } else if (event.type === "close") {
      occupied.set(event.worker, (occupied.get(event.worker) ?? 0) - 1);
      if (event.back) ready += 1;
    }
    const state = readinessAt(event.atMs);
    let anyEligible = false;
    for (const worker of started) {
      const eligible = (occupied.get(worker) ?? 0) < input.slotsPerWorker && ready > 0;
      anyEligible ||= eligible;
      for (const [starts, holds] of [
        [certainStart, eligible && state === "yes"],
        [possibleStart, eligible && state !== "no"],
      ] as const) {
        if (!holds) starts.delete(worker);
        else if (!starts.has(worker)) starts.set(worker, event.atMs);
      }
    }
    if (anyEligible && demandFrom === null) demandFrom = event.atMs;
    if (!anyEligible && demandFrom !== null) {
      demand.push({ fromMs: demandFrom, toMs: event.atMs });
      demandFrom = null;
    }
  }
  certain = measure(certainStart, certain, input.endMs);
  possible = measure(possibleStart, possible, input.endMs);
  if (demandFrom !== null) demand.push({ fromMs: demandFrom, toMs: input.endMs });
  return { certain, possible, demand };
}

/**
 * Sorts the claims after a fault by their origin. A claim whose claim function started before the
 * fault came from a statement that started before it. Of the other claims, one is `uncertain`
 * while a statement that ran at the fault time was still running, because that statement can have
 * started its claim function after the fault. `inFlightEndedMs` is the time by which those
 * statements had ended, or null when it is not known. All other claims are `fresh`.
 */
export function attributeFaultClaims(
  claims: readonly Claim[],
  faultAtMs: number,
  inFlightEndedMs: number | null,
): { fresh: number[]; uncertain: number[]; beforeFault: number } {
  const fresh: number[] = [];
  const uncertain: number[] = [];
  let beforeFault = 0;
  // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
  for (const claim of [...claims].sort((left, right) => left.atMs - right.atMs)) {
    if (claim.atMs < faultAtMs) continue;
    const startedMs = claim.acquiredMs ?? null;
    if (startedMs !== null && startedMs < faultAtMs) beforeFault += 1;
    else if (startedMs === null || inFlightEndedMs === null || startedMs <= inFlightEndedMs) {
      uncertain.push(claim.atMs);
    } else fresh.push(claim.atMs);
  }
  return { fresh, uncertain, beforeFault };
}

/**
 * What the driver knows about the attempts of a fault cell. The samples of
 * `workhorse.task_runtime` give the last accepted renewal and the lease deadline of each attempt,
 * because only an accepted renewal changes `heartbeat_at` and `expires_at`. The attempt history
 * gives each settlement. Times are from the cell start.
 */
export interface AttemptRecords {
  /** Each claimed attempt, by task and fence token, with its claim time. */
  claimed: readonly { attempt: string; atMs: number }[];
  /** Each closed attempt, with its outcome and its `finished_at`. */
  closed: readonly { attempt: string; outcome: string; finishedAtMs: number }[];
  /** The last sample of each attempt. */
  lastSamples: readonly { attempt: string; renewalMs: number; deadlineMs: number }[];
  /** The attempts in the last sample of the cell whose deadline was after that sample. */
  liveAtEnd: readonly string[];
  /** The time of the last sample. Attempts claimed after it are outside the observation. */
  observedUntilMs: number;
}

/**
 * Whether the lease losses of a fault cell stayed inside the watchdog bound of ADR 0071 and
 * ADR 0105. The watchdog runs inside the worker, and no driver data shows when it fired. The
 * `finished_at` of a `lease_expired` row is when the database recovered the attempt, which can be
 * long after an early local abort. Thus:
 *
 * - A recovery before the deadline that the samples show fails: the attempt was ended early.
 * - Any other recovery cannot be decided, because the local loss time is not known.
 * - An attempt with no settlement proves nothing about a local abort, unless it is live and
 *   unexpired at the end and had an accepted renewal after the fault. A worker that aborted it
 *   would not renew it.
 * - An attempt that the worker settled with another outcome was not aborted.
 *
 * The rule passes only when every attempt of the observation is settled with another outcome or
 * proven live, and it fails when one recovery came before its deadline.
 */
export function watchdogVerdict(
  records: AttemptRecords,
  faultAtMs: number,
): {
  pass: boolean | null;
  earlyRecoveries: number;
  undecided: number;
  settled: number;
  live: number;
} {
  const samples = new Map(records.lastSamples.map((entry) => [entry.attempt, entry]));
  const live = new Set(records.liveAtEnd);
  const closed = new Map<string, { outcome: string; finishedAtMs: number }[]>();
  for (const entry of records.closed) {
    const list = closed.get(entry.attempt) ?? [];
    list.push(entry);
    closed.set(entry.attempt, list);
  }
  let earlyRecoveries = 0;
  for (const entry of records.closed) {
    const deadlineMs = samples.get(entry.attempt)?.deadlineMs;
    if (
      entry.outcome === "lease_expired" &&
      deadlineMs !== undefined &&
      entry.finishedAtMs < deadlineMs
    ) {
      earlyRecoveries += 1;
    }
  }
  let undecided = 0;
  let settled = 0;
  let proven = 0;
  for (const { attempt, atMs } of records.claimed) {
    if (atMs > records.observedUntilMs) continue;
    const closes = closed.get(attempt) ?? [];
    const sample = samples.get(attempt);
    if (closes.length > 0 && closes.every((entry) => entry.outcome !== "lease_expired")) {
      settled += 1;
    } else if (
      closes.length === 0 &&
      live.has(attempt) &&
      sample !== undefined &&
      sample.renewalMs > faultAtMs
    ) {
      proven += 1;
    } else {
      undecided += 1;
    }
  }
  const pass = earlyRecoveries > 0 ? false : undecided > 0 ? null : true;
  return { pass, earlyRecoveries, undecided, settled, live: proven };
}

/**
 * The latest possible next regular slot after a fault. The SDK sends a regular round at its slot,
 * and a busy retry runs between two slots. A slot is never later than the start of a round that
 * runs in it, so the next slot is at most the start of the interrupted round plus I. Without an
 * interrupted round, the driver uses the fault plus I: a round that the sampler did not see can
 * move the slot past an older observation.
 *
 * The driver cannot prove the next slot from sampled data, because any round between two samples
 * can escape the sampler. Thus it gives no earliest slot, and the dispatch rule built on this
 * bound can only detect a violation. The bound keeps full precision, so a claim just before it is
 * never compared with a smaller, rounded value.
 */
export function latestNextSlot(fault: {
  faultAtMs: number;
  interruptedStartMs: number | null;
  heartbeatMs: number;
}): { latestMs: number; basis: "interrupted round" | "fault" } {
  const { faultAtMs, interruptedStartMs, heartbeatMs } = fault;
  return interruptedStartMs === null
    ? { latestMs: faultAtMs + heartbeatMs, basis: "fault" }
    : {
        latestMs: Math.min(interruptedStartMs, faultAtMs) + heartbeatMs,
        basis: "interrupted round",
      };
}

// --- Results ---------------------------------------------------------------------------------

/**
 * A held-task cell holds every claimed task until the probe stops. A refill cell finishes each task
 * after a fixed time, so the workers claim again. A fault cell ends the heartbeat connection of a
 * workload that claims often.
 */
export type CellKind = "held" | "refill" | "fault";

/** The values of one cell that its result reads. A null value fails the rules that read it. */
export interface CellFacts {
  kind: CellKind;
  heartbeatMs: number;
  leaseMs: number;
  /** W × C. */
  slots: number;
  finalUnexpiredActiveTasks: number | null;
  lostLeases: number | null;
  maxExpiredActiveTasks: number | null;
  maxRenewalAgeMs: number | null;
  minLeaseMarginMs: number | null;
  /** The most backends with each role at one time, in the measurement window. */
  maxListenerConnections: number | null;
  maxHeartbeatConnections: number | "unknown" | null;
  workerErrors: number;
  sampleErrors: number;
  probe: {
    exitedBeforeStopMs: number | null;
    exitCode: number | null;
    killed: boolean;
    stopMs: number | null;
    killDeadlineMs: number;
    /** The `worker_error` and `shutdown_incomplete` events after SIGTERM, from an unclean stop. */
    errorsAfterStop: number;
  };
  refill?: {
    tasks: number;
    completedOnce: number;
    remainingActive: number | null;
    remainingReady: number | null;
    pollMs: number | null;
    /** The longest gap while the reservation was ready, from the observations. */
    certainGapMs: number;
    /** The longest gap while the reservation was ready or of unknown state. */
    possibleGapMs: number;
  };
  fault?: {
    terminated: number;
    faultAtMs: number;
    /** The claims at or after the fault. */
    claims: readonly Claim[];
    /** When the statements that ran at the fault time had ended; null when it is not known. */
    inFlightEndedMs: number | null;
    /** The bounds of the time when the replacement was ready; null without a replacement. */
    readyNotBeforeMs: number | null;
    replacementRoundMs: number | null;
    observationEndMs: number;
    /** The latest possible next regular slot after the fault, from `latestNextSlot`. */
    nextRound: { latestMs: number };
    /** The times in which some worker had a free slot and a task was ready. */
    demand: readonly Interval[];
    attempts: AttemptRecords;
    maxListenerAfterRecovery: number | null;
    maxHeartbeatAfterRecovery: number | null;
  };
}

/**
 * A rule passes (true), fails (false), or cannot be decided from the observations (null). A
 * detection-only rule has `detected` instead: `violated` fails the cell, and `notDetected` is not a
 * pass, does not make the cell inconclusive, and does not change its outcome.
 */
type RuleResult =
  | { rule: string; pass: boolean | null; detail: string }
  | { rule: string; detected: "violated" | "notDetected"; detail: string };

/** The longest claim gap of a refill cell, while a ready task and a free slot exist. */
export const refillClaimGapLimitMs = 5_000;
/** The polling interval that a refill or fault probe sets. */
export const refillPollMs = 1_000;
/**
 * The time that dispatch can need to see a free slot: one polling interval of a refill or fault
 * probe. A free slot must exist this long before the latest possible next slot for a missing claim
 * to count as a violation.
 */
export const dispatchAllowanceMs = 1_000;

function shown(value: number | string | null): string {
  return value === null ? "missing" : String(value);
}

function shutdownRule({ probe }: CellFacts): RuleResult {
  return {
    rule: "shutdown",
    pass:
      probe.exitedBeforeStopMs === null &&
      !probe.killed &&
      probe.exitCode === 0 &&
      probe.errorsAfterStop === 0 &&
      probe.stopMs !== null &&
      probe.stopMs <= probe.killDeadlineMs,
    detail: probe.killed
      ? `SIGKILL after ${probe.killDeadlineMs} ms`
      : probe.exitedBeforeStopMs !== null
        ? `exited at ${probe.exitedBeforeStopMs} ms, before SIGTERM`
        : `exit ${shown(probe.exitCode)} after ${shown(probe.stopMs)} ms, ${probe.errorsAfterStop} errors after SIGTERM; deadline ${probe.killDeadlineMs} ms`,
  };
}

/** Rules 3 and 4 of a healthy held-task cell, which a refill cell also applies. */
function reservedAndShutdownRules(facts: CellFacts): RuleResult[] {
  const heartbeat = facts.maxHeartbeatConnections;
  return [
    {
      rule: "reserved backends",
      pass:
        facts.maxListenerConnections !== null &&
        facts.maxListenerConnections <= 1 &&
        typeof heartbeat === "number" &&
        heartbeat <= 1,
      detail: `listener max ${shown(facts.maxListenerConnections)} and heartbeat-role max ${shown(heartbeat)}; at most 1 each`,
    },
    {
      rule: "no errors",
      pass: facts.workerErrors === 0 && facts.sampleErrors === 0,
      detail: `${facts.workerErrors} worker errors and ${facts.sampleErrors} sample errors`,
    },
    shutdownRule(facts),
  ];
}

function heldRules(facts: CellFacts): RuleResult[] {
  const { heartbeatMs } = facts;
  return [
    {
      rule: "live leases",
      pass:
        facts.finalUnexpiredActiveTasks === facts.slots &&
        facts.lostLeases === 0 &&
        facts.maxExpiredActiveTasks === 0,
      detail: `${shown(facts.finalUnexpiredActiveTasks)}/${facts.slots} live at the end, ${shown(facts.lostLeases)} lost, ${shown(facts.maxExpiredActiveTasks)} expired active at most`,
    },
    {
      rule: "renewal age and margin",
      pass:
        facts.maxRenewalAgeMs !== null &&
        facts.maxRenewalAgeMs < 2 * heartbeatMs &&
        facts.minLeaseMarginMs !== null &&
        facts.minLeaseMarginMs > heartbeatMs,
      detail: `age max ${shown(facts.maxRenewalAgeMs)} ms below ${2 * heartbeatMs} ms; margin min ${shown(facts.minLeaseMarginMs)} ms above ${heartbeatMs} ms`,
    },
    ...reservedAndShutdownRules(facts),
  ];
}

function refillRules(facts: CellFacts): RuleResult[] {
  const refill = facts.refill;
  if (refill === undefined) throw new Error("a refill cell needs its refill values");
  const gap =
    refill.pollMs !== refillPollMs || refill.certainGapMs > refillClaimGapLimitMs
      ? false
      : refill.possibleGapMs > refillClaimGapLimitMs
        ? null
        : true;
  return [
    {
      rule: "complete once",
      pass:
        refill.completedOnce === refill.tasks &&
        refill.remainingActive === 0 &&
        refill.remainingReady === 0 &&
        facts.lostLeases === 0 &&
        facts.maxExpiredActiveTasks === 0,
      detail: `${refill.completedOnce}/${refill.tasks} completed once with one attempt, ${shown(refill.remainingActive)} active and ${shown(refill.remainingReady)} ready left, ${shown(facts.lostLeases)} lost, ${shown(facts.maxExpiredActiveTasks)} expired active at most`,
    },
    {
      rule: "claim gap",
      pass: gap,
      detail: `poll ${shown(refill.pollMs)} ms; longest gap of one worker ${refill.certainGapMs} ms with the reservation ready, ${refill.possibleGapMs} ms with its state unknown; at most ${refillClaimGapLimitMs} ms`,
    },
    ...reservedAndShutdownRules(facts),
  ];
}

/** Whether some worker had a free slot and a task was ready at some time in [fromMs, toMs). */
function demandIn(demand: readonly Interval[], fromMs: number, toMs: number): boolean {
  return demand.some((entry) => Math.min(entry.toMs, toMs) > Math.max(entry.fromMs, fromMs));
}

/** The times in `list` before `limitMs`. */
function before(list: readonly number[], limitMs: number): number {
  return list.filter((atMs) => atMs < limitMs).length;
}

function faultRules(facts: CellFacts): RuleResult[] {
  const fault = facts.fault;
  if (fault === undefined) throw new Error("a fault cell needs its fault values");
  const { fresh, uncertain, beforeFault } = attributeFaultClaims(
    fault.claims,
    fault.faultAtMs,
    fault.inFlightEndedMs,
  );
  const lowMs = fault.readyNotBeforeMs ?? fault.observationEndMs;
  const highMs = fault.replacementRoundMs ?? fault.observationEndMs;
  // A fresh claim before the lower bound fails. No claim of either kind before the upper bound
  // passes. Anything else cannot be decided.
  const outage =
    fault.terminated === 0 || before(fresh, lowMs) > 0
      ? false
      : before(fresh, highMs) + before(uncertain, highMs) === 0
        ? true
        : null;

  const watchdog = watchdogVerdict(fault.attempts, fault.faultAtMs);

  // The database stays reachable, so it is reachable again at the fault.
  const firstFresh = fresh[0] ?? null;
  const firstAny = Math.min(fresh[0] ?? Infinity, uncertain[0] ?? Infinity);
  const limitMs = 2 * facts.heartbeatMs;
  const recovery =
    firstFresh !== null && firstFresh - fault.faultAtMs <= limitMs
      ? true
      : firstAny - fault.faultAtMs <= limitMs
        ? null
        : false;

  // Dispatch must not wait for the next regular round. The driver cannot prove when that round
  // falls, so this rule only detects a clear violation: no claim of either kind before the latest
  // possible slot, although the replacement was ready and a worker had a free slot and a ready
  // task, at least one polling interval before that slot.
  const { latestMs } = fault.nextRound;
  const dispatch: "violated" | "notDetected" =
    firstAny >= latestMs && demandIn(fault.demand, highMs, latestMs - dispatchAllowanceMs)
      ? "violated"
      : "notDetected";

  return [
    {
      rule: "no claim in outage",
      pass: outage,
      detail:
        fault.terminated === 0
          ? "no heartbeat connection was ended"
          : `${before(fresh, lowMs)} fresh claims before the replacement was ready, ${before(fresh, highMs)} fresh and ${before(uncertain, highMs)} unattributed claims before its first round, ${beforeFault} claims from statements that started before the fault`,
    },
    {
      rule: "lease loss in watchdog bound",
      pass: watchdog.pass,
      detail: `${watchdog.earlyRecoveries} recoveries before the sampled deadline; ${watchdog.settled} attempts settled by the worker, ${watchdog.live} live and renewed after the fault, ${watchdog.undecided} without proof of a local loss time; ${shown(facts.lostLeases)} lost, ${shown(facts.maxExpiredActiveTasks)} expired active at most`,
    },
    {
      rule: "claim after recovery",
      pass: recovery,
      detail: `first fresh claim ${firstFresh === null ? "missing" : round(firstFresh - fault.faultAtMs)} ms and first claim of either kind ${Number.isFinite(firstAny) ? round(firstAny - fault.faultAtMs) : "missing"} ms after the database was reachable; at most ${limitMs} ms`,
    },
    {
      rule: "dispatch before next round",
      detected: dispatch,
      detail: `detection only; latest possible next regular slot at ${round(latestMs)} ms; replacement ready by ${round(highMs)} ms; first claim of either kind at ${Number.isFinite(firstAny) ? round(firstAny) : "missing"} ms`,
    },
    {
      rule: "reserved after recovery",
      pass:
        fault.maxListenerAfterRecovery !== null &&
        fault.maxListenerAfterRecovery <= 1 &&
        fault.maxHeartbeatAfterRecovery !== null &&
        fault.maxHeartbeatAfterRecovery <= 1,
      detail: `listener max ${shown(fault.maxListenerAfterRecovery)} and heartbeat-role max ${shown(fault.maxHeartbeatAfterRecovery)} after recovery; at most 1 each`,
    },
    {
      rule: "no sample errors",
      pass: facts.sampleErrors === 0,
      detail: `${facts.sampleErrors} sample errors; ${facts.workerErrors} worker errors, which this cell only records`,
    },
    shutdownRule(facts),
  ];
}

/**
 * The result of a cell, from the acceptance thresholds of SM-1565: one rule set for a healthy
 * held-task cell, one for a refill cell, and one for a fault cell. A cell passes only when every
 * rule passes. It fails when one rule fails or a detection-only rule detects a violation.
 * Otherwise it is inconclusive: a rule could not be decided from the observations. An
 * inconclusive cell is not a pass.
 */
export function cellResult(facts: CellFacts): {
  outcome: "pass" | "fail" | "inconclusive";
  pass: boolean;
  failed: string[];
  inconclusive: string[];
  rules: RuleResult[];
} {
  const rules =
    facts.kind === "held"
      ? heldRules(facts)
      : facts.kind === "refill"
        ? refillRules(facts)
        : faultRules(facts);
  // A detection-only rule fails the cell when it detects a violation, and otherwise does not count.
  const failed = rules
    .filter((entry) => ("pass" in entry ? entry.pass === false : entry.detected === "violated"))
    .map((entry) => entry.rule);
  const inconclusive = rules
    .filter((entry) => "pass" in entry && entry.pass === null)
    .map((entry) => entry.rule);
  const outcome = failed.length > 0 ? "fail" : inconclusive.length > 0 ? "inconclusive" : "pass";
  return { outcome, pass: outcome === "pass", failed, inconclusive, rules };
}
