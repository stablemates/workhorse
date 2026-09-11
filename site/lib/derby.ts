/*
 * The Derby: a deterministic terminal horse race for the landing page. Each
 * lane is a worker draining a task queue, and the scripted incidents (retry
 * backoff, a throttle window, one dead-letter with a redrive) recap real
 * product mechanics. Pure data and transitions: no React, no `window`, no
 * wall clock. Every random draw advances `prngState` inside `RaceState`, so
 * a race is fully determined by its seed and can be replayed.
 */

export type HorseStatus = "ready" | "running" | "backoff" | "throttled" | "dead-letter" | "drained";

export interface HorseState {
  id: string;
  tasksDone: number;
  tasksTotal: number;
  status: HorseStatus;
  stallTicksLeft: number;
  attempt: number;
}

type LogTone = "alert" | "good" | "muted";

export interface LogLine {
  /** Race clock in ticks, never wall clock, so replays and SSR stay stable. */
  t: number;
  text: string;
  tone: LogTone;
}

interface ThrottleEvent {
  startTick: number;
  durationTicks: number;
  horseIds: readonly string[];
  fired: boolean;
  released: boolean;
}

interface DeadLetterEvent {
  startTick: number;
  stallTicks: number;
  horseId: string;
  taskNumber: string;
  fired: boolean;
}

export interface RaceState {
  tick: number;
  prngState: number;
  horses: HorseState[];
  log: LogLine[];
  winnerId: string | null;
  throttle: ThrottleEvent;
  deadLetter: DeadLetterEvent;
}

/*
 * Four starters with identical stats; the win is an honest ~1 in 4.
 * On the bench: checkpoint-charlie, neigh-base, crash-test-mare.
 */
const DERBY_HORSES = ["wal-runner", "foal-tolerant", "hot-standby", "furlong-poll"] as const;

export const DERBY_TUNING = {
  tasksTotal: 120,
  /** UI tick interval; 120ms reads as a live readout, not an animation. */
  tickMs: 120,
  /** The race clock runs at a nominal 8 ticks per second. */
  ticksPerSecond: 8,
  /** Chance a running horse completes 2 tasks instead of 1 (mean ~1.15/tick). */
  doubleTaskChance: 0.15,
  /** Chance per running tick of a retry stall. */
  stallChance: 0.012,
  backoffMinTicks: 6,
  backoffMaxTicks: 14,
  throttleEarliestTick: 16,
  throttleLatestTick: 46,
  throttleDurationTicks: 10,
  deadLetterEarliestTick: 20,
  deadLetterLatestTick: 54,
  deadLetterStallTicks: 18,
  /** Guard for `runRaceToEnd`; a healthy race finishes near 110 ticks. */
  maxTicks: 400,
} as const;

/** mulberry32: a tiny seeded PRNG. Returns the draw and the advanced state. */
function mulberry32(state: number): { value: number; state: number } {
  const next = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(next ^ (next >>> 15), 1 | next);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296, state: next };
}

/** Format a tick on the race clock, e.g. `t+04.2`. */
export function formatRaceClock(tick: number): string {
  const seconds = tick / DERBY_TUNING.ticksPerSecond;
  return `t+${seconds.toFixed(1).padStart(4, "0")}`;
}

function formatSeconds(ticks: number): string {
  return `${(ticks / DERBY_TUNING.ticksPerSecond).toFixed(1)}s`;
}

/** The constant pre-race field: every lane ready at zero. */
export function createHorses(): HorseState[] {
  return DERBY_HORSES.map((id) => ({
    id,
    tasksDone: 0,
    tasksTotal: DERBY_TUNING.tasksTotal,
    status: "ready" as const,
    stallTicksLeft: 0,
    attempt: 0,
  }));
}

/** Shared places for ties; keep lanes in their original order on the track. */
export function raceStandings(horses: readonly HorseState[]) {
  const ordered = horses.toSorted((a, b) => b.tasksDone - a.tasksDone);
  const leadingTasks = ordered[0]?.tasksDone ?? 0;
  return ordered.map((horse) => ({
    horse,
    rank: 1 + ordered.filter((other) => other.tasksDone > horse.tasksDone).length,
    behind: leadingTasks - horse.tasksDone,
  }));
}

export function createRace(seed: number): RaceState {
  let prngState = seed >>> 0;
  const rand = (): number => {
    const draw = mulberry32(prngState);
    prngState = draw.state;
    return draw.value;
  };

  const throttleStart =
    DERBY_TUNING.throttleEarliestTick +
    Math.floor(rand() * (DERBY_TUNING.throttleLatestTick - DERBY_TUNING.throttleEarliestTick));
  const firstThrottled = Math.floor(rand() * DERBY_HORSES.length);
  const secondThrottled =
    (firstThrottled + 1 + Math.floor(rand() * (DERBY_HORSES.length - 1))) % DERBY_HORSES.length;

  const deadLetterStart =
    DERBY_TUNING.deadLetterEarliestTick +
    Math.floor(rand() * (DERBY_TUNING.deadLetterLatestTick - DERBY_TUNING.deadLetterEarliestTick));
  const deadLetterHorse = Math.floor(rand() * DERBY_HORSES.length);
  const taskNumber = String(Math.floor(rand() * 10_000)).padStart(4, "0");

  const horses = createHorses();
  for (const horse of horses) horse.status = "running";

  return {
    tick: 0,
    prngState,
    horses,
    log: [
      {
        t: 0,
        text: `race started — ${DERBY_HORSES.length} workers × ${DERBY_TUNING.tasksTotal} tasks`,
        tone: "muted",
      },
    ],
    winnerId: null,
    throttle: {
      startTick: throttleStart,
      durationTicks: DERBY_TUNING.throttleDurationTicks,
      horseIds: [DERBY_HORSES[firstThrottled]!, DERBY_HORSES[secondThrottled]!],
      fired: false,
      released: false,
    },
    deadLetter: {
      startTick: deadLetterStart,
      stallTicks: DERBY_TUNING.deadLetterStallTicks,
      horseId: DERBY_HORSES[deadLetterHorse]!,
      taskNumber,
      fired: false,
    },
  };
}

/** One pure transition of the race. Returns the input unchanged once won. */
export function stepRace(state: RaceState): RaceState {
  if (state.winnerId) return state;

  let prngState = state.prngState;
  const rand = (): number => {
    const draw = mulberry32(prngState);
    prngState = draw.state;
    return draw.value;
  };

  const tick = state.tick + 1;
  const log = [...state.log];
  const throttle = { ...state.throttle };
  const deadLetter = { ...state.deadLetter };
  const horses = state.horses.map((horse) => ({ ...horse }));
  let winnerId: string | null = null;

  if (!throttle.fired && tick >= throttle.startTick) {
    throttle.fired = true;
    const waiting: string[] = [];
    for (const horse of horses) {
      if (!throttle.horseIds.includes(horse.id)) continue;
      if (horse.status !== "running" && horse.status !== "backoff") continue;
      horse.status = "throttled";
      horse.stallTicksLeft = throttle.durationTicks;
      waiting.push(horse.id);
    }
    log.push({
      t: tick,
      text: `throttle provider-api: 2 permits — ${waiting.join(", ")} waiting`,
      tone: "alert",
    });
  }

  if (!deadLetter.fired && tick >= deadLetter.startTick) {
    const horse = horses.find((candidate) => candidate.id === deadLetter.horseId);
    if (horse && horse.status !== "drained") {
      deadLetter.fired = true;
      horse.status = "dead-letter";
      horse.stallTicksLeft = deadLetter.stallTicks;
      log.push({
        t: tick,
        text: `${horse.id} task#${deadLetter.taskNumber} → dead_letter (attempts exhausted)`,
        tone: "alert",
      });
    }
  }

  for (const horse of horses) {
    if (horse.status === "drained") continue;

    if (
      horse.status === "backoff" ||
      horse.status === "throttled" ||
      horse.status === "dead-letter"
    ) {
      horse.stallTicksLeft -= 1;
      if (horse.stallTicksLeft > 0) continue;
      if (horse.status === "dead-letter") {
        log.push({
          t: tick,
          text: `redrive task#${deadLetter.taskNumber} actor=you reason="derby" — reinstated`,
          tone: "good",
        });
      } else if (horse.status === "throttled" && !throttle.released) {
        throttle.released = true;
        log.push({ t: tick, text: "throttle provider-api released — permits free", tone: "muted" });
      }
      if (horse.status === "backoff" || horse.status === "throttled") {
        log.push({
          t: tick,
          text: `${horse.id} resumed after ${horse.status} — processing tasks again`,
          tone: "good",
        });
      }
      horse.status = "running";
      horse.stallTicksLeft = 0;
      continue;
    }

    if (horse.status !== "running") continue;

    if (rand() < DERBY_TUNING.stallChance) {
      const stall =
        DERBY_TUNING.backoffMinTicks +
        Math.floor(rand() * (DERBY_TUNING.backoffMaxTicks - DERBY_TUNING.backoffMinTicks + 1));
      horse.attempt += 1;
      horse.status = "backoff";
      horse.stallTicksLeft = stall;
      const task = String(Math.floor(rand() * 10_000)).padStart(4, "0");
      log.push({
        t: tick,
        text: `${horse.id} task#${task} failed (attempt ${horse.attempt}) — retry in ${formatSeconds(stall)}`,
        tone: "alert",
      });
      continue;
    }

    const completed = 1 + (rand() < DERBY_TUNING.doubleTaskChance ? 1 : 0);
    const previousDone = horse.tasksDone;
    horse.tasksDone = Math.min(horse.tasksTotal, horse.tasksDone + completed);
    for (const percent of [25, 50, 75]) {
      const milestone = Math.ceil((horse.tasksTotal * percent) / 100);
      if (previousDone < milestone && horse.tasksDone >= milestone) {
        log.push({
          t: tick,
          text: `${horse.id} passed ${percent}% — ${horse.tasksDone}/${horse.tasksTotal} tasks completed`,
          tone: "muted",
        });
      }
    }
    if (horse.tasksDone >= horse.tasksTotal) {
      horse.status = "drained";
      winnerId = horse.id;
      log.push({
        t: tick,
        text: `${horse.id} drained ${horse.tasksTotal}/${horse.tasksTotal} — queue empty`,
        tone: "good",
      });
      break;
    }
  }

  return { tick, prngState, horses, log, winnerId, throttle, deadLetter };
}

/** Run a race to its finish in one call; the reduced-motion path. */
export function runRaceToEnd(state: RaceState): RaceState {
  let current = state;
  while (!current.winnerId && current.tick < DERBY_TUNING.maxTicks) {
    current = stepRace(current);
  }
  return current;
}
