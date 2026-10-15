import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagram of `site/content/docs/planetscale-postgresql.mdx`. It uses the names of that page.
 *
 * The schema setup uses a direct primary connection on port 5432, because PlanetScale recommends
 * direct connections for DDL. The worker uses a direct primary connection pool, which keeps the
 * session that `LISTEN` wake hints need. The application can connect directly, or through the
 * transaction-mode PgBouncer of PlanetScale on port 6432. Through PgBouncer, it must not depend on
 * `LISTEN` or on session-level state. Each connection uses TLS with a certificate check.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

const title = "Which PlanetScale connection each Workhorse part uses";
const description =
  "The schema setup uses a direct primary connection on port 5432. The worker uses a direct " +
  "primary connection pool on port 5432, so the LISTEN wake hints arrive. The application connects " +
  "directly on port 5432, or through the transaction-mode PgBouncer on port 6432. Through " +
  "PgBouncer, it must not depend on LISTEN or on session-level state.";

const rows: readonly (readonly [
  label: readonly [string, string],
  path: readonly [Kind, string, string],
  result: readonly [Kind, string, string],
])[] = [
  [
    ["schema setup", "workhorse schema migrate"],
    ["store", "direct primary · :5432", "an authorized schema owner"],
    ["backend", "DDL works", "PlanetScale recommends direct"],
  ],
  [
    ["worker", "a dedicated process"],
    ["store", "direct primary pool · :5432", "keeps its session"],
    ["focal", "wake hints arrive", "LISTEN works"],
  ],
  [
    ["application", "direct"],
    ["store", "direct primary · :5432", "your connection"],
    ["backend", "enqueue in your transaction", "the same transaction connection"],
  ],
  [
    ["application", "through PgBouncer"],
    ["store", "PgBouncer · :6432", "transaction mode"],
    ["external", "no LISTEN", "no session-level state"],
  ],
];

const PATH = 256;
const RESULT = 616;
const WIDTH = 320;

/** The connection diagram: one row for each part, its connection, and the result. */
export const planetscaleConnections = {
  slug: "planetscale-connections",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    ["connection", "result"].forEach((heading, index) => {
      d.rows([PATH, RESULT][index]! + WIDTH / 2, 44, [[heading, 8, "soft", MONO, 400]]);
    });
    d.divider(PATH, RESULT + WIDTH, 52);
    rows.forEach(([label, path, result], index) => {
      const y = 72 + index * 56;
      d.rows(
        24,
        y + 16,
        [
          [label[0], 11, "ink", SANS, 600],
          [label[1], 9, "muted", MONO, 400],
        ],
        "start",
      );
      d.arrow(`M ${PATH + WIDTH},${y + 20} H ${RESULT - 2}`);
      d.box(PATH, y, WIDTH, 40, path[0], path[1], path[2], 11);
      d.box(RESULT, y, WIDTH, 40, result[0], result[1], result[2], 11);
    });
    const footerY = 72 + rows.length * 56 + 24;
    d.rows(
      24,
      footerY,
      [
        [
          "Each connection uses TLS. Verify the certificate and the hostname, for example sslmode=verify-full.",
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
  ["schema", "store", "direct primary · :5432", "DDL works"],
  ["worker", "focal", "direct primary pool · :5432", "wake hints arrive"],
  ["app", "backend", "direct · :5432", "enqueue in your transaction"],
  ["app", "external", "PgBouncer · :6432", "no LISTEN · no session state"],
];

/** The connection diagram for screens up to 600 px wide: one part on each line. */
export const planetscaleConnectionsNarrow = {
  slug: "planetscale-connections-narrow",
  title,
  render(theme: Theme): string {
    const d = new Diagram(theme);
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
      [
        ["Each connection uses TLS with a", 9, "muted", MONO, 400],
        ["certificate check.", 9, "muted", MONO, 400],
      ],
      "start",
    );
    return d.render(this.slug, 400, footerY + 32, title, description);
  },
};
