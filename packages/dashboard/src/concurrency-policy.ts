/**
 * How a queue's fleet-wide admission budget reads in the dashboard.
 *
 * A worker's slot count limits one process. A concurrency policy limits dispatch across every
 * worker sharing the database, so the operator question these helpers answer is "why is ready
 * work not starting even though workers are free?". The wording therefore always names the
 * budget rather than the process, and never shows a raw concurrency key: the read model reports
 * bounded aggregates only.
 *
 * The text lives here rather than in the components so the phrasing can be asserted without a
 * renderer, and so the Queues page, system queue pressure, and the task drawer cannot drift into
 * three different explanations of the same number.
 */

import type { DashboardConcurrencyPolicySummary } from "./model.js";

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
 * The task drawer's one policy line, for a task that can still be admitted.
 *
 * A finished task is never described: its key no longer competes for anything, so repeating the
 * budget under a terminal outcome would be noise. `null` means the drawer shows no line at all.
 */
export interface TaskConcurrencyDisplay {
  concurrencyKey: string | null;
  summary: string;
  title: string;
}

export function describeTaskConcurrency(job: {
  identity: { state: string; concurrencyKey?: string | null };
  concurrencyPolicy?: DashboardConcurrencyPolicySummary | null;
  current: { runtime: { state: string } | null };
}): TaskConcurrencyDisplay | null {
  const runtimeState = job.current.runtime?.state ?? null;
  if (runtimeState !== "ready" && runtimeState !== "active") return null;
  const concurrencyKey = job.identity.concurrencyKey ?? null;
  const policy = job.concurrencyPolicy ?? null;
  if (concurrencyKey === null && policy === null) return null;
  if (policy === null) {
    return {
      concurrencyKey,
      summary: "no fleet-wide limit on this queue",
      title: noPolicyTitle,
    };
  }
  const keys = describeConcurrencyKeys(policy);
  const parts = [`${policy.active} of ${policy.maxActive} active`];
  if (keys.label !== null) parts.push(keys.label.toLowerCase());
  if (policy.blockedReady > 0) {
    parts.push(`${policy.blockedReady}+ ready blocked`);
  }
  return {
    concurrencyKey,
    summary: parts.join(" · "),
    title: `${describeConcurrencyLimit(policy).title} ${
      concurrencyKey === null
        ? "This task has no concurrency key, so it consumes queue capacity only."
        : `This task competes for its key's capacity as well. ${keys.title}`
    }`,
  };
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}
