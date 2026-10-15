import { Diagram, MONO, type Theme } from "./diagram-svg.js";

/**
 * The diagrams that replace the Mermaid diagrams of `docs/schema-lifecycle.md` and
 * `docs/worker-processes.md`. Each keeps every node, edge, and label of its Mermaid diagram.
 *
 * Expand and contract: release 1 adds the new shape beside the old one, release 2 moves
 * application reads, then writes, to the new shape, and release 3 removes the old shape. When the
 * removal narrows `workhorse.protocol_version`, it ships as a contract step that the operator runs
 * with `workhorse schema contract --yes`.
 *
 * Worker process states: a process starts in `starting`, and leaves each state by one of the
 * eleven transitions below. `exited_ok` exits with code 0, `exited_failure` with code 1, and a
 * second `SIGINT` or `SIGTERM` during a drain exits with 130 or 143.
 *
 * Check each fact against its source before you change a label.
 */

type Kind = "focal" | "backend" | "store" | "external";

function eventList(
  d: Diagram,
  events: readonly (readonly [label: string, kind: Kind, name: string, sub: string])[],
  lines: readonly string[],
  arrows = false,
): number {
  const pitch = 56;
  events.forEach(([label, kind, name, sub], index) => {
    const top = 24 + index * pitch;
    if (arrows && index > 0) d.arrow(`M 248,${top - 14} V ${top - 2}`);
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

function footer(d: Diagram, y: number, line: string): void {
  d.rows(24, y, [[line, 9, "muted", MONO, 400]], "start");
}

// Expand and contract -------------------------------------------------------------------------

const expandTitle = "A change that spans deployments rolls out in three releases";
const expandDescription =
  "Release 1, expand: a migration adds the new shape beside the old one. Release 2, migrate: " +
  "applications move reads, then writes, to the new shape. Release 3, contract: a migration " +
  "removes the old shape. When that removal narrows workhorse.protocol_version, it ships as a " +
  "contract step that the operator runs with workhorse schema contract --yes.";

const releases: readonly (readonly [zone: string, name: string, sub: string])[] = [
  ["RELEASE 1 · EXPAND", "migration adds the new shape", "beside the old one"],
  ["RELEASE 2 · MIGRATE", "applications move to the new shape", "reads first, then writes"],
  ["RELEASE 3 · CONTRACT", "migration removes the old shape", "no supported version uses it"],
];

/** The expand and contract diagram: three releases in order, and the contract step. */
export const schemaExpandContract = {
  slug: "schema-expand-contract",
  title: expandTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    releases.forEach(([zone, name, sub], index) => {
      const x = 24 + index * 316;
      d.zone(x, 48, 280, 108, zone);
      d.box(x + 16, 76, 248, 52, index === 2 ? "focal" : "backend", name, sub, 11);
      if (index > 0) d.arrow(`M ${x - 36},102 H ${x - 2}`);
    });
    d.arrow("M 796,128 V 214", { dashed: true });
    d.label(796, 176, "narrows workhorse.protocol_version");
    d.box(656, 216, 280, 52, "external", "contract step", "workhorse schema contract --yes", 11);
    footer(
      d,
      300,
      "workhorse schema migrate does not run a contract step. The operator runs it deliberately.",
    );
    return d.render(this.slug, 960, 316, expandTitle, expandDescription);
  },
};

/** The expand and contract diagram for screens up to 600 px wide: one release on each line. */
export const schemaExpandContractNarrow = {
  slug: "schema-expand-contract-narrow",
  title: expandTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["expand", "backend", "add the new shape", "beside the old one"],
        ["migrate", "backend", "move to the new shape", "reads first, then writes"],
        ["contract", "focal", "remove the old shape", "no supported version uses it"],
        ["operator", "external", "contract step", "workhorse schema contract --yes"],
      ],
      ["The contract step narrows", "workhorse.protocol_version."],
      true,
    );
    return d.render(this.slug, 400, height, expandTitle, expandDescription);
  },
};

// Worker process states -----------------------------------------------------------------------

const statesTitle = "Every state of a worker process, and how the process leaves it";
const statesDescription =
  "A worker process starts in starting. From starting, a configuration or probe failure exits " +
  "with failure, every run loop started with readiness true makes it running, and a first signal " +
  "makes it draining after startup completes. From running, a first SIGTERM or SIGINT makes it " +
  "draining, and a fatal worker-loop failure makes it failing. From failing, the process exits " +
  "with failure when its siblings settle or the deadline is missed. From draining, it exits with " +
  "code 0 when handlers settle and resources close cleanly, with code 1 when a run loop or close " +
  "rejects or the deadline is missed, with 130 on a second SIGINT, and with 143 on a second SIGTERM.";

const transitions: readonly (readonly [from: string, to: string, trigger: string])[] = [
  ["start", "starting", "the process starts"],
  ["starting", "exited_failure", "configuration or probe failure"],
  ["starting", "running", "every run loop started, readiness true"],
  ["starting", "draining", "first signal, after startup completes"],
  ["running", "draining", "first SIGTERM or SIGINT"],
  ["running", "failing", "fatal worker-loop failure"],
  ["failing", "exited_failure", "siblings settle or deadline missed"],
  ["draining", "exited_ok", "handlers settle, resources close cleanly"],
  ["draining", "exited_failure", "run loop or close rejects, or deadline missed"],
  ["draining", "exit_130", "second SIGINT"],
  ["draining", "exit_143", "second SIGTERM"],
];

const exitCode: Readonly<Record<string, string>> = {
  exited_ok: "code 0",
  exited_failure: "code 1",
  exit_130: "code 130",
  exit_143: "code 143",
};

const stateKind = (state: string): Kind =>
  state === "draining"
    ? "focal"
    : state === "exited_ok"
      ? "store"
      : state in exitCode || state === "failing"
        ? "external"
        : "backend";

const T_ROW = 40;
const T_GAP = 16;

/** The process state diagram: one group for each source state, one row for each transition. */
export const workerProcessStates = {
  slug: "worker-process-states",
  title: statesTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.rows(24 + 80, 40, [["from", 8, "soft", MONO, 400]]);
    d.rows(480, 40, [["trigger", 8, "soft", MONO, 400]]);
    d.rows(776 + 80, 40, [["to", 8, "soft", MONO, 400]]);
    d.divider(24, 936, 48);
    let y = 64;
    let index = 0;
    while (index < transitions.length) {
      const from = transitions[index]![0];
      const group = transitions.filter(([source]) => source === from);
      group.forEach(([, to, trigger], row) => {
        const rowY = y + row * T_ROW;
        d.arrow(`M 184,${rowY + 16} H 774`);
        d.label(480, rowY + 10, trigger);
        d.box(776, rowY, 160, 32, stateKind(to), to, exitCode[to], 10);
      });
      d.box(
        24,
        y,
        160,
        group.length * T_ROW - 8,
        from === "start" ? "external" : stateKind(from),
        from,
        undefined,
        12,
      );
      y += group.length * T_ROW + T_GAP;
      index += group.length;
    }
    footer(
      d,
      y + 8,
      "While draining, readiness is false, and the worker starts no new claim pass.",
    );
    return d.render(this.slug, 960, y + 24, statesTitle, statesDescription);
  },
};

/** The process state diagram for screens up to 600 px wide: one transition on each line. */
export const workerProcessStatesNarrow = {
  slug: "worker-process-states-narrow",
  title: statesTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      transitions.map(
        ([from, to, trigger]) =>
          [
            from,
            stateKind(to),
            exitCode[to] === undefined ? `→ ${to}` : `→ ${to} · ${exitCode[to]}`,
            trigger,
          ] as const,
      ),
      ["Grouped by the state that each", "transition leaves."],
    );
    return d.render(this.slug, 400, height, statesTitle, statesDescription);
  },
};
