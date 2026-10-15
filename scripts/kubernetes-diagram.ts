import { Diagram, MONO, SANS, type Theme } from "./diagram-svg.js";

/**
 * The diagrams of `site/content/docs/kubernetes.mdx` and `docs/kubernetes.md`. They use the names
 * of those pages.
 *
 * The workloads: the schema Job migrates the schema and verifies it before a new process starts.
 * Then the worker Deployment (two replicas, probes on port 9090) and the dashboard Deployment (one
 * replica) start from the same image. The dashboard is reachable only through an internal
 * `ClusterIP` Service, behind your authenticated HTTPS ingress. The Secret `workhorse-database`
 * supplies the URL to each workload.
 *
 * The drain: the first termination signal makes `/readyz` return 503, and `/livez` stays at 200
 * while handlers drain. The Workhorse deadline is 110 s and the Pod grace period is 120 s. The
 * Kubernetes default grace period of 30 s sends `SIGKILL` before the drain ends.
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

const workloadsTitle = "The schema Job runs first; the dashboard stays behind an internal Service";
const workloadsDescription =
  "Step 1: the schema Job migrates the schema and verifies it. Step 2: the worker Deployment, with " +
  "two replicas and probes on port 9090, and the dashboard Deployment, with one replica, start from " +
  "the same image. Your authenticated HTTPS ingress reaches the dashboard through an internal " +
  "ClusterIP Service. Each workload connects to PostgreSQL with the URL from the Secret " +
  "workhorse-database.";

/** The workload diagram: the release order on the left, the dashboard path on the right. */
export const kubernetesWorkloads = {
  slug: "kubernetes-workloads",
  title: workloadsTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.arrow("M 224,130 H 248 V 82 H 270");
    d.arrow("M 224,130 H 248 V 178 H 270");
    d.arrow("M 552,82 H 506");
    d.arrow("M 768,82 H 722");
    d.arrow("M 124,156 V 246");
    d.arrow("M 388,204 V 246");
    d.arrow("M 504,96 H 528 V 246");

    d.box(24, 104, 200, 52, "store", "1 · schema Job", "migrate, then verify", 11);
    d.box(272, 56, 232, 52, "backend", "2 · dashboard Deployment", "1 replica", 11);
    d.box(552, 56, 168, 52, "backend", "ClusterIP Service", "internal only", 11);
    d.box(768, 56, 168, 52, "external", "your HTTPS ingress", "with authentication", 11);
    d.box(272, 152, 232, 52, "focal", "2 · worker Deployment", "2 replicas · probes on :9090", 11);
    d.box(
      24,
      248,
      912,
      44,
      "store",
      "PostgreSQL",
      "the URL comes from the Secret workhorse-database",
      11,
    );

    d.rows(
      24,
      324,
      [
        [
          "Apply the Job and wait until it succeeds. Then apply both Deployments with the same image.",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 340, workloadsTitle, workloadsDescription);
  },
};

/** The workload diagram for screens up to 600 px wide: one workload on each line. */
export const kubernetesWorkloadsNarrow = {
  slug: "kubernetes-workloads-narrow",
  title: workloadsTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["1", "store", "schema Job", "migrate, then verify"],
        ["2", "focal", "worker Deployment", "2 replicas · probes on :9090"],
        ["2", "backend", "dashboard Deployment", "1 replica"],
        ["access", "external", "ingress → ClusterIP Service", "the dashboard stays internal"],
      ],
      ["Start the Deployments only after the", "Job succeeds."],
    );
    return d.render(this.slug, 400, height, workloadsTitle, workloadsDescription);
  },
};

const drainTitle = "A grace period of 120 s lets the drain of 110 s finish";
const drainDescription =
  "At the first termination signal, /readyz returns 503 and /livez stays at 200 while handlers " +
  "drain. With a Pod grace period of 120 seconds, the Workhorse deadline of 110 seconds ends " +
  "first. With the Kubernetes default of 30 seconds, Kubernetes sends SIGKILL during the drain.";

const SCALE = 6;
const ZERO = 200;
const at = (seconds: number): number => ZERO + seconds * SCALE;

/** The drain diagram: a time axis from the termination signal, one row for each grace period. */
export const kubernetesDrain = {
  slug: "kubernetes-drain",
  title: drainTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    for (const seconds of [0, 30, 60, 90, 110, 120]) {
      d.rows(at(seconds), 44, [[`${seconds} s`, 8, "soft", MONO, 400]]);
    }
    d.divider(at(0), at(120), 52);

    const rows: readonly (readonly [string, string])[] = [
      ["grace period 120 s", "this manifest"],
      ["grace period 30 s", "the Kubernetes default"],
    ];
    rows.forEach(([name, sub], index) => {
      d.rows(
        24,
        88 + index * 72,
        [
          [name, 11, "ink", SANS, 600],
          [sub, 9, "muted", MONO, 400],
        ],
        "start",
      );
    });

    d.box(
      at(0),
      72,
      at(110) - at(0) - 4,
      44,
      "focal",
      "handlers drain",
      "/readyz 503 · /livez 200",
      11,
    );
    d.box(at(110), 72, at(120) - at(110), 44, "store", "margin");

    d.box(at(0), 144, at(30) - at(0) - 4, 44, "backend", "handlers drain");
    d.box(
      at(30),
      144,
      at(120) - at(30),
      44,
      "external",
      "SIGKILL at 30 s",
      "the drain stops early",
      11,
    );

    d.rows(
      24,
      228,
      [
        [
          "Make the Pod grace period longer than the Workhorse deadline (--shutdown-timeout-ms).",
          9,
          "muted",
          MONO,
          400,
        ],
      ],
      "start",
    );
    return d.render(this.slug, 960, 244, drainTitle, drainDescription);
  },
};

/** The drain diagram for screens up to 600 px wide: one moment on each line. */
export const kubernetesDrainNarrow = {
  slug: "kubernetes-drain-narrow",
  title: drainTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["0 s", "backend", "termination signal", "/readyz 503 · /livez 200"],
        ["110 s", "focal", "the drain deadline ends", "the process exits at the latest"],
        ["120 s", "store", "the grace period ends", "this manifest"],
        ["default", "external", "SIGKILL at 30 s", "the drain stops early"],
      ],
      ["Make the grace period longer than the", "Workhorse deadline."],
    );
    return d.render(this.slug, 400, height, drainTitle, drainDescription);
  },
};
