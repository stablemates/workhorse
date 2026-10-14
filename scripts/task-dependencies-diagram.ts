import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `docs/guides/160-task-dependencies.md`. They use the names of that guide. Both
 * use the same rows (the two prerequisites and the announcement) and the same columns, so the
 * reader can compare the two outcomes.
 *
 * "Wait for several prerequisites": `release.announce` waits on `release.publish` and
 * `release.index` with `onSuccess: "release"`. Each resolution decreases the counter of unresolved
 * edges in the transaction of the prerequisite. At zero, the dependent leaves `blocked` and
 * Workhorse appends `dependency_released`.
 *
 * "Choose what happens when a prerequisite fails": the index edge resolves with `fail` and marks
 * the dependent as rejected, but it stays blocked until the last edge resolves. Then `fail` has
 * precedence, and Workhorse fails the announcement without a run.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";
type Cell = readonly [kind: Kind, name: string, sub: string] | undefined;

const LEFT = 200;
const RIGHT = 936;
const GAP = 16;
const TIMES = ["0 s", "1 min", "2 min"] as const;

function grid(
  d: Diagram,
  policy: string,
  rows: readonly (readonly [name: string, cells: readonly Cell[]])[],
): number {
  const pitch = (RIGHT - LEFT + GAP) / TIMES.length;
  const width = pitch - GAP;
  const x = (index: number): number => LEFT + index * pitch;
  d.rows(
    24,
    40,
    [
      ["release.announce", 12, "ink", SANS, 600],
      [policy, 9, "muted", MONO, 400],
    ],
    "start",
  );
  TIMES.forEach((time, index) => {
    d.rows(x(index) + width / 2, 44, [[time, 8, "soft", MONO, 400]]);
  });
  d.divider(LEFT, RIGHT, 52);
  rows.forEach(([name, cells], row) => {
    const y = 72 + row * 56;
    d.text(24, y + 25, name, { size: 10, color: "ink" });
    cells.forEach((cell, index) => {
      if (cell) d.box(x(index), y, width, 40, cell[0], cell[1], cell[2], 11);
    });
  });
  return 72 + rows.length * 56 + 8;
}

function footer(d: Diagram, y: number, lines: readonly string[]): number {
  d.rows(
    24,
    y,
    lines.map((line) => [line, 9, "muted", MONO, 400] as const),
    "start",
  );
  return y + 1 + lines.length * 15;
}

function eventList(
  d: Diagram,
  events: readonly (readonly [time: string, kind: Kind, name: string, sub: string])[],
  lines: readonly string[],
): number {
  const pitch = 56;
  events.forEach(([time, kind, name, sub], index) => {
    const top = 24 + index * pitch;
    if (index > 0) d.arrow(`M 248,${top - 14} V ${top - 2}`);
    d.text(24, top + 25, time, { color: "ink" });
    d.box(112, top, 264, 42, kind, name, sub, 11);
  });
  return footer(d, 24 + events.length * pitch + 8, lines) + 16;
}

const releaseTitle = "A dependent becomes ready when its last edge releases";
const releaseDescription =
  "release.announce waits for release.publish and release.index. At 0 s, it is blocked with two " +
  "unresolved edges. At 1 min, release.publish succeeds, and one edge is still unresolved. At " +
  "2 min, release.index succeeds. No edge is unresolved, so Workhorse makes the announcement " +
  "ready and appends dependency_released.";

/** The fan-in diagram: both prerequisites succeed, and the announcement becomes ready. */
export const dependenciesRelease = {
  slug: "task-dependencies-release",
  title: releaseTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const y = grid(d, 'onSuccess: "release"', [
      [
        "release.publish",
        [
          ["external", "not finished", "the edge is unresolved"],
          ["backend", "succeeds", "the edge resolves: release"],
          undefined,
        ],
      ],
      [
        "release.index",
        [
          ["external", "not finished", "the edge is unresolved"],
          ["external", "not finished", "the edge is unresolved"],
          ["backend", "succeeds", "the edge resolves: release"],
        ],
      ],
      [
        "announcement",
        [
          ["store", "blocked", "2 unresolved edges"],
          ["store", "blocked", "1 unresolved edge"],
          ["focal", "ready", "dependency_released"],
        ],
      ],
    ]);
    const height = footer(d, y + 16, [
      "Each resolved edge decreases the counter. At zero, the dependent leaves blocked.",
    ]);
    return d.render(this.slug, 960, height, releaseTitle, releaseDescription);
  },
};

/** The fan-in diagram for screens up to 600 px wide: one event on each line. */
export const dependenciesReleaseNarrow = {
  slug: "task-dependencies-release-narrow",
  title: releaseTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["0 s", "store", "announcement: blocked", "2 unresolved edges"],
        ["1 min", "backend", "release.publish succeeds", "1 unresolved edge"],
        ["2 min", "backend", "release.index succeeds", "0 unresolved edges"],
        ["", "focal", "announcement: ready", "dependency_released"],
      ],
      ["Each resolved edge decreases the counter.", "At zero, the dependent leaves blocked."],
    );
    return d.render(this.slug, 400, height, releaseTitle, releaseDescription);
  },
};

const failTitle = "A failed prerequisite with the policy fail fails the dependent";
const failDescription =
  "release.announce waits for release.publish and release.index with onFailure fail. At 1 min, " +
  "release.index fails after its last retry. Workhorse marks the announcement as rejected, but one " +
  "edge is still unresolved, so it stays blocked. At 2 min, release.publish succeeds. No edge is " +
  "unresolved, and the fail policy has precedence, so Workhorse fails the announcement. It never runs.";

/** The failure diagram: the index fails, and the announcement fails after the last edge resolves. */
export const dependenciesFail = {
  slug: "task-dependencies-fail",
  title: failTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const y = grid(d, 'onFailure: "fail"', [
      [
        "release.publish",
        [
          ["external", "not finished", "the edge is unresolved"],
          ["external", "not finished", "the edge is unresolved"],
          ["backend", "succeeds", "the edge resolves: release"],
        ],
      ],
      [
        "release.index",
        [
          ["external", "not finished", "the edge is unresolved"],
          ["backend", "fails", "the edge resolves: fail"],
          undefined,
        ],
      ],
      [
        "announcement",
        [
          ["store", "blocked", "2 unresolved edges"],
          ["store", "blocked · rejected", "1 unresolved edge"],
          ["focal", "failed", "it never runs"],
        ],
      ],
    ]);
    const height = footer(d, y + 16, [
      "After all edges resolve, fail has precedence over cancel, and cancel over release.",
    ]);
    return d.render(this.slug, 960, height, failTitle, failDescription);
  },
};

/** The failure diagram for screens up to 600 px wide: one event on each line. */
export const dependenciesFailNarrow = {
  slug: "task-dependencies-fail-narrow",
  title: failTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["0 s", "store", "announcement: blocked", "2 unresolved edges"],
        ["1 min", "backend", "release.index fails", "rejected · still blocked"],
        ["2 min", "backend", "release.publish succeeds", "0 unresolved edges"],
        ["", "focal", "announcement: failed", "it never runs"],
      ],
      ["After all edges resolve, fail has", "precedence over cancel and release."],
    );
    return d.render(this.slug, 400, height, failTitle, failDescription);
  },
};
