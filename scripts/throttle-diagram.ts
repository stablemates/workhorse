import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `docs/guides/217-throttle.md`. It uses the names of that guide.
 *
 * "Accept one task in each window": each change in `acct-7` sends a request with the key `acct-7`
 * and a window of 10 min. The first request is `accepted` and opens the window. An equivalent
 * request in the window is `coalesced` and gets the `taskId` of the task that opened the window,
 * whatever the state of that task. The end of the task does not close the window. After the
 * window closes, the next request is `accepted` with a new task and a new window.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

const AXIS_LEFT = 260;
const MINUTE = 28;
const MARKER = 112;
const at = (minutes: number): number => AXIS_LEFT + minutes * MINUTE;

const title = "Throttle accepts one task in each window";
const description =
  "Each change in acct-7 sends a request with a window of 10 min. At 0 min, the first request is " +
  "accepted and opens the window. At 2 min, a request is coalesced. At 3 min, the task succeeds. " +
  "At 7 min, a request is still coalesced, because the end of the task does not close the window. " +
  "At 12 min, the window is closed, so a request is accepted with a new task.";

type Row = readonly [
  label: string,
  outcome: string,
  start: number,
  end: number,
  kind: Kind,
  name: string,
  sub: string,
];

const rows: readonly Row[] = [
  ["change 1", "accepted", 0, 10, "store", "window 1", "the first task"],
  ["first task", "ready at once", 0, 3, "backend", "succeeds", "at 3 min"],
  ["change 2", "coalesced", 2, 2, "external", "same taskId", "at 2 min"],
  ["change 3", "coalesced", 7, 7, "focal", "same taskId", "at 7 min"],
  ["change 4", "accepted", 12, 22, "store", "window 2", "a new task, a new taskId"],
];

/** The window timeline: one row for each request and one for the first task, on one time axis. */
export const throttleWindow = {
  slug: "throttle-window",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.rows(
      24,
      40,
      [
        ["acct-7", 12, "ink", SANS, 600],
        ["window 10 min", 9, "muted", MONO, 400],
      ],
      "start",
    );
    for (let minute = 0; minute <= 24; minute += 4) {
      d.rows(at(minute), 44, [[`${minute} min`, 8, "soft", MONO, 400]]);
    }
    d.divider(at(0), at(24), 52);

    rows.forEach(([label, outcome, start, end, kind, name, sub], index) => {
      const y = 72 + index * 56;
      d.rows(
        24,
        y + 16,
        [
          [label, 11, "ink", SANS, 600],
          [outcome, 9, "muted", MONO, 400],
        ],
        "start",
      );
      // A request without a span is one moment: a marker centered on its time.
      if (start === end) d.box(at(start) - MARKER / 2, y, MARKER, 40, kind, name, sub, 11);
      else d.box(at(start), y, at(end) - at(start), 40, kind, name, sub, 11);
    });

    const footerY = 72 + rows.length * 56 + 24;
    d.rows(
      24,
      footerY,
      [
        [
          "Four requests make two tasks, one in each window. The end of a task does not close its window.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, footerY + 16, title, description);
  },
};

const events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[] = [
  ["0 min", "store", "change 1: accepted", "the window ends at 10 min"],
  ["2 min", "external", "change 2: coalesced", "the same taskId"],
  ["3 min", "backend", "the task succeeds", "the window stays open"],
  ["7 min", "focal", "change 3: coalesced", "the same taskId"],
  ["12 min", "store", "change 4: accepted", "a new task · ends at 22 min"],
];

/** The window timeline for screens up to 600 px wide: one event on each line. */
export const throttleWindowNarrow = {
  slug: "throttle-window-narrow",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const pitch = 56;
    events.forEach(([label, kind, name, sub], index) => {
      const top = 24 + index * pitch;
      if (index > 0) d.arrow(`M 248,${top - 14} V ${top - 2}`);
      d.text(24, top + 25, label, { color: "ink" });
      d.box(112, top, 264, 42, kind, name, sub, 11);
    });
    const footerY = 24 + events.length * pitch + 8;
    d.rows(
      24,
      footerY,
      [
        ["Four requests make two tasks. The end of", 9, "muted", MONO, 400],
        ["a task does not close its window.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
