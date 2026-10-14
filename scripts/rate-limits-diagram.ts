import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `docs/guides/250-rate-limits.md`. They use the names of that guide.
 *
 * "Limit how quickly a queue starts tasks": the policy of `provider-api` adds sixty tokens each
 * minute and keeps a burst of ten. After an idle hour, the bucket holds ten tokens. Ten of 50
 * tasks start at 0 s; then one token arrives each second, and each token lets one task start. A
 * task that ends gives back no token, so the last task starts at about 40 s.
 *
 * "Give each customer its own bucket": the `perKey` bucket allows five starts each minute with a
 * burst of two. A start needs a token from the queue bucket and from the bucket of its key. The
 * claim skips the `acme` tasks while the `acme` bucket has no whole token, so `globex` starts.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

type Row = readonly [
  label: string,
  sub: string,
  start: number,
  end: number,
  kind: Kind,
  name: string,
  detail: string,
];

const MARKER = 136;

function timeline(
  d: Diagram,
  heading: readonly [string, string],
  axis: readonly [last: number, step: number, unit: string],
  rows: readonly Row[],
  note: string,
): number {
  const [last, step, unit] = axis;
  const left = 260;
  const scale = (900 - left) / last;
  const at = (value: number): number => left + value * scale;
  d.rows(
    24,
    40,
    [
      [heading[0], 12, "ink", SANS, 600],
      [heading[1], 9, "muted", MONO, 400],
    ],
    "start",
  );
  for (let value = 0; value <= last; value += step) {
    d.rows(at(value), 44, [[`${value} ${unit}`, 8, "soft", MONO, 400]]);
  }
  d.divider(at(0), at(last), 52);
  rows.forEach(([label, sub, start, end, kind, name, detail], index) => {
    const y = 72 + index * 56;
    d.rows(
      24,
      y + 16,
      [
        [label, 11, "ink", SANS, 600],
        [sub, 9, "muted", MONO, 400],
      ],
      "start",
    );
    // A row without a span is one moment: a marker that starts at its time.
    if (start === end) d.box(at(start), y, MARKER, 40, kind, name, detail, 11);
    else d.box(at(start), y, at(end) - at(start), 40, kind, name, detail, 11);
  });
  const footerY = 72 + rows.length * 56 + 24;
  d.rows(24, footerY, [[note, 9, "muted", MONO, 400]], "start");
  return footerY + 16;
}

function eventList(
  d: Diagram,
  events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[],
  lines: readonly string[],
): number {
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
    lines.map((line) => [line, 9, "muted", MONO, 400] as const),
    "start",
  );
  return footerY + 17 + lines.length * 15;
}

const bucketTitle = "The burst starts ten tasks at once, and the rate starts one each second";
const bucketDescription =
  "The rate-limit policy of provider-api adds sixty tokens each minute and keeps a burst of ten. " +
  "After an idle hour, the bucket holds ten tokens. At 0 s, the app enqueues 50 tasks, and ten " +
  "start at once. Then one token arrives each second, and each token lets one task start. A task " +
  "that ends gives back no token. At about 40 s, the last task starts.";

/** The bucket timeline: the tokens, the starts, and the tasks that wait, from 0 s to 40 s. */
export const rateBucket = {
  slug: "rate-limits-bucket",
  title: bucketTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = timeline(
      d,
      ["provider-api", "60 each minute · burst 10"],
      [40, 10, "s"],
      [
        [
          "bucket",
          "tokens",
          0,
          40,
          "store",
          "1 new token each second",
          "after the burst of 10 is used",
        ],
        ["starts", "10 at once", 0, 0, "focal", "10 tasks start", "the burst"],
        ["starts", "then", 1, 40, "backend", "1 task starts each second", "with each new token"],
        [
          "ready",
          "the rest",
          0,
          40,
          "external",
          "40 tasks wait for tokens",
          "none is ready at about 40 s",
        ],
      ],
      "The bucket counts starts, not running tasks. A task that ends gives back no token.",
    );
    return d.render(this.slug, 960, height, bucketTitle, bucketDescription);
  },
};

/** The bucket timeline for screens up to 600 px wide: one event on each line. */
export const rateBucketNarrow = {
  slug: "rate-limits-bucket-narrow",
  title: bucketTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["idle", "store", "the bucket holds 10", "the burst limits it"],
        ["0 s", "focal", "10 of 50 tasks start", "all 10 tokens are used"],
        ["1–40 s", "backend", "1 task starts each second", "with each new token"],
        ["~40 s", "backend", "the last task starts", "no task is ready"],
      ],
      ["The bucket counts starts, not running", "tasks. An end gives back no token."],
    );
    return d.render(this.slug, 400, height, bucketTitle, bucketDescription);
  },
};

const keysTitle = "Each key has its own bucket, so one customer does not delay another";
const keysDescription =
  "The perKey bucket of provider-api lets each customer start five tasks each minute, with a burst " +
  "of two. At 0 s, acme enqueues 20 tasks, and two start. At 6 s, globex enqueues one task. The " +
  "claim skips the 18 acme tasks, because the acme bucket has no whole token, and the globex task " +
  "starts. At 12 s, the acme bucket has one new token, and one more acme task starts.";

/** The key timeline: the `acme` bucket and the `globex` task, from 0 s to 14 s. */
export const rateKeys = {
  slug: "rate-limits-keys",
  title: keysTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = timeline(
      d,
      ["provider-api", "perKey: 5 each minute · burst 2"],
      [14, 2, "s"],
      [
        ["acme", "20 tasks", 0, 0, "backend", "2 tasks start", "acme bucket empty"],
        ["acme", "waiting", 0, 12, "external", "18 tasks stay ready", "no whole acme token"],
        ["globex", "1 task", 6, 6, "focal", "starts", "own bucket full"],
        ["acme", "new token", 12, 12, "backend", "1 task starts", "one acme token"],
      ],
      "A start needs a token from the queue bucket and from the bucket of its key.",
    );
    return d.render(this.slug, 960, height, keysTitle, keysDescription);
  },
};

/** The key timeline for screens up to 600 px wide: one event on each line. */
export const rateKeysNarrow = {
  slug: "rate-limits-keys-narrow",
  title: keysTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["0 s", "backend", "2 acme tasks start", "the acme bucket is empty"],
        ["6 s", "focal", "the globex task starts", "18 acme tasks stay ready"],
        ["12 s", "backend", "1 acme task starts", "one new acme token"],
      ],
      ["A start needs a token from the queue", "bucket and from the bucket of its key."],
    );
    return d.render(this.slug, 400, height, keysTitle, keysDescription);
  },
};
