/**
 * How a queue's fleet-wide admission budget reads in the dashboard.
 *
 * A worker's slot count limits one process. A concurrency policy limits dispatch across every
 * worker sharing the database, so the operator question these helpers answer is "why is ready
 * work not starting even though workers are free?". The wording therefore always names the
 * budget rather than the process. Queue and system summaries use bounded aggregates only. The task
 * drawer may show the selected task's own key, which is the only place a raw key appears.
 *
 * The text lives here rather than in the components so the phrasing can be asserted without a
 * renderer, and so the Queues page, system queue pressure, and the task drawer cannot drift into
 * three different explanations of the same number.
 */

import type { DashboardConcurrencyPolicySummary } from "@workhorse/dashboard-server/wire";

/** One queue's limit cell: how much of the fleet-wide budget is in use. */
export interface ConcurrencyLimitDisplay {
  /** `active / maxActive`, or an em dash when the queue has no policy. */
  label: string;
  /** Sentence shown on hover and to assistive technology. Always true on its own. */
  title: string;
}

const noPolicyTitle =
  "This queue has no fleet-wide limit, so only worker slots limit how many of its tasks run at once.";

export function describeConcurrencyLimit(
  policy: DashboardConcurrencyPolicySummary | null,
): ConcurrencyLimitDisplay {
  if (policy === null) return { label: "—", title: noPolicyTitle };
  return {
    label: `${policy.active} / ${policy.maxActive}`,
    title: `Fleet-wide budget: at most ${policy.maxActive} ${plural(policy.maxActive, "task")} from this queue may run at once across every worker sharing this database. ${policy.active} ${policy.active === 1 ? "is" : "are"} active now, leaving ${policy.available}.`,
  };
}

/**
 * The per-key half of the budget, kept to one short line under the limit.
 *
 * A null per-key limit is not a zero: it means keyed admission is switched off while the queue
 * budget still applies, so it is reported as absent rather than as a number.
 */
export interface ConcurrencyKeyDisplay {
  label: string | null;
  title: string;
  /** True when at least one key has reached its limit, which is what makes the line worth reading. */
  saturated: boolean;
}

export function describeConcurrencyKeys(
  policy: DashboardConcurrencyPolicySummary | null,
): ConcurrencyKeyDisplay {
  if (policy === null || policy.maxActivePerKey === null) {
    return {
      label: null,
      title:
        "This queue does not limit tasks by concurrency key, so only its queue-wide budget applies.",
      saturated: false,
    };
  }
  const saturated = policy.saturatedKeys > 0;
  const parts = [`Per key ${policy.maxActivePerKey}`];
  if (saturated) parts.push(`${policy.saturatedKeys} ${plural(policy.saturatedKeys, "key")} full`);
  return {
    label: parts.join(" · "),
    title: `Each concurrency key in this queue may run at most ${policy.maxActivePerKey} ${plural(policy.maxActivePerKey, "task")} at once. ${
      saturated
        ? `${policy.saturatedKeys} ${plural(policy.saturatedKeys, "key")} ${policy.saturatedKeys === 1 ? "has" : "have"} reached that limit; the busiest key is running ${policy.highestKeyActive}.`
        : `No key has reached that limit; the busiest key is running ${policy.highestKeyActive}.`
    }`,
    saturated,
  };
}

/** Ready tasks the budget is holding back. Emphasised only when the count is positive. */
export interface ConcurrencyBlockedDisplay {
  label: string;
  title: string;
  /** True when ready work is waiting on the budget, which the row colours amber. */
  blocking: boolean;
}

export function describeConcurrencyBlocked(
  policy: DashboardConcurrencyPolicySummary | null,
): ConcurrencyBlockedDisplay {
  if (policy === null) return { label: "—", title: noPolicyTitle, blocking: false };
  if (policy.blockedReady === 0) {
    return {
      label: "0",
      title:
        "No ready task in the scanned window is waiting on this budget. Workhorse scans a bounded window of the queue, so this count is a lower bound rather than the whole backlog.",
      blocking: false,
    };
  }
  return {
    label: String(policy.blockedReady),
    title: `At least ${policy.blockedReady} ready ${plural(policy.blockedReady, "task")} cannot start because this budget is full. Workhorse scans a bounded window of the queue, so this count is a lower bound rather than the whole backlog.`,
    blocking: true,
  };
}

/**
 * Footnote shown when `Queue.health()` truncated its own scan.
 *
 * Without it a capped read looks like a complete one, and an operator would conclude a queue has
 * no policy when the summary simply stopped counting.
 */
export const concurrencyCappedFootnote =
  "Limit figures come from a bounded sample, so some queues or blocked tasks may not be counted.";

/**
 * The task drawer's one concurrency line.
 *
 * Two different truths share this line, and keeping them apart is the whole point of the type.
 * A task's `concurrencyKey` is part of its identity: it was fixed at enqueue and stays true
 * forever. A queue's policy is not; nothing snapshots the limits a task ran under, so the numbers
 * available for a finished task are the limits in force *now*.
 *
 * While a task is ready or active those two coincide, so the line reads as live utilisation. A
 * scheduled task will compete once it becomes ready, so it reads as the budget it is about to
 * enter. A task with no runtime row is not competing at all: the line drops every live count and
 * states the queue's limits as current, which is the only claim the data supports. `null` means
 * the drawer shows no line.
 */
export interface TaskConcurrencyDisplay {
  /** The task's own immutable key, or null when it was enqueued without one. */
  concurrencyKey: string | null;
  /** Hover text for the key badge. Says plainly that the key belongs to the task, not the queue. */
  keyTitle: string;
  /**
   * The facts beside the key, as `label value` fragments rather than a sentence.
   *
   * Live counts while the task competes, configured ceilings once it stops. The fragments state no
   * tense of their own: `basisLabel` carries that claim, and a component must render it, so the
   * same number is never qualified twice in one line.
   */
  summary: string;
  /** Hover text for the summary. Carries the "current, not historical" caveat when finished. */
  title: string;
  /**
   * Whether the line could say how much of the budget is in use.
   *
   * False for a task that is still competing, or about to, whose queue has an exactly known ceiling
   * but no utilization row in `Queue.health()`. That happens once a deployment holds more policies
   * than the health summary measures. The summary then states the ceiling alone, because an
   * unmeasured queue is not an idle one and zeroes would read as one. True everywhere else,
   * including a settled task, whose line claims no utilization in the first place. Components use
   * this to mark the line as bounded, never to hide it.
   */
  utilizationKnown: boolean;
  /**
   * Which claim the summary makes. `live` is this task's own competition for the budget right now;
   * `pending` is the budget it will enter when it becomes ready; `current` is the queue's present
   * configuration shown beside a task that has stopped competing. Components use it to label the
   * line rather than to hide it.
   */
  basis: "live" | "pending" | "current";
  /**
   * The visible marker for a summary that is not live, or null when it is.
   *
   * The summary states numbers and nothing about when they were true, so this is the one place the
   * tense is written. A component renders it beside the summary; without it a finished task's
   * ceilings would read as the ones it ran under.
   */
  basisLabel: string | null;
}

const basisLabels = {
  live: null,
  pending: "budget when ready",
  current: "queue policy now",
} as const;

const noSnapshotCaveat =
  "Workhorse does not record the limits a task ran under, so these are the queue's limits now and may differ from the limits in force while this task ran.";

export function describeTaskConcurrency(job: {
  identity: { state: string; concurrencyKey?: string | null };
  concurrencyPolicy?: DashboardConcurrencyPolicySummary | null;
  current: { runtime: { state: string } | null };
}): TaskConcurrencyDisplay | null {
  const runtimeState = job.current.runtime?.state ?? null;
  const concurrencyKey = job.identity.concurrencyKey ?? null;
  const policy = job.concurrencyPolicy ?? null;
  if (concurrencyKey === null && policy === null) return null;
  const keyTitle =
    concurrencyKey === null
      ? "This task was enqueued without a concurrency key. That fact is part of the task and never changes."
      : `This task was enqueued with concurrency key ${concurrencyKey}. The key is part of the task and never changes.`;
  if (runtimeState === null) return settledTaskConcurrency(concurrencyKey, keyTitle, policy);
  const basis = runtimeState === "scheduled" ? "pending" : "live";
  if (policy === null) {
    return {
      concurrencyKey,
      keyTitle,
      summary: "no queue limit",
      title: noPolicyTitle,
      utilizationKnown: true,
      basis,
      basisLabel: basisLabels[basis],
    };
  }
  if (!policy.utilizationKnown) {
    return unmeasuredTaskConcurrency(concurrencyKey, keyTitle, policy, basis);
  }
  const keys = describeConcurrencyKeys(policy);
  const parts = [`in use ${policy.active} of ${policy.maxActive}`];
  if (keys.label !== null) parts.push(keys.label.toLowerCase());
  if (policy.blockedReady > 0) {
    parts.push(`${policy.blockedReady}+ ready blocked`);
  }
  const capacityRole =
    basis === "pending"
      ? concurrencyKey === null
        ? "When it becomes ready, this task will consume queue capacity only."
        : policy.maxActivePerKey === null
          ? "When it becomes ready, this task will consume queue capacity only because this queue does not limit tasks by key."
          : `When it becomes ready, this task will compete for its key's capacity as well. ${keys.title}`
      : concurrencyKey === null
        ? "This task has no concurrency key, so it consumes queue capacity only."
        : policy.maxActivePerKey === null
          ? "This task has a concurrency key, but this queue does not limit tasks by key. It consumes queue capacity only."
          : `This task competes for its key's capacity as well. ${keys.title}`;
  return {
    concurrencyKey,
    keyTitle,
    summary: parts.join(" · "),
    title: `${basis === "pending" ? "This task is scheduled, so it will enter this budget when it becomes ready. " : ""}${describeConcurrencyLimit(policy).title} ${capacityRole}`,
    utilizationKnown: true,
    basis,
    basisLabel: basisLabels[basis],
  };
}

/**
 * The ceiling-only line for a task competing in a queue the health summary did not measure.
 *
 * `Queue.health()` returns utilization for a bounded number of policies, while task detail reads
 * this task's own policy exactly. Past that bound the ceiling is a fact and every count beside it
 * is absent. Printing the absent counts as `0 of 7 active` would tell an operator the queue is
 * idle, which is the opposite of what a large deployment usually means, so the counts are dropped
 * and `utilizationKnown` tells the component to mark the line instead.
 */
function unmeasuredTaskConcurrency(
  concurrencyKey: string | null,
  keyTitle: string,
  policy: DashboardConcurrencyPolicySummary,
  basis: "live" | "pending",
): TaskConcurrencyDisplay {
  const parts = [`queue limit ${policy.maxActive}`];
  if (policy.maxActivePerKey !== null) parts.push(`per key ${policy.maxActivePerKey}`);
  const keyed =
    concurrencyKey === null
      ? basis === "pending"
        ? "When it becomes ready, this task will consume queue capacity only."
        : "This task has no concurrency key, so it consumes queue capacity only."
      : policy.maxActivePerKey === null
        ? basis === "pending"
          ? "When it becomes ready, this task will consume queue capacity only because this queue does not limit tasks by key."
          : "This task has a concurrency key, but this queue does not limit tasks by key. It consumes queue capacity only."
        : basis === "pending"
          ? "When it becomes ready, this task will compete for its key's capacity as well."
          : "This task competes for its key's capacity as well.";
  return {
    concurrencyKey,
    keyTitle,
    summary: parts.join(" · "),
    title: `${basis === "pending" ? "This task is scheduled, so it will enter this budget when it becomes ready. " : ""}Fleet-wide budget: at most ${policy.maxActive} ${plural(policy.maxActive, "task")} from this queue may run at once across every worker sharing this database${
      policy.maxActivePerKey === null
        ? ", and the queue does not limit tasks by concurrency key"
        : `, and at most ${policy.maxActivePerKey} ${plural(policy.maxActivePerKey, "task")} per concurrency key`
    }. ${keyed} How much of that budget is in use now is unknown: Workhorse measures utilization for a bounded number of queues and this queue fell outside that sample, so no count is shown rather than a count of zero.`,
    utilizationKnown: false,
    basis,
    basisLabel: basisLabels[basis],
  };
}

/**
 * The settled half of the line: a task with no runtime row, which is every terminal outcome.
 *
 * Live counts are dropped entirely: `4 of 10 active` says nothing about a task that stopped
 * competing hours ago, and reading it under a terminal outcome invites the conclusion that the
 * task is still holding a slot. What survives is the queue's configured ceiling, which explains
 * why this task waited as long as it did, provided the reader knows it is the ceiling now.
 */
function settledTaskConcurrency(
  concurrencyKey: string | null,
  keyTitle: string,
  policy: DashboardConcurrencyPolicySummary | null,
): TaskConcurrencyDisplay {
  const settled = "This task is no longer competing for capacity.";
  if (policy === null) {
    return {
      concurrencyKey,
      keyTitle,
      summary: "no queue limit",
      title: `${settled} ${noPolicyTitle} ${noSnapshotCaveat}`,
      // A settled line states no utilization at all, so nothing about it is unknown.
      utilizationKnown: true,
      basis: "current",
      basisLabel: basisLabels.current,
    };
  }
  const parts = [`queue limit ${policy.maxActive}`];
  if (policy.maxActivePerKey !== null) parts.push(`per key ${policy.maxActivePerKey}`);
  return {
    concurrencyKey,
    keyTitle,
    summary: parts.join(" · "),
    title: `${settled} This queue currently admits at most ${policy.maxActive} ${plural(policy.maxActive, "task")} at once across every worker sharing this database${
      policy.maxActivePerKey === null
        ? ", and does not limit tasks by concurrency key"
        : `, and at most ${policy.maxActivePerKey} ${plural(policy.maxActivePerKey, "task")} per concurrency key`
    }. ${noSnapshotCaveat}`,
    utilizationKnown: true,
    basis: "current",
    basisLabel: basisLabels.current,
  };
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}
