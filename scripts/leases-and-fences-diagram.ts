import { Diagram, MONO, type Theme } from "./diagram-svg.js";

/**
 * The leases and fences diagram: the invoice task of `docs/guides/020-leases-and-fences.md` on one
 * timeline, with worker A, the runtime row, and worker B. It uses the names and times of that guide.
 *
 * - Worker A claims at 0 s with fence token 41. The default lease is 30 s, so each claim or accepted
 *   heartbeat sets the expiry to that moment plus 30 s: 30 s, then 40 s, then 50 s.
 * - The machine stops at 25 s. Nothing renews the lease, so it expires at 50 s.
 * - A maintenance tick recovers the row soon after. Worker B claims at about 52 s with token 57.
 * - At 70 s, the machine of worker A starts again, and the old handler continues. At 90 s, worker A
 *   tries to complete with token 41. The row has 57, so PostgreSQL refuses the write, and the
 *   worker drops the result.
 *
 * Check each fact against its source before you change a label.
 */

const title = "A lease gives a task one owner, and a fence token refuses a late write";
const description =
  "Worker A claims the task with fence token 41 and sends heartbeats. Its machine stops at 25 s, and " +
  "the lease expires at 50 s. At about 52 s, worker B claims the task with fence token 57. At 70 s, " +
  "worker A starts again. At 90 s, it tries to complete the task with token 41, and PostgreSQL " +
  "refuses the write because the row has 57.";

/** Seconds to x on the timeline. */
const at = (seconds: number): number => 200 + seconds * 7;

export const leasesAndFences = {
  slug: "leases-and-fences",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const writeX = (at(90) + 936) / 2;

    d.arrow(`M ${writeX},120 V 160`);
    d.arrow(`M ${at(52) + 16},240 V 212`);

    for (const seconds of [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]) {
      d.rows(at(seconds), 44, [[`${seconds} s`, 8, "soft", MONO, 400]]);
    }
    d.divider(at(0), 936, 52);

    d.text(24, 104, "worker A", { size: 10, color: "ink" });
    d.text(24, 188, "runtime row", { size: 10, color: "ink" });
    d.text(24, 264, "worker B", { size: 10, color: "ink" });

    d.box(
      at(0),
      80,
      at(25) - at(0),
      40,
      "backend",
      "runs the handler",
      "heartbeats at 10 s and 20 s",
      11,
    );
    d.box(at(25), 80, at(70) - at(25), 40, "external", "machine stopped", "no heartbeats", 11);
    d.box(at(70), 80, at(90) - at(70), 40, "backend", "starts again", "runs the old handler", 11);
    d.box(at(90), 80, 936 - at(90), 40, "backend", "complete", "fence 41", 11);

    d.box(
      at(0),
      164,
      at(50) - at(0),
      40,
      "store",
      "owner A · fence 41",
      "expiry 30 s → 40 s → 50 s",
      11,
    );
    d.box(at(52), 164, 936 - at(52), 40, "focal", "owner B · fence 57", "a new lease", 11);

    d.box(at(52), 240, 936 - at(52), 40, "backend", "runs the handler", undefined, 11);

    d.label(at(25), 64, "STOPS AT 25 S");
    d.label(at(70), 64, "STARTS AGAIN AT 70 S");
    d.label(at(50) - 28, 134, "LEASE EXPIRES AT 50 S");
    d.label(writeX - 40, 134, "REFUSED · RESULT DROPPED");
    d.label(at(52) - 64, 220, "CLAIM AT 52 S · FENCE 57");

    d.rows(
      24,
      316,
      [
        [
          "A write counts only if its worker ID and fence token match the row.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );

    return d.render(this.slug, 960, 332, title, description);
  },
};

const events = [
  ["0 s", "backend", "worker A claims", "fence 41 · expiry 30 s"],
  ["10–20 s", "backend", "worker A sends heartbeats", "expiry 40 s → 50 s"],
  ["25 s", "external", "worker A stops", "no heartbeats"],
  ["50 s", "store", "the lease expires", "owner A · fence 41"],
  ["52 s", "focal", "worker B claims", "owner B · fence 57"],
  ["70 s", "backend", "worker A starts again", "runs the old handler"],
  ["90 s", "backend", "worker A tries to complete", "fence 41 · refused · result dropped"],
] as const;

/** The same diagram for screens up to 600 px wide: one event on each line, in time order. */
export const leasesAndFencesNarrow = {
  slug: "leases-and-fences-narrow",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const pitch = 56;

    events.forEach(([time, kind, name, sub], index) => {
      const top = 24 + index * pitch;
      if (index > 0) d.arrow(`M 232,${top - 14} V ${top - 2}`);
      d.text(24, top + 25, time, { color: "ink" });
      d.box(88, top, 288, 42, kind, name, sub, 11);
    });

    const footerY = 24 + events.length * pitch + 8;
    d.rows(
      24,
      footerY,
      [
        ["A write counts only if its worker ID and", 9, "muted", MONO, 400],
        ["fence token match the row.", 9, "muted", MONO, 400],
      ],
      "start",
    );

    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
