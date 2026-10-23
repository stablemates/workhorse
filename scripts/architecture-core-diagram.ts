import { Diagram, MONO, type Theme } from "./diagram-svg.js";

/**
 * The diagrams that replace the Mermaid diagrams of `docs/architecture/overview.md` and
 * `docs/architecture/lifecycle.md`. Each diagram keeps every node, edge, and label of the Mermaid
 * diagram that it replaces, and uses only real identifiers.
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

// System context ------------------------------------------------------------------------------

const contextTitle =
  "Every component reaches the durable state through SQL functions in PostgreSQL";
const contextDescription =
  "The application transaction calls enqueue_v1 or enqueue_batch_v1. The deployment syncs " +
  "schedules. The TypeScript Worker calls claim_many_v1, heartbeat_many_v2, acknowledge_cancel_v1, " +
  "complete_v1, fail_v1, register_worker_v1, tick_v1, fire_due_schedules_v2, and the split " +
  "maintenance routines, and gets the payload, attempt, fence, and operator pause flag. The " +
  "operator layer calls cancel_v1 with attribution, list_dead_letters_v1, redrive_v1, and " +
  "redrive_many_v1. The dashboard reads the read model and worker_registry and calls " +
  "Admin.setWorkerPaused with attribution. Health and scenarios read runtime, outcome, and " +
  "statistics. A process supervisor sends SIGINT or SIGTERM to the dedicated worker process, and " +
  "the handler runs external effects outside the SQL transaction.";

const callers: readonly (readonly [
  name: string,
  sub: string | undefined,
  kind: Kind,
  calls: string,
])[] = [
  ["application", "a transaction", "backend", "enqueue_v1 · enqueue_batch_v1"],
  ["deployment", undefined, "backend", "schedule sync"],
  [
    "TypeScript Worker",
    "claim and lease",
    "focal",
    "claim_many_v1 · heartbeat_many_v2 · acknowledge_cancel_v1",
  ],
  ["TypeScript Worker", "settle", "focal", "complete_v1 · fail_v1"],
  [
    "TypeScript Worker",
    "maintain",
    "focal",
    "register_worker_v1 · tick_v1 · fire_due_schedules_v2 · routines",
  ],
  [
    "operator layer",
    "with attribution",
    "backend",
    "cancel_v1 · list_dead_letters_v1 · redrive_v1 · redrive_many_v1",
  ],
  [
    "dashboard",
    "pause with attribution",
    "backend",
    "read model · worker_registry · Admin.setWorkerPaused",
  ],
  ["health and scenarios", undefined, "backend", "reads runtime · outcome · statistics"],
];

const ROW = 48;
const PG_X = 784;

/** The system context: every caller with its SQL functions, then the worker process. */
export const systemContext = {
  slug: "system-context",
  title: contextTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const top = 48;
    callers.forEach(([, , , calls], index) => {
      const y = top + index * ROW;
      d.arrow(`M 232,${y + 18} H ${PG_X - 2}`);
      d.label((232 + PG_X) / 2, y + 12, calls);
    });
    callers.forEach(([name, sub, kind], index) => {
      d.box(24, top + index * ROW, 208, 36, kind === "focal" ? "backend" : kind, name, sub, 11);
    });
    const pgBottom = top + callers.length * ROW - 12;
    d.box(PG_X, top, 152, pgBottom - top, "store", "PostgreSQL", "the durable authority", 12);

    const workerY = pgBottom + 60;
    d.arrow(`M ${PG_X + 76},${pgBottom} V ${workerY - 2}`);
    d.label(PG_X + 76, pgBottom + 12, "payload + attempt + fence");
    d.label(PG_X + 76, pgBottom + 30, "operator pause flag");
    d.arrow(`M 232,${workerY + 26} H ${PG_X - 2}`);
    d.label((232 + PG_X) / 2, workerY + 20, "SIGINT / SIGTERM");
    d.box(24, workerY, 208, 52, "external", "process supervisor", undefined, 11);
    d.box(PG_X, workerY, 152, 52, "focal", "TypeScript Worker", "dedicated process", 11);

    const effectsY = workerY + 108;
    d.arrow(`M ${PG_X + 76},${workerY + 52} V ${effectsY - 2}`);
    d.label(PG_X + 76, workerY + 72, "handler outside SQL transaction");
    d.box(PG_X, effectsY, 152, 44, "external", "external effects", undefined, 11);

    footer(
      d,
      effectsY + 76,
      "A worker owns a task only while the active task_runtime row matches its worker ID and fence token and has not expired.",
    );
    return d.render(this.slug, 960, effectsY + 92, contextTitle, contextDescription);
  },
};

/** The system context for screens up to 600 px wide: one caller on each line. */
export const systemContextNarrow = {
  slug: "system-context-narrow",
  title: contextTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["app", "backend", "enqueue_v1", "and enqueue_batch_v1"],
        ["deploy", "backend", "schedule sync", "in the deployment"],
        ["worker", "focal", "claim · heartbeat · settle", "register · tick · routines"],
        ["operator", "backend", "cancel_v1 · redrive_v1", "with attribution"],
        ["dashboard", "backend", "read model · pause", "worker_registry"],
        ["health", "backend", "reads", "runtime · outcome · statistics"],
        ["effects", "external", "external effects", "outside the SQL transaction"],
      ],
      ["PostgreSQL is the durable authority."],
    );
    return d.render(this.slug, 400, height, contextTitle, contextDescription);
  },
};

// Task states ---------------------------------------------------------------------------------

const statesTitle = "Every lifecycle transition, grouped by the state that it leaves";
const statesDescription =
  "Enqueue creates a blocked task with a live prerequisite, a ready task when it is due, or a " +
  "scheduled task in the future. A blocked task becomes ready or scheduled when its prerequisite " +
  "succeeds after or before run_at. Blocked, scheduled, and ready tasks can be canceled " +
  "immediately. Promote moves scheduled to ready, and a claim moves ready to active. An active " +
  "task stays active on a heartbeat or a cancel request. It becomes canceled on an exact-fence " +
  "acknowledgement or a requested lease expiry, scheduled on a named durable wait in the same " +
  "attempt, ready or scheduled on fail or recover with a zero or positive delay, succeeded on " +
  "complete, and failed on an exhausted fail or recovery.";

const transitions: readonly (readonly [from: string, to: string, trigger: string])[] = [
  ["enqueue", "blocked", "with a live prerequisite"],
  ["enqueue", "ready", "due"],
  ["enqueue", "scheduled", "in the future"],
  ["blocked", "ready", "prerequisite succeeds after run_at"],
  ["blocked", "scheduled", "prerequisite succeeds before run_at"],
  ["blocked", "canceled", "cancel immediately"],
  ["scheduled", "ready", "promote"],
  ["scheduled", "canceled", "cancel immediately"],
  ["ready", "active", "claim"],
  ["ready", "canceled", "cancel immediately"],
  ["active", "active", "heartbeat / cancel request"],
  ["active", "canceled", "exact-fence acknowledgement or requested lease expiry"],
  ["active", "scheduled", "named durable wait, same attempt"],
  ["active", "ready", "fail/recover, selected or overridden zero delay"],
  ["active", "scheduled", "fail/recover, selected or overridden positive delay"],
  ["active", "succeeded", "complete"],
  ["active", "failed", "exhausted fail/recovery"],
];

const stateKind = (state: string): Kind =>
  state === "active"
    ? "focal"
    : state === "succeeded"
      ? "store"
      : state === "failed" || state === "canceled"
        ? "external"
        : "backend";

const T_ROW = 36;
const T_GAP = 16;

/** The transition diagram: one group for each source state, one row for each transition. */
export const taskStates = {
  slug: "task-states",
  title: statesTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.rows(24 + 80, 40, [["from", 8, "soft", MONO, 400]]);
    d.rows(500, 40, [["trigger", 8, "soft", MONO, 400]]);
    d.rows(776 + 80, 40, [["to", 8, "soft", MONO, 400]]);
    d.divider(24, 936, 48);
    let y = 64;
    let index = 0;
    while (index < transitions.length) {
      const from = transitions[index]![0];
      const group = transitions.filter(([source]) => source === from);
      group.forEach(([, to, trigger], row) => {
        const rowY = y + row * T_ROW;
        d.arrow(`M 184,${rowY + 14} H 774`);
        d.label(480, rowY + 8, trigger);
        d.box(776, rowY, 160, 28, stateKind(to), to, undefined, 11);
      });
      const height = group.length * T_ROW - 8;
      d.box(
        24,
        y,
        160,
        height,
        from === "enqueue" ? "external" : stateKind(from),
        from,
        undefined,
        12,
      );
      y += group.length * T_ROW + T_GAP;
      index += group.length;
    }
    footer(d, y + 8, "A task in blocked, scheduled, ready, or active has one task_runtime row.");
    return d.render(this.slug, 960, y + 24, statesTitle, statesDescription);
  },
};

/** Short forms for the narrow variant. Each keeps the condition of the full trigger. */
const shortTrigger: Readonly<Record<string, string>> = {
  "exact-fence acknowledgement or requested lease expiry":
    "exact-fence ack or requested lease expiry",
  "fail/recover, selected or overridden zero delay": "fail/recover, zero delay",
  "fail/recover, selected or overridden positive delay": "fail/recover, positive delay",
};

/** The transition diagram for screens up to 600 px wide: one transition on each line. */
export const taskStatesNarrow = {
  slug: "task-states-narrow",
  title: statesTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      transitions.map(
        ([from, to, trigger]) =>
          [from, stateKind(to), `→ ${to}`, shortTrigger[trigger] ?? trigger] as const,
      ),
      ["Grouped by the state that each", "transition leaves."],
    );
    return d.render(this.slug, 400, height, statesTitle, statesDescription);
  },
};

// Maintenance cadence -------------------------------------------------------------------------

const cadenceTitle =
  "Each worker runs the tick at one cadence and the maintenance routines at another";
const cadenceDescription =
  "Every worker calls tick_v1 every maintenanceIntervalMs, 1 s by default. Under the workhorse:tick " +
  "advisory lock, tick_v1 promotes scheduled tasks to ready, then recovers expired leases. At the " +
  "same cadence, and only with scheduleNamespaces set, the worker evaluates schedules. Every " +
  "maintenanceRoutinePollMs, 60 s by default, it calls run_maintenance_v1, which runs " +
  "rollup_stats_v1, prune_terminal_storage_v1, prune_worker_registry_v1, retain_history_v1, " +
  "and prepare_history_partitions_v1 in this order.";

const routines = [
  "rollup_stats_v1",
  "prune_terminal_storage_v1",
  "prune_worker_registry_v1",
  "retain_history_v1",
  "prepare_history_partitions_v1",
] as const;

/** The cadence diagram: the worker, the tick, the schedule evaluation, and the routines. */
export const maintenanceCadence = {
  slug: "maintenance-cadence",
  title: cadenceTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.box(24, 48, 152, 336, "focal", "every worker", undefined, 12);

    d.arrow("M 176,108 H 230");
    d.zone(
      232,
      56,
      704,
      104,
      "tick_v1 · every maintenanceIntervalMs, default 1 s · workhorse:tick lock",
    );
    d.arrow("M 572,108 H 594");
    d.box(248, 84, 324, 48, "backend", "promote", "scheduled to ready", 11);
    d.box(596, 84, 324, 48, "backend", "recover", "expired leases", 11);

    d.arrow("M 176,204 H 246", { dashed: true });
    d.box(
      248,
      180,
      672,
      48,
      "external",
      "schedule evaluation",
      "same cadence · only with scheduleNamespaces set",
      11,
    );

    d.arrow("M 176,316 H 230");
    d.zone(232, 252, 704, 132, "run_maintenance_v1 · every maintenanceRoutinePollMs, default 60 s");
    const width = 216;
    const xs = [248, 476, 704] as const;
    routines.forEach((routine, index) => {
      const row = index < 3 ? 0 : 1;
      const col = index < 3 ? index : index - 3;
      const x = xs[col]!;
      const y = 276 + row * 56;
      d.box(x, y, width, 44, "store", `${index + 1}`, routine, 11);
      if (index > 0 && index !== 3) d.arrow(`M ${xs[col - 1]! + width},${y + 22} H ${x - 2}`);
    });
    d.arrow(`M ${xs[2] + width / 2},320 V 326 H ${xs[0] + width / 2} V 330`);

    footer(d, 416, "Between passes, a worker sends only the claim query.");
    return d.render(this.slug, 960, 432, cadenceTitle, cadenceDescription);
  },
};

/** The cadence diagram for screens up to 600 px wide: one cadence on each line. */
export const maintenanceCadenceNarrow = {
  slug: "maintenance-cadence-narrow",
  title: cadenceTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["1 s", "backend", "tick_v1", "promote, then recover"],
        ["1 s", "external", "schedule evaluation", "only with scheduleNamespaces"],
        ["60 s", "store", "run_maintenance_v1", "five routines in order"],
      ],
      ["The defaults of maintenanceIntervalMs", "and maintenanceRoutinePollMs."],
    );
    return d.render(this.slug, 400, height, cadenceTitle, cadenceDescription);
  },
};

// Durable suspensions -------------------------------------------------------------------------

const suspendTitle =
  "A suspension clears the owner but keeps the attempt; the wake makes it claimable";
const suspendDescription =
  "An active task with worker and fence N calls schedule_wait_v1 with a future target, " +
  "wait_for_signal_v1, or wait_for_human_v1. The task becomes scheduled with wait_name set and no " +
  "owner, or scheduled and parked with a pending task_signal_wait or task_human_wait. promote_v1 " +
  "at run_at, send_signal_v1, or complete_human_wait_v1 makes it ready in the same attempt. A " +
  "claim with fence N+k makes it active, and the handler restarts from entry, where the named " +
  "wait replays.";

const suspensions: readonly (readonly [
  call: readonly [string, string],
  state: string,
  wake: string,
])[] = [
  [["schedule_wait_v1", "a future target"], "wait_name set, no owner", "promote_v1 at run_at"],
  [["wait_for_signal_v1", "parked"], "task_signal_wait pending", "send_signal_v1"],
  [["wait_for_human_v1", "parked"], "task_human_wait pending", "complete_human_wait_v1"],
];

/** The suspension diagram: three suspensions from active, one shared wake to ready. */
export const durableSuspensions = {
  slug: "durable-suspensions",
  title: suspendTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    d.rows(24 + 64, 40, [["active", 8, "soft", MONO, 400]]);
    d.rows(176 + 104, 40, [["suspend", 8, "soft", MONO, 400]]);
    d.rows(416 + 112, 40, [["scheduled, no owner", 8, "soft", MONO, 400]]);
    d.rows(720, 40, [["wake", 8, "soft", MONO, 400]]);
    d.rows(868, 40, [["ready", 8, "soft", MONO, 400]]);
    d.divider(24, 936, 48);
    d.box(24, 64, 128, 196, "focal", "active", "fence N", 12);
    suspensions.forEach(([[call, callSub], state, wake], index) => {
      const y = 64 + index * 76;
      d.arrow(`M 152,${y + 24} H 174`);
      d.box(176, y, 208, 48, "backend", call, callSub, 11);
      d.arrow(`M 384,${y + 24} H 414`);
      d.box(416, y, 224, 48, "store", "scheduled", state, 11);
      d.arrow(`M 640,${y + 24} H 798`);
      d.label(720, y + 18, wake);
    });
    d.box(800, 64, 136, 196, "store", "ready", "same attempt", 12);
    d.arrow("M 868,260 V 298");
    d.label(868, 272, "claim, fence N+k");
    d.box(
      560,
      300,
      376,
      52,
      "focal",
      "active",
      "handler restarts from entry · named wait replays",
      11,
    );
    footer(d, 384, "Each suspension clears ownership but does not close the logical attempt.");
    return d.render(this.slug, 960, 400, suspendTitle, suspendDescription);
  },
};

/** The suspension diagram for screens up to 600 px wide: one suspension on each line. */
export const durableSuspensionsNarrow = {
  slug: "durable-suspensions-narrow",
  title: suspendTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["timer", "backend", "schedule_wait_v1", "wake: promote_v1 at run_at"],
        ["signal", "backend", "wait_for_signal_v1", "wake: send_signal_v1"],
        ["human", "backend", "wait_for_human_v1", "wake: complete_human_wait_v1"],
        ["then", "store", "ready", "the same attempt"],
        ["claim", "focal", "active · fence N+k", "the named wait replays"],
      ],
      ["A suspension does not close the attempt."],
    );
    return d.render(this.slug, 400, height, suspendTitle, suspendDescription);
  },
};

// Lease recovery ------------------------------------------------------------------------------

const leaseTitle =
  "Recovery replaces the generation, so the late write of the old worker matches no row";
const leaseDescription =
  "Worker A calls claim_many_v1 and gets the task with attempt 1 and fence 41. Its heartbeat_many_v2 " +
  "with fence 41 is accepted, and expires_at is extended. Then A stalls past its lease. Worker B " +
  "calls tick_v1, which calls recover_expired_v1: the lease expires, and the task is ready with " +
  "attempt 2. B calls claim_many_v1 and gets attempt 2 with fence 42. The late complete_v1 of A " +
  "with fence 41 returns false, because no generation matches. The complete_v1 of B with fence 42 " +
  "returns true: the runtime row is deleted, and the outcome is inserted.";

const LANES = { a: 140, pg: 480, b: 820 } as const;

const messages: readonly (readonly [
  from: keyof typeof LANES,
  to: keyof typeof LANES,
  text: string,
  dashed?: boolean,
])[] = [
  ["a", "pg", "claim_many_v1"],
  ["pg", "a", "task, attempt 1, fence 41", true],
  ["a", "pg", "heartbeat_many_v2 (fence 41)"],
  ["pg", "a", "accepted, expires_at extended", true],
  ["b", "pg", "tick_v1 calls recover_expired_v1"],
  ["b", "pg", "claim_many_v1"],
  ["pg", "b", "task, attempt 2, fence 42", true],
  ["a", "pg", "complete_v1 (fence 41)"],
  ["pg", "a", "false, no generation matches", true],
  ["b", "pg", "complete_v1 (fence 42)"],
  ["pg", "b", "true, runtime deleted, outcome inserted", true],
];

/** The lease sequence: three lifelines and the messages between them, top to bottom. */
export const leaseRecovery = {
  slug: "lease-recovery",
  title: leaseTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const heads: readonly (readonly [keyof typeof LANES, string, Kind])[] = [
      ["a", "Worker A", "backend"],
      ["pg", "PostgreSQL", "store"],
      ["b", "Worker B", "focal"],
    ];
    const pitch = 34;
    const first = 108;
    const notes: Record<number, readonly [keyof typeof LANES, string]> = {
      4: ["a", "A stalls past its lease"],
      5: ["pg", "lease_expired, attempt 2, ready"],
    };
    let y = first;
    const ys: number[] = [];
    messages.forEach((_, index) => {
      if (notes[index] !== undefined) y += pitch;
      ys.push(y);
      y += pitch;
    });
    const bottom = y;
    heads.forEach(([lane]) => {
      d.box(LANES[lane] - 1, 76, 2, bottom - 76, "store");
    });
    heads.forEach(([lane, name, kind]) => {
      d.box(LANES[lane] - 90, 40, 180, 36, kind, name, undefined, 11);
    });
    messages.forEach(([from, to, text, dashed], index) => {
      const msgY = ys[index]!;
      const note = notes[index];
      if (note !== undefined) {
        d.box(LANES[note[0]] - 110, msgY - pitch - 12, 220, 24, "external", note[1], undefined, 10);
      }
      const x1 = LANES[from];
      const x2 = LANES[to];
      const end = x2 > x1 ? x2 - 4 : x2 + 4;
      d.arrow(`M ${x1},${msgY} H ${end}`, { dashed: dashed ?? false });
      d.label((x1 + x2) / 2, msgY - 14, text);
    });
    footer(
      d,
      bottom + 32,
      "The example retries without delay. A delayed retry waits for promotion first.",
    );
    return d.render(this.slug, 960, bottom + 48, leaseTitle, leaseDescription);
  },
};

/** The lease sequence for screens up to 600 px wide: one message on each line. */
export const leaseRecoveryNarrow = {
  slug: "lease-recovery-narrow",
  title: leaseTitle,
  render(theme: Theme): string {
    const d = new Diagram(theme);
    const height = eventList(
      d,
      [
        ["A", "backend", "claim_many_v1", "attempt 1, fence 41"],
        ["A", "backend", "heartbeat_many_v2", "accepted · A then stalls"],
        ["B", "store", "tick_v1", "recover_expired_v1 · attempt 2"],
        ["B", "focal", "claim_many_v1", "attempt 2, fence 42"],
        ["A", "external", "complete_v1 (fence 41)", "false, no generation matches"],
        ["B", "focal", "complete_v1 (fence 42)", "true, outcome inserted"],
      ],
      ["The late write of worker A matches", "no row."],
      true,
    );
    return d.render(this.slug, 400, height, leaseTitle, leaseDescription);
  },
};
