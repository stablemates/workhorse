import { describe, expect, it } from "vitest";

import {
  createHorses,
  createRace,
  DERBY_TUNING,
  derbyStatus,
  formatRaceClock,
  raceStandings,
  runRaceToEnd,
  stepRace,
} from "./derby";

describe("Derby standings", () => {
  it("shares places for tied horses without rearranging their track lanes", () => {
    const horses = createHorses();
    const progress = [40, 75, 75, 20];
    horses.forEach((horse, index) => {
      horse.tasksDone = progress[index]!;
    });
    const original = structuredClone(horses);

    expect(
      raceStandings(horses).map(({ horse, rank, behind }) => [horse.id, rank, behind]),
    ).toEqual([
      ["foal-tolerant", 1, 0],
      ["hot-standby", 1, 0],
      ["wal-runner", 3, 35],
      ["furlong-poll", 4, 55],
    ]);
    expect(horses).toEqual(original);
  });

  it("starts every horse level and accepts an empty field", () => {
    expect(
      raceStandings(createHorses()).every(({ rank, behind }) => rank === 1 && behind === 0),
    ).toBe(true);
    expect(raceStandings([])).toEqual([]);
  });
});

describe("Derby replay", () => {
  it.each([1, 42, 2026, 4294967295])(
    "gives reduced-motion players the same result for seed %i",
    (seed) => {
      const initial = createRace(seed);
      const original = structuredClone(initial);
      let animated = initial;
      while (!animated.winnerId && animated.tick < DERBY_TUNING.maxTicks)
        animated = stepRace(animated);

      const instant = runRaceToEnd(initial);
      expect(instant).toEqual(animated);
      expect(initial).toEqual(original);
      expect(instant.winnerId).not.toBeNull();
      expect(raceStandings(instant.horses)[0]?.horse.id).toBe(instant.winnerId);
      expect(stepRace(instant)).toBe(instant);
    },
  );
});

describe("Derby event history", () => {
  it("records each crossed progress milestone once, including jumps over the boundary", () => {
    let race = createRace(42);
    while (!race.winnerId && race.tick < DERBY_TUNING.maxTicks) {
      const next = stepRace(race);
      const milestones = next.log
        .slice(race.log.length)
        .filter((line) => line.text.includes(" passed "));
      for (const horse of next.horses) {
        const previous = race.horses.find((entry) => entry.id === horse.id)!;
        for (const percent of [25, 50, 75]) {
          const threshold = Math.ceil((horse.tasksTotal * percent) / 100);
          const crossed = previous.tasksDone < threshold && horse.tasksDone >= threshold;
          expect(
            milestones.filter((line) => line.text.startsWith(`${horse.id} passed ${percent}%`)),
          ).toHaveLength(crossed ? 1 : 0);
        }
      }
      race = next;
    }
    expect(race.log[0]?.text).toContain("race started");
    expect(race.log.filter((line) => line.text.includes(" passed ")).length).toBeGreaterThan(6);
  });

  it.each(["backoff", "throttled"] as const)("records work resuming after %s expires", (status) => {
    const race = createRace(1);
    race.horses[0]!.status = status;
    race.horses[0]!.stallTicksLeft = 1;
    const next = stepRace(race);
    expect(next.horses[0]!.status).toBe("running");
    expect(
      next.log.some(
        (line) => line.text === `wal-runner resumed after ${status} — processing tasks again`,
      ),
    ).toBe(true);
    expect(
      stepRace(next).log.filter((line) => line.text.includes(`wal-runner resumed after ${status}`)),
    ).toHaveLength(1);
  });

  it.each([
    [1, "foal-tolerant", 110],
    [42, "furlong-poll", 106],
    [2026, "hot-standby", 102],
    [4294967295, "foal-tolerant", 103],
  ] as const)("preserves the existing outcome for seed %i", (seed, winner, tick) => {
    const race = runRaceToEnd(createRace(seed));
    expect(race.winnerId).toBe(winner);
    expect(race.tick).toBe(tick);
  });
});

/** The announcements a screen reader hears: one for each change of the live text. */
function announced(texts: readonly string[]) {
  return texts.filter((text, index) => text !== texts[index - 1]);
}

describe("Derby status announcements", () => {
  it("announces the race start and the result once each and keeps the clock out", () => {
    const pickedId = "wal-runner";
    let race = createRace(42);
    const live: string[] = [];
    const clocks: (string | null)[] = [];
    while (!race.winnerId && race.tick < DERBY_TUNING.maxTicks) {
      const status = derbyStatus({
        phase: "running",
        pickedId,
        winnerId: null,
        pickedRank: undefined,
        tick: race.tick,
      });
      live.push(status.announcement);
      clocks.push(status.clock);
      race = stepRace(race);
    }
    const rank = raceStandings(race.horses).find((entry) => entry.horse.id === pickedId)?.rank;
    const result = derbyStatus({
      phase: "done",
      pickedId,
      winnerId: race.winnerId,
      pickedRank: rank,
      tick: race.tick,
    });
    live.push(result.announcement);

    expect(clocks.length).toBeGreaterThan(50);
    expect(clocks).toEqual(clocks.map((_, tick) => formatRaceClock(tick)));
    expect(live.some((text) => /t\+\d/.test(text))).toBe(false);
    expect(announced(live)).toEqual(["racing", `furlong-poll wins — wal-runner finished #${rank}`]);
    expect(result.clock).toBeNull();
  });

  it("announces the result of a reduced-motion race once, with no clock", () => {
    const race = runRaceToEnd(createRace(1));
    const status = derbyStatus({
      phase: "done",
      pickedId: race.winnerId,
      winnerId: race.winnerId,
      pickedRank: 1,
      tick: race.tick,
    });
    expect(status).toEqual({
      announcement: "foal-tolerant wins — you picked the winner",
      clock: null,
      won: true,
    });
  });

  it("asks for a pick, then names the picked horse at the gate", () => {
    const pick = { phase: "pick", winnerId: null, pickedRank: undefined, tick: 0 } as const;
    expect(derbyStatus({ ...pick, pickedId: null }).announcement).toBe("pick a horse to enter");
    expect(derbyStatus({ ...pick, pickedId: "hot-standby" }).announcement).toBe(
      "hot-standby at the gate — start when ready",
    );
  });
});
