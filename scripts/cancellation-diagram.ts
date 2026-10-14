import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `docs/guides/120-cancellation.md`, "Stop a handler that runs". It uses the names of
 * that guide.
 *
 * Worker A claims the `order.upload` task at 0 s and uses the default lease of 30 s and heartbeat of
 * 10 s. The heartbeat at 10 s moves the lease to 40 s. At 12 s, an operator cancels the task, and
 * Workhorse records the request. After the request, `heartbeat_v1` returns `cancel_requested` and
 * does not move the lease. If the handler obeys the aborted signal, the worker acknowledges the
 * cancellation soon after 20 s. If the handler ignores it, the lease expires at 40 s and recovery
 * cancels the task.
 *
 * Check each fact against its source before you change a label.
 */

const stopTitle = "Workhorse asks a running handler to stop, and the handler decides when it stops";
const stopDescription =
  "Worker A claims the order.upload task at 0 s, and its heartbeat at 10 s moves the lease to 40 s. " +
  "At 12 s, an operator cancels the task, and Workhorse records the request. The heartbeat at 20 s " +
  "returns cancel_requested and does not move the lease. If the handler obeys the signal, it stops " +
  "and the worker confirms the cancellation. If the handler ignores the signal, the lease expires " +
  "at 40 s and recovery cancels the task.";

/** The x position of `seconds` on the axis from 0 s to 50 s. */
const along = (seconds: number): number => 200 + (seconds * 736) / 50;

/** A heartbeat time, its answer, and how far its answer moves left, so it stays out of the zone. */
type Heartbeat = readonly [seconds: number, answer: string, shift?: number];

export const cancellationStop = {
  slug: "cancellation-stop",
  title: stopTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);

    [0, 10, 12, 20, 30, 40, 50].forEach((seconds) => {
      d.rows(along(seconds), 44, [[`${seconds} s`, 8, "soft", MONO, 400]]);
    });
    d.divider(along(0), along(50), 52);

    d.zone(along(12), 72, along(50) - along(12), 216, "CANCEL REQUESTED AT 12 S");

    const track = (
      top: number,
      title: string,
      end: number,
      sub: string,
      outcome: string,
      heartbeats: readonly Heartbeat[],
    ): void => {
      d.rows(24, top + 16, [[title, 10, "ink", SANS, 600]], "start");
      d.box(along(0), top, along(end) - 4 - along(0), 36, "backend", "runs the handler", sub, 11);
      d.box(
        along(end) + 4,
        top,
        along(end) + 120 - along(end),
        36,
        "focal",
        "canceled",
        outcome,
        11,
      );
      d.text(24, top + 58, "heartbeat", { size: 9, color: "muted" });
      heartbeats.forEach(([seconds, answer, shift = 0]) => {
        d.box(along(seconds) - 4, top + 50, 8, 8, "store");
        d.rows(along(seconds) - shift, top + 72, [[answer, 8, "soft", MONO, 400]]);
      });
    };

    track(96, "the handler obeys", 20, "attempt 1", "the worker confirms", [
      [10, "LEASE UNTIL 40 S", 16],
      [20, "CANCEL_REQUESTED"],
    ]);
    track(196, "the handler ignores", 40, "the signal is aborted at 20 s", "the lease expires", [
      [10, "LEASE UNTIL 40 S", 16],
      [20, "CANCEL_REQUESTED"],
      [30, "CANCEL_REQUESTED"],
    ]);

    d.rows(
      24,
      316,
      [
        [
          "After the request, a heartbeat does not move the lease. The handler decides when it stops.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );

    return d.render(this.slug, 960, 332, stopTitle, stopDescription);
  },
};

type Kind = "focal" | "backend" | "store" | "external";

const stopEvents: readonly (readonly [time: string, kind: Kind, name: string, sub: string])[] = [
  ["0 s", "backend", "worker A claims the task", "the lease lasts 30 s"],
  ["10 s", "store", "heartbeat: accepted", "lease until 40 s"],
  ["12 s", "store", "an operator cancels", "Workhorse records the request"],
  ["20 s", "store", "heartbeat: cancel_requested", "the signal is aborted"],
];

const stopEnds: readonly (readonly [title: string, sub: string])[] = [
  ["the handler obeys", "canceled · the worker confirms"],
  ["the handler ignores", "canceled at 40 s · recovery"],
];

/** The stop diagram for screens up to 600 px wide: one event on each line, then the two ends. */
export const cancellationStopNarrow = {
  slug: "cancellation-stop-narrow",
  title: stopTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const pitch = 56;

    stopEvents.forEach(([time, kind, name, sub], index) => {
      const top = 24 + index * pitch;
      if (index > 0) d.arrow(`M 240,${top - 14} V ${top - 2}`);
      d.text(24, top + 25, time, { color: "ink" });
      d.box(104, top, 272, 42, kind, name, sub, 11);
    });

    const endTop = 24 + stopEvents.length * pitch + 24;
    d.arrow(`M 240,${endTop - 38} V ${endTop - 26} H 110 V ${endTop - 2}`);
    d.arrow(`M 240,${endTop - 26} H 290 V ${endTop - 2}`);
    stopEnds.forEach(([title, sub], index) => {
      d.box(24 + index * 180, endTop, 172, 42, "focal", title, sub, 11);
    });

    const footerY = endTop + 70;
    d.rows(
      24,
      footerY,
      [
        ["After the request, a heartbeat does not move", 9, "muted", MONO, 400],
        ["the lease. The handler decides when it stops.", 9, "muted", MONO, 400],
      ],
      "start",
    );

    return d.render(this.slug, 400, footerY + 32, stopTitle, stopDescription);
  },
};
