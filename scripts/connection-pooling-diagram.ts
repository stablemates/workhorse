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
 * "Budget the connections that each worker holds": four workers on one pool of 20. In every SDK, the
 * workers on one pool share one listener connection and one heartbeat connection. In TypeScript, Go,
 * Python, Ruby, and the JVM, both come from the pool, so 18 pooled connections remain. In Rust, only
 * the heartbeat connection comes from the pool, so 19 remain. The Rust listener connection is
 * outside the pool, so the server or the pooler must accept one more client.
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

const budgetTitle = "Four workers on one pool share one listener and one heartbeat connection";
const budgetDescription =
  "Four workers run on one pool of 20 connections. In TypeScript, Go, Python, Ruby, Java, and " +
  "Kotlin, the four workers share one listener connection and one heartbeat connection from the " +
  "pool. Thus 18 connections remain for claims and handlers. In Rust, the four workers share one " +
  "heartbeat connection from the pool, so 19 remain. The shared Rust listener connection is " +
  "outside the pool, so the server or the pooler must accept one more client.";

const CONNECTION = 32;
const BAR_LEFT = 200;
const POOL = 20;
const OUTSIDE_LEFT = 856;
const OUTSIDE_WIDTH = 80;

const budgets: readonly (readonly [
  languages: readonly string[],
  kept: string,
  pooled: number,
  outside: number,
])[] = [
  [["TypeScript, Go, Python,", "Ruby, Java, Kotlin"], "1 listener · 1 heartbeat", 2, 0],
  [["Rust"], "1 heartbeat in the pool", 1, 1],
];

/** The budget diagram: one bar of 20 pooled connections for each budget, and the clients outside. */
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
    d.rows(OUTSIDE_LEFT + OUTSIDE_WIDTH / 2, 44, [["outside the pool", 8, "soft", MONO, 400]]);
    d.divider(BAR_LEFT, BAR_LEFT + POOL * CONNECTION, 52);
    d.divider(OUTSIDE_LEFT, OUTSIDE_LEFT + OUTSIDE_WIDTH, 52);
    budgets.forEach(([languages, kept, pooled, outside], index) => {
      const y = 72 + index * 64;
      d.rows(
        24,
        y + (languages.length === 1 ? 19 : 12),
        [
          ...languages.map((line) => [line, 10, "ink", MONO, 400] as const),
          [kept, 9, "muted", MONO, 400] as const,
        ],
        "start",
      );
      const keptWidth = pooled * CONNECTION;
      d.box(BAR_LEFT, y, keptWidth - 4, 40, "focal", `${pooled}`, undefined, 11);
      d.box(
        BAR_LEFT + keptWidth,
        y,
        (POOL - pooled) * CONNECTION,
        40,
        "backend",
        `${POOL - pooled} for claims and handlers`,
        undefined,
        11,
      );
      if (outside > 0) {
        d.box(OUTSIDE_LEFT, y, OUTSIDE_WIDTH, 40, "external", `${outside} listener`, undefined, 10);
      }
    });
    const footerY = 72 + budgets.length * 64 + 16;
    d.rows(
      24,
      footerY,
      [
        [
          "All the workers on one pool share these connections, so the count does not grow with the workers.",
          9,
          "muted",
          MONO,
          400,
        ],
        [
          "The Rust listener is outside the pool, so the server or the pooler must accept one more client.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, footerY + 31, budgetTitle, budgetDescription);
  },
};

/** The budget diagram for screens up to 600 px wide: one budget on each line. */
export const poolerBudgetNarrow = {
  slug: "pgbouncer-budget-narrow",
  title: budgetTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["5 SDKs", "backend", "18 remain", "2 kept: 1 listener, 1 heartbeat"],
        ["Rust", "backend", "19 remain", "1 kept: 1 heartbeat"],
        ["Rust", "external", "1 listener", "outside the pool"],
      ],
      [
        "5 SDKs: TypeScript, Go, Python, Ruby, JVM.",
        "The workers on one pool share these",
        "connections. The Rust listener needs one",
        "more client of the server or the pooler.",
      ],
    );
    return d.render(this.slug, 400, height, budgetTitle, budgetDescription);
  },
};
