#!/usr/bin/env node
/**
 * Derive a soak report from a series of observations.
 *
 * Usage: pnpm soak:report -- --observations DIRECTORY [--output PATH] [--json PATH]
 *
 * This is the reader-checkable half of Gate 4 in ADR 0056. Every number below is derived from the
 * observation files and nothing else, so a reader who distrusts the report can recompute it from
 * the same directory. Where a bar is not met the report says which number fell short rather than
 * softening the sentence.
 */
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  HISTORY_PARENTS,
  type HistoryParent,
  type KillRecovery,
  type MigrationRecord,
  OBSERVATION_FORMAT,
  type SoakObservation,
  type ThroughputDay,
} from "./observation.js";

const help = `Workhorse soak report

Usage:
  pnpm soak:report -- --observations DIRECTORY [options]

Options:
  --observations DIRECTORY  Directory of files written by pnpm soak:observe
  --output PATH             Write the Markdown report to PATH (default: stdout)
  --json PATH               Also write the derived report as JSON
  --help                    Show this help

The report is derived from the observation files alone. It exits non-zero when a Gate 4 bar in
ADR 0056 is not met.`;

/** Gate 4 of ADR 0056 states each bar. They are repeated here so the report can check itself. */
const REQUIRED_CONSECUTIVE_DAYS = 30;
const REQUIRED_ROLLOVERS = 30;
const REQUIRED_RETENTION_PASSES = 1;
const REQUIRED_CLEAN_KILLS = 1;
const REQUIRED_MIGRATIONS = 2;

export interface RetentionPass {
  observedAt: string;
  previousObservedAt: string;
  /** Days whose partition was present in the previous observation and gone in this one. */
  dropped: { parent: HistoryParent; day: string }[];
  retainedBeforeFrom: string | null;
  retainedBeforeTo: string | null;
}

export interface Reinstall {
  observedAt: string;
  previousObservedAt: string;
  previousBaselineAppliedAt: string | null;
  baselineAppliedAt: string | null;
}

export interface ThroughputTotals {
  enqueued: number;
  jobSucceeded: number;
  jobFailed: number;
  jobCanceled: number;
  attemptSucceeded: number;
  attemptFailed: number;
  attemptRetry: number;
  attemptLeaseExpired: number;
  attemptCanceled: number;
  attemptOther: number;
}

export interface GateCheck {
  bar: string;
  observed: string;
  met: boolean;
}

export interface SoakReport {
  generatedAt: string;
  observations: number;
  database: string;
  window: { start: string; end: string; spanDays: number };
  coverage: { observedDays: string[]; longestConsecutiveDays: number; gapDays: string[] };
  installation: {
    baselineAppliedAt: string | null;
    reinstalls: Reinstall[];
    schemaVersionAtStart: number | null;
    schemaVersionAtEnd: number | null;
    migrationsAppliedInWindow: MigrationRecord[];
  };
  partitions: {
    rolloverDays: string[];
    oldestSurvivingAgeDays: { minimum: number | null; maximum: number | null };
  };
  retention: {
    passes: RetentionPass[];
    passesThatDroppedAPartition: number;
    droppedDays: string[];
  };
  throughput: {
    days: ThroughputDay[];
    totals: ThroughputTotals;
    /** Days two observations reported differently. A closed day is immutable, so this stays empty. */
    disagreements: string[];
  };
  reconciliation: {
    enqueued: number;
    settled: number;
    residual: number;
    backlogAtStart: number;
    backlogAtEnd: number;
  };
  kills: (KillRecovery & { clean: boolean })[];
  queueHealth: { start: unknown; end: unknown };
  gate: GateCheck[];
  met: boolean;
}

/**
 * A kill is recovered when the database can show it happened and show nothing went wrong with it.
 *
 * All three clauses matter. No expired lease means the kill left no trace to reconcile, so the
 * record proves nothing; a lost job means recovery dropped work; a job with two succeeded attempts
 * means recovery ran work twice.
 */
function killRecovered(kill: KillRecovery): boolean {
  return (
    kill.leaseExpiredAttempts > 0 && kill.jobsLost === 0 && kill.jobsSucceededMoreThanOnce === 0
  );
}

/** Reports read badly enough without "1 days" in them. */
function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function utcDay(instant: string): string {
  return instant.slice(0, 10);
}

function addDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Every day between two days inclusive, so a gap can be named rather than counted. */
function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDay(day, 1)) days.push(day);
  return days;
}

function partitionDays(observation: SoakObservation, parent: HistoryParent): Set<string> {
  return new Set(
    observation.partitions.parents.find((entry) => entry.parent === parent)?.days ?? [],
  );
}

function baselineAppliedAt(observation: SoakObservation): string | null {
  return observation.installation.migrations.find((row) => row.version === 1)?.appliedAt ?? null;
}

function liveBacklog(observation: SoakObservation): number {
  return Object.values(observation.backlog).reduce((total, jobs) => total + jobs, 0);
}

const MEASURES = [
  "enqueued",
  "jobSucceeded",
  "jobFailed",
  "jobCanceled",
  "attemptSucceeded",
  "attemptFailed",
  "attemptRetry",
  "attemptLeaseExpired",
  "attemptCanceled",
  "attemptOther",
] as const satisfies readonly (keyof ThroughputTotals)[];

/** Read every observation file in a directory, oldest observation first. */
export async function readObservations(directory: string): Promise<SoakObservation[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name));
  const observations = await Promise.all(
    files.map(async (file) => {
      const observation = JSON.parse(await readFile(file, "utf8")) as SoakObservation;
      if (observation.format !== OBSERVATION_FORMAT) {
        throw new Error(
          `${file} is observation format ${String(observation.format)}; this report reads ${String(OBSERVATION_FORMAT)}`,
        );
      }
      return observation;
    }),
  );
  return observations.toSorted((left, right) => left.observedAt.localeCompare(right.observedAt));
}

export function buildSoakReport(observations: SoakObservation[]): SoakReport {
  const generatedAt = new Date().toISOString();
  if (observations.length === 0) {
    throw new Error("A soak report needs at least one observation.");
  }
  const first = observations[0]!;
  const last = observations.at(-1)!;
  const firstDay = utcDay(first.observedAt);
  const lastDay = utcDay(last.observedAt);

  const observedDays = [
    ...new Set(observations.map((entry) => utcDay(entry.observedAt))),
  ].toSorted();
  const gapDays = daysBetween(firstDay, lastDay).filter((day) => !observedDays.includes(day));
  let longestConsecutiveDays = 0;
  let run = 0;
  for (const day of daysBetween(firstDay, lastDay)) {
    run = observedDays.includes(day) ? run + 1 : 0;
    longestConsecutiveDays = Math.max(longestConsecutiveDays, run);
  }

  // A day rolled over when a partition for it existed and the day had begun. Partitions are
  // created three days ahead, so days past the last observation are prepared rather than rolled.
  const rolloverDays = [
    ...new Set(
      observations.flatMap((observation) =>
        observation.partitions.parents.flatMap((entry) => entry.days),
      ),
    ),
  ]
    .filter((day) => day >= firstDay && day <= lastDay)
    .toSorted();

  const passes: RetentionPass[] = [];
  const reinstalls: Reinstall[] = [];
  for (const [index, observation] of observations.entries()) {
    if (index === 0) continue;
    const previous = observations[index - 1]!;
    const dropped = HISTORY_PARENTS.flatMap((parent) => {
      const before = partitionDays(previous, parent);
      const after = partitionDays(observation, parent);
      return [...before]
        .filter((day) => !after.has(day) && day <= utcDay(previous.observedAt))
        .toSorted()
        .map((day) => ({ parent, day }));
    });
    const retainedBeforeFrom = previous.retention.historyRetainedBefore;
    const retainedBeforeTo = observation.retention.historyRetainedBefore;
    if (dropped.length > 0 || retainedBeforeFrom !== retainedBeforeTo) {
      passes.push({
        observedAt: observation.observedAt,
        previousObservedAt: previous.observedAt,
        dropped,
        retainedBeforeFrom,
        retainedBeforeTo,
      });
    }
    // The migration ledger only ever grows. A baseline row with a new timestamp is a new database.
    if (baselineAppliedAt(previous) !== baselineAppliedAt(observation)) {
      reinstalls.push({
        observedAt: observation.observedAt,
        previousObservedAt: previous.observedAt,
        previousBaselineAppliedAt: baselineAppliedAt(previous),
        baselineAppliedAt: baselineAppliedAt(observation),
      });
    }
  }
  const droppedDays = [
    ...new Set(passes.flatMap((pass) => pass.dropped.map((entry) => entry.day))),
  ].toSorted();

  const merged = new Map<string, ThroughputDay>();
  const disagreements = new Set<string>();
  for (const observation of observations) {
    for (const day of observation.throughput) {
      if (day.day < firstDay || day.day > lastDay) continue;
      const seen = merged.get(day.day);
      if (seen !== undefined && MEASURES.some((measure) => seen[measure] !== day[measure])) {
        disagreements.add(day.day);
      }
      merged.set(day.day, day);
    }
  }
  const days = [...merged.values()].toSorted((left, right) => left.day.localeCompare(right.day));
  const totals = Object.fromEntries(
    MEASURES.map((measure) => [measure, days.reduce((sum, day) => sum + day[measure], 0)]),
  ) as unknown as ThroughputTotals;

  const kills = observations
    .map((observation) => observation.killRecovery)
    .filter((kill): kill is KillRecovery => kill !== undefined)
    .map((kill) => Object.assign({}, kill, { clean: killRecovered(kill) }));

  const migrationsAppliedInWindow = last.installation.migrations.filter(
    (migration) => migration.version > 1 && migration.appliedAt >= first.observedAt,
  );
  const settled = totals.jobSucceeded + totals.jobFailed + totals.jobCanceled;
  const spanDays = Math.floor(
    (Date.parse(last.observedAt) - Date.parse(first.observedAt)) / 86_400_000,
  );

  const passesThatDropped = passes.filter((pass) => pass.dropped.length > 0).length;
  const cleanKills = kills.filter((kill) => kill.clean).length;
  const gate: GateCheck[] = [
    {
      bar: `${String(REQUIRED_CONSECUTIVE_DAYS)} consecutive observed days`,
      observed: `${plural(longestConsecutiveDays, "consecutive day")} across a ${String(spanDays)}-day span`,
      met: longestConsecutiveDays >= REQUIRED_CONSECUTIVE_DAYS,
    },
    {
      bar: `${String(REQUIRED_ROLLOVERS)} daily partition rollovers`,
      observed: `${plural(rolloverDays.length, "day")} held a partition`,
      met: rolloverDays.length >= REQUIRED_ROLLOVERS,
    },
    {
      bar: `${String(REQUIRED_RETENTION_PASSES)} retention pass that dropped a partition`,
      observed: `${String(passesThatDropped)} of ${String(passes.length)} retention movements dropped ${plural(droppedDays.length, "day")}`,
      met: passesThatDropped >= REQUIRED_RETENTION_PASSES,
    },
    {
      bar: `${String(REQUIRED_CLEAN_KILLS)} ungraceful kill recovered with no lost or duplicated job`,
      observed: `${String(cleanKills)} clean of ${String(kills.length)} recorded`,
      met: cleanKills >= REQUIRED_CLEAN_KILLS,
    },
    {
      bar: "the database was never reinstalled",
      observed:
        reinstalls.length === 0
          ? `one installation, baseline applied ${baselineAppliedAt(last) ?? "at an unknown time"}`
          : `${plural(reinstalls.length, "reinstall")} observed`,
      met: reinstalls.length === 0,
    },
    {
      bar: `carried across ${String(REQUIRED_MIGRATIONS)} releases by migration`,
      observed: `${plural(migrationsAppliedInWindow.length, "migration")} applied inside the window`,
      met: migrationsAppliedInWindow.length >= REQUIRED_MIGRATIONS,
    },
  ];

  const ages = observations
    .map((observation) => observation.partitions.oldestSurvivingAgeDays)
    .filter((age): age is number => age !== null);

  return {
    generatedAt,
    observations: observations.length,
    database: last.database.name,
    window: { start: first.observedAt, end: last.observedAt, spanDays },
    coverage: { observedDays, longestConsecutiveDays, gapDays },
    installation: {
      baselineAppliedAt: baselineAppliedAt(last),
      reinstalls,
      schemaVersionAtStart: first.installation.schemaVersion,
      schemaVersionAtEnd: last.installation.schemaVersion,
      migrationsAppliedInWindow,
    },
    partitions: {
      rolloverDays,
      oldestSurvivingAgeDays: {
        minimum: ages.length === 0 ? null : Math.min(...ages),
        maximum: ages.length === 0 ? null : Math.max(...ages),
      },
    },
    retention: {
      passes,
      passesThatDroppedAPartition: passesThatDropped,
      droppedDays,
    },
    throughput: { days, totals, disagreements: [...disagreements].toSorted() },
    reconciliation: {
      enqueued: totals.enqueued,
      settled,
      residual: totals.enqueued - settled,
      backlogAtStart: liveBacklog(first),
      backlogAtEnd: liveBacklog(last),
    },
    kills,
    queueHealth: { start: first.queueHealth, end: last.queueHealth },
    gate,
    met: gate.every((check) => check.met),
  };
}

function table(header: string[], rows: string[][]): string {
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
  return `${lines.join("\n")}\n`;
}

function healthLine(document: unknown): string {
  const snapshot = document as {
    captured_at?: string;
    status?: { level?: string; reasons?: { code?: string }[] };
  } | null;
  const reasons = (snapshot?.status?.reasons ?? []).map((reason) => reason.code ?? "?");
  const level = snapshot?.status?.level ?? "unknown";
  return `${level} at ${snapshot?.captured_at ?? "an unrecorded time"}${reasons.length === 0 ? "" : ` (${reasons.join(", ")})`}`;
}

export function renderSoakReport(report: SoakReport): string {
  const sections: string[] = [];
  sections.push(`# Workhorse soak report\n`);
  sections.push(
    `Derived from ${plural(report.observations, "observation")} of \`${report.database}\` by \`pnpm soak:report\` on ${report.generatedAt}. ` +
      `Every number below comes from the observation files and can be recomputed from them.\n`,
  );

  sections.push(`## Gate 4\n`);
  sections.push(
    table(
      ["Bar", "Observed", "Met"],
      report.gate.map((check) => [check.bar, check.observed, check.met ? "yes" : "no"]),
    ),
  );

  sections.push(`## Window\n`);
  sections.push(
    table(
      ["Fact", "Value"],
      [
        ["First observation", report.window.start],
        ["Last observation", report.window.end],
        ["Span", plural(report.window.spanDays, "day")],
        ["Days observed", String(report.coverage.observedDays.length)],
        ["Longest consecutive run", plural(report.coverage.longestConsecutiveDays, "day")],
        [
          "Days with no observation",
          report.coverage.gapDays.length === 0 ? "none" : report.coverage.gapDays.join(", "),
        ],
      ],
    ),
  );

  sections.push(`## Installation continuity\n`);
  sections.push(
    table(
      ["Fact", "Value"],
      [
        ["Baseline applied at", report.installation.baselineAppliedAt ?? "unknown"],
        ["Reinstalls observed", String(report.installation.reinstalls.length)],
        ["Schema version at the start", String(report.installation.schemaVersionAtStart)],
        ["Schema version at the end", String(report.installation.schemaVersionAtEnd)],
        [
          "Migrations applied in the window",
          String(report.installation.migrationsAppliedInWindow.length),
        ],
      ],
    ),
  );
  if (report.installation.migrationsAppliedInWindow.length > 0) {
    sections.push(
      table(
        ["Version", "Description", "Applied at"],
        report.installation.migrationsAppliedInWindow.map((migration) => [
          String(migration.version),
          migration.description,
          migration.appliedAt,
        ]),
      ),
    );
  }

  sections.push(`## Partition rollovers\n`);
  sections.push(
    `${plural(report.partitions.rolloverDays.length, "day")} inside the window held a daily history partition. ` +
      `The oldest surviving partition was between ${String(report.partitions.oldestSurvivingAgeDays.minimum)} and ${String(report.partitions.oldestSurvivingAgeDays.maximum)} days old across the window.\n`,
  );

  sections.push(`## Retention passes\n`);
  sections.push(
    `${String(report.retention.passesThatDroppedAPartition)} of ${plural(report.retention.passes.length, "observed retention movement")} dropped a partition, ` +
      `retiring ${plural(report.retention.droppedDays.length, "day")} in total.\n`,
  );
  if (report.retention.passes.length > 0) {
    sections.push(
      table(
        ["Observed at", "Dropped", "Retained before"],
        report.retention.passes.map((pass) => [
          pass.observedAt,
          pass.dropped.length === 0
            ? "nothing"
            : pass.dropped.map((entry) => `${entry.parent} ${entry.day}`).join(", "),
          `${pass.retainedBeforeFrom ?? "unset"} to ${pass.retainedBeforeTo ?? "unset"}`,
        ]),
      ),
    );
  }

  sections.push(`## Throughput and failures\n`);
  sections.push(
    table(
      ["Measure", "Total"],
      MEASURES.map((measure) => [measure, String(report.throughput.totals[measure])]),
    ),
  );
  if (report.throughput.disagreements.length > 0) {
    sections.push(
      `Two observations disagreed about these closed days, which should not happen: ${report.throughput.disagreements.join(", ")}.\n`,
    );
  }
  sections.push(
    table(
      ["Day", "Enqueued", "Succeeded", "Failed", "Canceled", "Lease expired"],
      report.throughput.days.map((day) => [
        day.day,
        String(day.enqueued),
        String(day.jobSucceeded),
        String(day.jobFailed),
        String(day.jobCanceled),
        String(day.attemptLeaseExpired),
      ]),
    ),
  );

  sections.push(`## Enqueued against settled\n`);
  sections.push(
    `${String(report.reconciliation.enqueued)} jobs were enqueued in the window and ${String(report.reconciliation.settled)} reached a terminal state, ` +
      `a residual of ${String(report.reconciliation.residual)}. The live backlog moved from ${String(report.reconciliation.backlogAtStart)} to ${String(report.reconciliation.backlogAtEnd)} jobs. ` +
      `Work that crosses either edge of the window is counted on one side only, so the residual is context rather than a verdict; the kill reconciliations below are the proof that no job was lost or run twice.\n`,
  );

  sections.push(`## Ungraceful kills\n`);
  if (report.kills.length === 0) {
    sections.push(`No kill was reconciled. Gate 4 requires at least one.\n`);
  } else {
    sections.push(
      table(
        [
          "Worker",
          "Killed at",
          "Lease-expired attempts",
          "Jobs affected",
          "Settled",
          "Live",
          "Lost",
          "Succeeded twice",
          "Clean",
        ],
        report.kills.map((kill) => [
          kill.workerId,
          kill.killedAt,
          String(kill.leaseExpiredAttempts),
          String(kill.affectedJobs),
          String(kill.jobsSettled),
          String(kill.jobsLive),
          String(kill.jobsLost),
          String(kill.jobsSucceededMoreThanOnce),
          kill.clean ? "yes" : "no",
        ]),
      ),
    );
  }

  sections.push(`## Queue health at each end\n`);
  sections.push(
    `Gate 4 asks for a queue-health snapshot at each end of the window. Both documents are recorded whole in the JSON beside this report; the states are:\n`,
  );
  sections.push(
    table(
      ["End", "Health"],
      [
        ["Start", healthLine(report.queueHealth.start)],
        ["End", healthLine(report.queueHealth.end)],
      ],
    ),
  );

  return `${sections.join("\n")}`;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

if (import.meta.filename === process.argv[1]) {
  if (process.argv.includes("--help")) {
    process.stdout.write(`${help}\n`);
  } else {
    const directory = argument("--observations");
    if (directory === undefined) throw new Error("--observations is required");
    const report = buildSoakReport(await readObservations(path.resolve(directory)));
    const markdown = renderSoakReport(report);
    const output = argument("--output");
    if (output === undefined) {
      process.stdout.write(markdown);
    } else {
      await mkdir(path.dirname(path.resolve(output)), { recursive: true });
      await writeFile(path.resolve(output), markdown);
      process.stderr.write(`Wrote ${path.resolve(output)}\n`);
    }
    const json = argument("--json");
    if (json !== undefined) {
      await mkdir(path.dirname(path.resolve(json)), { recursive: true });
      await writeFile(path.resolve(json), `${JSON.stringify(report, null, 2)}\n`);
      process.stderr.write(`Wrote ${path.resolve(json)}\n`);
    }
    if (!report.met) process.exitCode = 1;
  }
}
