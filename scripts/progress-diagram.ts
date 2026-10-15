import { Diagram, MONO, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `site/content/docs/progress.mdx`. It uses the names of that page.
 *
 * `update_progress_v1` checks a write in this order. A value larger than 64 KiB fails. A write
 * from a worker that is not the current owner, or whose lease expired, fails with a lease-lost
 * error. An identical value changes nothing. A changed value from the same fence less than
 * 100 milliseconds after the last accepted change fails with a rate-limit error and the remaining
 * delay. Otherwise the value replaces the previous one, the revision increments, and Workhorse
 * adds one `progress_updated` event.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

const title = "Each progress write passes four checks before it replaces the value";
const description =
  "Workhorse checks a progress write in order. A value larger than 64 KiB fails. A write from a " +
  "handler that is not the current owner fails with a lease-lost error. An identical value " +
  "changes nothing. A changed value less than 100 milliseconds after the last change from the " +
  "same fence fails with a rate-limit error. Otherwise the value replaces the previous value, the " +
  "revision increments, and Workhorse adds one progress_updated event.";

const checks: readonly (readonly [
  check: readonly [name: string, sub: string],
  label: string,
  result: readonly [kind: Kind, name: string, sub: string],
])[] = [
  [["size", "at most 64 KiB"], "TOO LARGE", ["external", "rejected", "the value is too large"]],
  [
    ["owner", "current worker and fence"],
    "NOT THE OWNER",
    ["external", "lease-lost error", "an old handler"],
  ],
  [
    ["same value?", "compare to the latest"],
    "IDENTICAL",
    ["store", "no change", "no revision · no event"],
  ],
  [
    ["cadence", "same fence · 100 ms"],
    "TOO SOON",
    ["external", "rate-limit error", "with the retry delay"],
  ],
];

const BOX = 164;
const GAP = 24;
const x = (index: number): number => 24 + index * (BOX + GAP);

/** The write diagram: the checks in one row, the result of each failed check below it. */
export const progressWrite = {
  slug: "progress-write",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const y = 48;
    const below = y + 128;
    checks.forEach((_, index) => {
      d.arrow(`M ${x(index) + BOX},${y + 26} H ${x(index + 1) - 2}`);
      d.arrow(`M ${x(index) + BOX / 2},${y + 52} V ${below - 2}`, { dashed: true });
    });
    checks.forEach(([[name, sub], label, [kind, result, resultSub]], index) => {
      d.box(x(index), y, BOX, 52, "backend", name, sub, 11);
      d.label(x(index) + BOX / 2, y + 90, label);
      d.box(x(index), below, BOX, 48, kind, result, resultSub, 11);
    });
    d.box(x(4), y, 936 - x(4), 52, "focal", "value replaced", "revision + 1", 11);
    d.box(x(4), below, 936 - x(4), 48, "store", "progress_updated", "revision and byte size", 11);
    d.arrow(`M ${x(4) + (936 - x(4)) / 2},${y + 52} V ${below - 2}`);

    d.rows(
      24,
      below + 80,
      [
        [
          "Only the current owner can write. Write one time for each batch, or at a fixed interval.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, below + 96, title, description);
  },
};

const events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[] = [
  ["size", "external", "larger than 64 KiB", "rejected"],
  ["owner", "external", "not the current owner", "lease-lost error"],
  ["value", "store", "identical value", "no change · no event"],
  ["cadence", "external", "same fence, under 100 ms", "rate-limit error"],
  ["accept", "focal", "value replaced", "revision + 1 · one event"],
];

/** The write diagram for screens up to 600 px wide: one check on each line. */
export const progressWriteNarrow = {
  slug: "progress-write-narrow",
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
        ["Workhorse checks each write in this order.", 9, "muted", MONO, 400],
        ["The first check that stops the write decides.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
