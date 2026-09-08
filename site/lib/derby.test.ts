import { describe, expect, it } from "vitest";

import {
  createHorses,
  createRace,
  DERBY_TUNING,
  raceStandings,
  runRaceToEnd,
  stepRace,
} from "./derby";

describe("Derby standings", () => {
  it("shares places for tied horses without rearranging their track lanes", () => {
    const horses = createHorses();
    const progress = [40, 75, 75, 20];
    horses.forEach((horse, index) => {
      horse.jobsDone = progress[index]!;
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
          const threshold = Math.ceil((horse.jobsTotal * percent) / 100);
          const crossed = previous.jobsDone < threshold && horse.jobsDone >= threshold;
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
        (line) => line.text === `wal-runner resumed after ${status} — processing jobs again`,
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
