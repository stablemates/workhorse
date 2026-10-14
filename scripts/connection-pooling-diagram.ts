import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `docs/guides/390-connection-pooling.md`. They use the names of that guide.
 *
 * "Run queue operations through any pool mode" and "Give the listener a direct or session-mode
 * pool": each statement that Workhorse sends is self-contained, so the enqueue of `order-42` and
 * the claims, heartbeats, and completions of `w1` work through PgBouncer in transaction mode. The
 * `LISTEN workhorse_tasks` of the listener is session state. Through transaction mode it gets no
 * notification and no error, and the worker claims at its next fallback poll. A direct or
 * session-mode pool delivers the wake hint.
 *
 * "Budget the connections that each worker holds": four workers on one pool of 20. TypeScript, Go,
 * and Ruby workers share one listener and one heartbeat connection. Each Python worker takes its
 * own listener and heartbeat connection from the pool. Each Rust worker takes a heartbeat
 * connection from the pool and opens its listener outside the pool.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

function eventList(
  d: Diagram,
  events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[],
  lines: readonly string[],
): number {
  const pitch = 56;
  events.forEach(([label, kind, name, sub], index) => {
    const top = 24 + index * pitch;
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

const pathsTitle =
  "Every queue operation works through the pooler; only the listener needs its own session";
const pathsDescription =
  "The app shop enqueues order.fulfill for order-42 in one transaction through PgBouncer in " +
  "transaction mode. The worker w1 claims, sends heartbeats, and completes through the same " +
  "pooler. Both work. The LISTEN workhorse_tasks of the listener gets no notification through " +
  "transaction mode, so w1 claims at its next fallback poll. Through a direct or session-mode pool, " +
  "the wake hint arrives.";

const rows: readonly (readonly [
  label: readonly [string, string],
  client: readonly [Kind, string, string],
  path: readonly [Kind, string, string],
  result: readonly [Kind, string, string],
])[] = [
  [
    ["shop", "the app"],
    ["backend", "enqueue order.fulfill", "with order-42 · one transaction"],
    ["store", "PgBouncer", "transaction mode"],
    ["backend", "works", "commits together"],
  ],
  [
    ["w1", "the worker"],
    ["backend", "claim · heartbeat · complete", "self-contained statements"],
    ["store", "PgBouncer", "transaction mode"],
    ["backend", "works", "on any server session"],
  ],
  [
    ["w1", "the listener"],
    ["external", "LISTEN workhorse_tasks", "session state"],
    ["store", "PgBouncer", "transaction mode"],
    ["external", "no wake hint", "next fallback poll"],
  ],
  [
    ["w1", "the listener"],
    ["focal", "LISTEN workhorse_tasks", "session state"],
    ["store", "direct pool", "or session mode"],
    ["focal", "wake hint arrives", "the worker claims at once"],
  ],
];

/** The path diagram: one row for each client, its pool path, and the result. */
export const poolerPaths = {
  slug: "pgbouncer-paths",
  title: pathsTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const cols = [176, 456, 676] as const;
    const widths = [256, 196, 260] as const;
    ["client", "pool path", "result"].forEach((heading, index) => {
      d.rows(cols[index]! + widths[index]! / 2, 44, [[heading, 8, "soft", MONO, 400]]);
    });
    d.divider(176, 936, 52);
    rows.forEach(([label, client, path, result], index) => {
      const y = 72 + index * 56;
      d.arrow(`M ${cols[0] + widths[0]},${y + 20} H ${cols[1] - 2}`);
      d.arrow(`M ${cols[1] + widths[1]},${y + 20} H ${cols[2] - 2}`);
      d.rows(
        24,
        y + 16,
        [
          [label[0], 11, "ink", SANS, 600],
          [label[1], 9, "muted", MONO, 400],
        ],
        "start",
      );
      [client, path, result].forEach(([kind, name, sub], col) => {
        d.box(cols[col]!, y, widths[col]!, 40, kind, name, sub, 11);
      });
    });
    const footerY = 72 + rows.length * 56 + 24;
    d.rows(
      24,
      footerY,
      [
        [
          "Without the wake hint, tasks still run, but they start at the next poll of the worker.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, footerY + 16, pathsTitle, pathsDescription);
  },
};

/** The path diagram for screens up to 600 px wide: one client path on each line. */
export const poolerPathsNarrow = {
  slug: "pgbouncer-paths-narrow",
  title: pathsTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["shop", "backend", "enqueue · transaction mode", "works"],
        ["w1", "backend", "claim, heartbeat, complete", "works in transaction mode"],
        ["listener", "external", "LISTEN · transaction mode", "no wake hint · next poll"],
        ["listener", "focal", "LISTEN · direct pool", "the wake hint arrives"],
      ],
      ["Give the listener a direct pool or a", "session-mode pool."],
    );
    return d.render(this.slug, 400, height, pathsTitle, pathsDescription);
  },
};

const budgetTitle = "Four workers on a pool of 20 keep some connections for themselves";
const budgetDescription =
  "Four workers share one pool of 20 connections. TypeScript, Go, and Ruby workers keep one " +
  "listener and one heartbeat connection, so 18 remain for claims and handlers. Python workers keep " +
  "four listeners and four heartbeat connections, so 12 remain. Rust workers keep four heartbeat " +
  "connections in the pool, so 16 remain. Their four listeners are outside the pool.";

const CONNECTION = 36;
const BAR_LEFT = 200;

const budgets: readonly (readonly [language: string, kept: number, keptSub: string])[] = [
  ["TypeScript, Go, Ruby", 2, "1 + 1"],
  ["Python", 8, "4 listeners · 4 heartbeats"],
  ["Rust", 4, "4 heartbeats"],
];

/** The budget diagram: one bar of 20 connections for each language. */
export const poolerBudget = {
  slug: "pgbouncer-budget",
  title: budgetTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.rows(
      24,
      40,
      [
        ["one pool of 20", 12, "ink", SANS, 600],
        ["four workers", 9, "muted", MONO, 400],
      ],
      "start",
    );
    for (const count of [0, 5, 10, 15, 20]) {
      d.rows(BAR_LEFT + count * CONNECTION, 44, [[`${count}`, 8, "soft", MONO, 400]]);
    }
    d.divider(BAR_LEFT, BAR_LEFT + 20 * CONNECTION, 52);
    budgets.forEach(([language, kept, keptSub], index) => {
      const y = 72 + index * 56;
      d.text(24, y + 25, language, { size: 10, color: "ink" });
      const keptWidth = kept * CONNECTION;
      d.box(
        BAR_LEFT,
        y,
        keptWidth - 4,
        40,
        "focal",
        `${kept} kept`,
        kept > 2 ? keptSub : undefined,
        10,
      );
      d.box(
        BAR_LEFT + keptWidth,
        y,
        (20 - kept) * CONNECTION,
        40,
        "backend",
        `${20 - kept} for claims and handlers`,
        undefined,
        11,
      );
    });
    const footerY = 72 + budgets.length * 56 + 24;
    d.rows(
      24,
      footerY,
      [
        [
          "The four Rust listeners are outside the pool, so the server or the pooler must accept four more clients.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, footerY + 16, budgetTitle, budgetDescription);
  },
};

/** The budget diagram for screens up to 600 px wide: one language on each line. */
export const poolerBudgetNarrow = {
  slug: "pgbouncer-budget-narrow",
  title: budgetTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["TS, Go, Ruby", "backend", "18 remain", "2 kept: 1 listener, 1 heartbeat"],
        ["Python", "backend", "12 remain", "8 kept: 4 listeners, 4 heartbeats"],
        ["Rust", "backend", "16 remain", "4 kept: 4 heartbeats"],
      ],
      ["The Rust listeners are outside the pool."],
    );
    return d.render(this.slug, 400, height, budgetTitle, budgetDescription);
  },
};
