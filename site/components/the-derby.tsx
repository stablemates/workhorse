import { useEffect, useRef, useState } from "react";

import {
  createHorses,
  createRace,
  DERBY_TUNING,
  formatRaceClock,
  type HorseState,
  type HorseStatus,
  type LogLine,
  type RaceState,
  runRaceToEnd,
  stepRace,
} from "@/lib/derby";

/*
 * The Derby, framed as one more dashboard readout. Alongside the
 * DemoCarousel, this is the only stateful component on the landing page.
 * Rendering is hydration-safe: the initial state is constant, and every
 * random draw happens inside the Start click handler.
 */

type Phase = "pick" | "running" | "done";

/*
 * The bar stretches to fill each lane, but stays quantized to whole monospace
 * cells: a ruler span measures the cell width, and the bar renders exactly as
 * many characters as fit. The server renders the default; the first client
 * measurement adjusts it.
 */
const DEFAULT_BAR_CELLS = 28;
const MIN_BAR_CELLS = 12;
const RULER_CELLS = 10;

const statusLabel: Record<HorseStatus, string> = {
  ready: "ready",
  running: "running",
  backoff: "backoff",
  throttled: "throttled",
  "dead-letter": "dead_letter",
  drained: "drained",
};

/* Tone classes follow landing-diagrams.tsx: signal-* for failures and
 * throttling, safety-* for healthy outcomes, muted otherwise. Plain text, not
 * a bordered pill: only the lanes are clickable, and status must not look it. */
const statusTone: Record<HorseStatus, string> = {
  ready: "text-fd-muted-foreground",
  running: "text-fd-muted-foreground",
  backoff: "text-signal-600 dark:text-signal-400",
  throttled: "text-signal-600 dark:text-signal-400",
  "dead-letter": "text-signal-600 dark:text-signal-400",
  drained: "text-safety-600 dark:text-safety-400",
};

/* Racing silks: one hue per horse, on its mark and its bar fill. These hues
 * sit outside the site's signal/safety semantics on purpose — they mark
 * identity, not health, so no lane looks permanently alarmed or victorious. */
const silks: Record<string, string> = {
  "wal-runner": "text-amber-600 dark:text-amber-400",
  "foal-tolerant": "text-sky-600 dark:text-sky-400",
  "hot-standby": "text-rose-600 dark:text-rose-400",
  "furlong-poll": "text-violet-600 dark:text-violet-400",
};

const logTone: Record<LogLine["tone"], string> = {
  alert: "text-signal-600 dark:text-signal-400",
  good: "text-safety-600 dark:text-safety-400",
  muted: "text-fd-muted-foreground",
};

/**
 * The Workhorse brand mark, inlined from site/public/brand/workhorse-mark.svg
 * with its silver gradient swapped for currentColor so each lane can tint it
 * in that horse's silk. The viewBox crops the artwork's transparent padding.
 */
function HorseIcon() {
  return (
    <svg viewBox="77 102 359 305" fill="currentColor" aria-hidden className="h-5 w-6">
      <path
        d="M0,0 L0,3 L-14,22 L-26,39 L-34,51 L-25,53 L-12,68 L-3,79 L8,92 L23,120 L37,144 L48,163 L48,195 L43,203 L38,201 L25,178 L23,175 L32,203 L10,203 L-9,175 L-19,170 L-60,153 L-64,151 L-76,129 L-80,123 L-81,123 L-88,176 L-88,184 L-54,285 L-49,300 L-51,300 L-56,292 L-69,276 L-83,259 L-94,246 L-105,232 L-115,221 L-124,210 L-134,199 L-143,188 L-157,173 L-164,165 L-170,158 L-172,157 L-170,153 L-161,144 L-153,137 L-139,123 L-131,116 L-123,108 L-115,101 L-105,91 L-99,86 L-94,81 L-78,69 L-62,57 L-117,72 L-165,84 L-186,89 L-189,88 L-162,72 L-137,57 L-112,42 L-56,34 L-47,29 L-19,12 L-1,1 Z M-32,93 L-30,97 L-23,108 L-18,115 L-12,116 L12,117 L7,113 L-8,103 L-29,94 Z"
        transform="translate(388,102)"
      />
      <path
        d="M0,0 L2,1 L-18,21 L-26,28 L-39,41 L-47,48 L-59,60 L-67,67 L-73,72 L-108,89 L-136,102 L-172,119 L-185,125 L-190,127 L-185,122 L-175,113 L-164,104 L-154,95 L-143,86 L-131,75 L-120,66 L-107,54 L-99,47 L-89,38 L-84,34 L-47,19 L-10,4 Z"
        transform="translate(267,183)"
      />
      <path
        d="M0,0 L4,2 L25,23 L33,30 L114,111 L116,112 L116,114 L120,116 L134,130 L141,136 L138,136 L122,126 L104,116 L81,103 L57,90 L34,77 L11,65 L-11,53 L-37,39 L-52,31 L-52,29 L-28,16 L-5,3 Z"
        transform="translate(195,271)"
      />
    </svg>
  );
}

function StatusChip({ status }: { status: HorseStatus }) {
  return (
    <span
      className={`inline-block w-[4.5rem] text-right font-mono text-[10.5px] leading-relaxed tracking-tight ${statusTone[status]}`}
    >
      {statusLabel[status]}
    </span>
  );
}

function Lane({
  horse,
  picked,
  disabled,
  barCells,
  onPick,
}: {
  horse: HorseState;
  picked: boolean;
  disabled: boolean;
  barCells: number;
  onPick: () => void;
}) {
  const filled = Math.round((horse.jobsDone / horse.jobsTotal) * barCells);
  const percent = Math.round((horse.jobsDone / horse.jobsTotal) * 100);
  const silk = silks[horse.id] ?? "text-fd-foreground/70";
  return (
    <label
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-l-2 px-4 py-2.5 transition-colors ${
        picked ? "border-(--wh-accent) bg-fd-muted/60" : "border-transparent"
      } ${disabled ? "" : "cursor-pointer hover:bg-fd-muted/30"} has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-(--color-fd-ring) has-[:focus-visible]:-outline-offset-2`}
    >
      <input
        type="radio"
        name="derby-horse"
        value={horse.id}
        checked={picked}
        disabled={disabled}
        onChange={onPick}
        className="sr-only"
      />
      <span aria-hidden className={`flex w-7 shrink-0 justify-center ${silk}`}>
        <HorseIcon />
      </span>
      <span className="w-28 shrink-0 font-mono text-[13px] font-medium tracking-tight">
        {horse.id}
      </span>
      <span
        data-derby-track
        className="relative min-w-[7rem] flex-1 overflow-hidden whitespace-nowrap font-mono text-[13px] leading-none"
      >
        <span aria-hidden>
          <span className={picked ? "text-(--wh-accent)" : "text-fd-foreground/70"}>
            {"█".repeat(filled)}
          </span>
          <span className="text-fd-muted-foreground/40">{"░".repeat(barCells - filled)}</span>
        </span>
        <span data-derby-ruler aria-hidden className="invisible absolute left-0 top-0">
          {"█".repeat(RULER_CELLS)}
        </span>
      </span>
      <span className="sr-only">
        {horse.id}: {percent} percent drained
      </span>
      {/* ml-auto pins the readout to the frame edge, so each lane spans the row. */}
      <span className="ml-auto flex items-center gap-3">
        <span className="font-mono text-[11px] text-fd-muted-foreground">
          q {String(horse.jobsDone).padStart(3, "0")}/{horse.jobsTotal}
        </span>
        <StatusChip status={horse.status} />
      </span>
    </label>
  );
}

function RaceLog({ log }: { log: readonly LogLine[] }) {
  const lines = log.slice(-6);
  return (
    /* min-h fits six lines exactly, so the frame stays put while the log fills. */
    <ol className="min-h-[9.75rem] space-y-1 border-t wh-rule px-4 py-3 font-mono text-[11.5px] leading-relaxed">
      {lines.map((line) => (
        <li key={`${line.t}-${line.text}`} className={logTone[line.tone]}>
          <span className="text-fd-muted-foreground/70">{formatRaceClock(line.t)}</span> {line.text}
        </li>
      ))}
    </ol>
  );
}

export function TheDerby() {
  const [phase, setPhase] = useState<Phase>("pick");
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [race, setRace] = useState<RaceState | null>(null);
  const [barCells, setBarCells] = useState(DEFAULT_BAR_CELLS);
  const intervalRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const stopTicking = () => {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  useEffect(() => stopTicking, []);

  /* Fit the bar to the lane: every lane's track has the same width, so the
   * first one is measured against its ruler and observed for resizes. The
   * ruler is observed too — its width changes when the mono font swaps in,
   * which resizes glyphs without resizing the track. */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const track = root.querySelector<HTMLElement>("[data-derby-track]");
    const ruler = root.querySelector<HTMLElement>("[data-derby-ruler]");
    if (!track || !ruler) return;
    const measure = () => {
      const cellWidth = ruler.getBoundingClientRect().width / RULER_CELLS;
      if (cellWidth <= 0) return;
      setBarCells(
        Math.max(MIN_BAR_CELLS, Math.floor(track.getBoundingClientRect().width / cellWidth)),
      );
    };
    measure();
    document.fonts.ready.then(measure).catch(() => {});
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    observer.observe(ruler);
    return () => observer.disconnect();
  }, []);

  const winnerId = race?.winnerId ?? null;
  useEffect(() => {
    if (phase === "running" && winnerId) {
      stopTicking();
      setPhase("done");
    }
  }, [phase, winnerId]);

  const start = () => {
    if (!pickedId) return;
    const seed = Date.now() & 0xffffffff;
    const initial = createRace(seed);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setRace(runRaceToEnd(initial));
      setPhase("done");
      return;
    }
    setRace(initial);
    setPhase("running");
    intervalRef.current = window.setInterval(() => {
      setRace((previous) => (previous ? stepRace(previous) : previous));
    }, DERBY_TUNING.tickMs);
  };

  const reset = () => {
    setRace(null);
    setPhase("pick");
  };

  const horses = race?.horses ?? createHorses();
  /* The simulation never learns the visitor's pick (that is what keeps the
   * race fair), so the victory lap is appended here, outside the sim. */
  const log: readonly LogLine[] =
    race && phase === "done" && winnerId === pickedId
      ? [
          ...race.log,
          {
            t: race.tick + 2,
            text: `oats enqueued for ${winnerId} — at-least-once delivery; he won't mind duplicates`,
            tone: "good",
          },
        ]
      : (race?.log ?? []);
  const title =
    phase === "pick"
      ? "derby — pick a horse"
      : phase === "running"
        ? "derby — race in progress"
        : "derby — result";

  let statusLine: string;
  let statusClass = "text-fd-muted-foreground";
  if (phase === "pick") {
    statusLine = pickedId ? `${pickedId} at the gate — start when ready` : "pick a horse to enter";
  } else if (phase === "running") {
    statusLine = `racing — ${formatRaceClock(race?.tick ?? 0)}`;
  } else if (winnerId === pickedId) {
    statusLine = `${winnerId} wins — your pick paid out`;
    statusClass = "text-safety-600 dark:text-safety-400";
  } else {
    statusLine = `${winnerId} wins — you backed ${pickedId}`;
  }

  return (
    <div ref={rootRef} className="wh-frame min-w-0">
      <div className="wh-frame-bar px-4 py-2">
        <span className="wh-mono-label">{title}</span>
      </div>
      <fieldset disabled={phase !== "pick"} className="m-0 min-w-0 border-0 p-0">
        <legend className="sr-only">Pick a horse to back in the race</legend>
        <div className="flex flex-col py-1.5">
          {horses.map((horse) => (
            <Lane
              key={horse.id}
              horse={horse}
              picked={pickedId === horse.id}
              disabled={phase !== "pick"}
              barCells={barCells}
              onPick={() => setPickedId(horse.id)}
            />
          ))}
        </div>
      </fieldset>
      {/* No log before the first start: an empty reserved block reads as dead space. */}
      {race ? <RaceLog log={log} /> : null}
      <div className="wh-frame-bar flex flex-wrap items-center justify-between gap-2 border-t wh-rule px-4 py-2">
        <span role="status" aria-live="polite" className={`font-mono text-xs ${statusClass}`}>
          {statusLine}
        </span>
        <button
          type="button"
          onClick={phase === "done" ? reset : start}
          disabled={phase === "running" || (phase === "pick" && !pickedId)}
          className="inline-flex items-center rounded-sm border wh-rule px-3 py-1 font-mono text-xs text-fd-muted-foreground transition-colors hover:border-(--wh-accent) hover:text-fd-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          {phase === "done" ? "Run again" : "Start"}
        </button>
      </div>
    </div>
  );
}
