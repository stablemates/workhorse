import type {
  DashboardQueuesPage,
  DashboardQueueTier,
} from "@stablemates/workhorse-dashboard-server/wire";
import { ActionIcon, Code, Group, Loader, Table, Text, VisuallyHidden } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { MoreVerticalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Menu } from "../dropdown-activity.js";
import { Switch } from "../ui.js";
import { OptimisticSwitch } from "../components/optimistic-switch.js";
import {
  concurrencyCappedFootnote,
  describeConcurrencyBlocked,
  describeConcurrencyKeys,
  describeConcurrencyLimit,
} from "../concurrency-policy.js";
import { describeRateLimit, describeRateThrottle, rateLimitCappedFootnote } from "../rate-limit.js";
import { BudgetsTable, budgetCappedFootnote } from "../budgets-table.js";
import { ExplainedValue } from "../components/explained-value.js";
import { warningTextColor } from "../status-colors.js";
import {
  describeQueueTier,
  queueTierActions,
  type QueueTierActionId,
  type QueueTierCapabilities,
} from "../queue-tier.js";
import { EmptyState } from "../components/empty-state.js";
import { Page, PageHeader, TablePanel } from "../components/page-header.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { HelpButton } from "../components/help-button.js";
import { formatCount } from "../count-format.js";

export function QueuesPage({
  data,
  togglingQueue,
  purgingQueue,
  confirmingQueue,
  setQueuePaused,
  setConfirmingQueue,
  purgeQueue,
  changingQueue,
  tierCapabilities,
  setQueueTier,
  setQueueHistory,
}: {
  data: DashboardQueuesPage;
  togglingQueue: string | null;
  purgingQueue: string | null;
  confirmingQueue: string | null;
  setQueuePaused: (queue: string, paused: boolean) => void;
  setConfirmingQueue: (queue: string | null) => void;
  purgeQueue: (queue: string) => void;
  /** The queue whose tier or history change is in flight. */
  changingQueue: string | null;
  /** What this host can change. An absent capability keeps its action visible and disabled. */
  tierCapabilities: QueueTierCapabilities;
  setQueueTier: (queue: string, tier: DashboardQueueTier) => void;
  setQueueHistory: (
    queue: string,
    change: { recordAttempts?: boolean; recordClaims?: boolean },
  ) => void;
}) {
  // A menu item opens the clear confirmation, so focus returns to the menu button of that row.
  const menuTrigger = useRef<HTMLElement | null>(null);
  const linkedQueue = useLinkedQueue();
  return (
    <Page>
      <PageHeader
        title="Queues"
        description="Pause new claims, compare concurrency and start-rate budgets, or clear tasks that have not started."
      />
      <ConfirmDialog
        open={confirmingQueue !== null}
        title="Clear this queue?"
        tone="danger"
        confirmLabel="Clear queue"
        pending={purgingQueue !== null && purgingQueue === confirmingQueue}
        onConfirm={() => {
          if (confirmingQueue !== null) purgeQueue(confirmingQueue);
        }}
        onCancel={() => setConfirmingQueue(null)}
        finalFocus={menuTrigger}
      >
        <p>
          Workhorse deletes the tasks in <Code>{confirmingQueue}</Code> that are scheduled or ready.
          Active tasks continue. You cannot undo this.
        </p>
      </ConfirmDialog>
      {data.queues.length === 0 ? (
        <EmptyState title="No queues yet">
          A queue appears here after it accepts its first task.
        </EmptyState>
      ) : (
        <TablePanel label="Queues table">
          <Table
            highlightOnHover
            className="data-table dashboard-table dashboard-table--queues"
            miw={1120}
          >
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Queue</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>
                  <Group gap={4} wrap="nowrap">
                    <span>Tier</span>
                    <HelpButton
                      label="Tier"
                      help="A full-tier queue records every attempt and claim. A fast-tier queue skips that history for throughput unless an operator turns part of it back on. Change either from the queue's row menu, or with workhorse admin set-tier and set-history. Workhorse refuses a tier change while the queue holds tasks that are not finished."
                    />
                  </Group>
                </Table.Th>
                <Table.Th className="data-table__metric">Scheduled</Table.Th>
                <Table.Th className="data-table__metric">Ready</Table.Th>
                <Table.Th className="data-table__metric">Active</Table.Th>
                <Table.Th ta="right">
                  <Group gap={4} justify="flex-end" wrap="nowrap">
                    <span>Limit</span>
                    <HelpButton
                      label="Limit"
                      help="A limit is a fleet-wide budget: it caps how many of this queue's tasks run at once across every worker sharing this database. Worker slots limit one process instead, and pausing is separate."
                    />
                  </Group>
                </Table.Th>
                <Table.Th ta="right">
                  <Group gap={4} justify="flex-end" wrap="nowrap">
                    <span>Blocked</span>
                    <HelpButton
                      label="Blocked"
                      help="Ready tasks that cannot start because the limit is full. Workhorse scans a bounded window of each queue, so this is a lower bound rather than the whole backlog."
                    />
                  </Group>
                </Table.Th>
                <Table.Th ta="right">
                  <Group gap={4} justify="flex-end" wrap="nowrap">
                    <span>Start rate</span>
                    <HelpButton
                      label="Start rate"
                      help="A token bucket limits how quickly tasks start across the fleet. The sustained rate refills tokens continuously, while burst is the most idle capacity Workhorse retains."
                    />
                  </Group>
                </Table.Th>
                <Table.Th ta="right">
                  <Group gap={4} justify="flex-end" wrap="nowrap">
                    <span>Rate-limited</span>
                    <HelpButton
                      label="Rate-limited"
                      help="Ready tasks waiting to start because a queue or per-key start-rate limit has no tokens available. Enqueue throttling instead coalesces matching submissions into one task. This count is a bounded lower bound; hover over it to see the earliest eligibility time."
                    />
                  </Group>
                </Table.Th>
                <Table.Th className="data-table__metric">Succeeded</Table.Th>
                <Table.Th className="data-table__metric">Failed</Table.Th>
                <Table.Th className="data-table__metric data-table__actions">
                  <VisuallyHidden>Actions</VisuallyHidden>
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.queues.map((queue) => {
                const approximatePrefix = queue.terminalCountsApproximate ? "~" : "";
                const policy = queue.concurrencyPolicy;
                const limit = describeConcurrencyLimit(policy);
                const keys = describeConcurrencyKeys(policy);
                const blocked = describeConcurrencyBlocked(policy);
                const ratePolicy = queue.rateLimitPolicy ?? null;
                const rate = describeRateLimit(ratePolicy);
                const throttled = describeRateThrottle(ratePolicy);
                const tier = describeQueueTier(queue);
                return (
                  <Table.Tr
                    key={queue.queue}
                    id={`queue-${queue.queue}`}
                    className="queue-row"
                    data-linked={linkedQueue === queue.queue || undefined}
                  >
                    <Table.Td>
                      <Code className="queue-row__name">{queue.queue}</Code>
                    </Table.Td>
                    <Table.Td>
                      <Switch.Row>
                        <OptimisticSwitch
                          checked={!queue.paused}
                          pending={togglingQueue === queue.queue}
                          aria-label={`${queue.paused ? "Resume" : "Pause"} ${queue.queue}`}
                          onCheckedChange={(checked) => setQueuePaused(queue.queue, !checked)}
                        />
                        <Switch.Label>
                          {togglingQueue === queue.queue
                            ? queue.paused
                              ? "Resuming…"
                              : "Pausing…"
                            : queue.paused
                              ? "Paused"
                              : "Running"}
                        </Switch.Label>
                      </Switch.Row>
                    </Table.Td>
                    <Table.Td>
                      <ExplainedValue size="sm" explanation={tier.title}>
                        {tier.label}
                      </ExplainedValue>
                      {tier.historyLabel === null ? null : (
                        <Text c="dimmed" size="xs">
                          {tier.historyLabel}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td className="data-table__metric">
                      {formatCount(queue.scheduled)}
                    </Table.Td>
                    <Table.Td className="data-table__metric">{formatCount(queue.ready)}</Table.Td>
                    <Table.Td className="data-table__metric">{formatCount(queue.active)}</Table.Td>
                    <Table.Td ta="right">
                      <ExplainedValue size="sm" explanation={limit.title}>
                        {limit.label}
                      </ExplainedValue>
                      {keys.label === null ? null : (
                        <ExplainedValue
                          c={keys.saturated ? warningTextColor : "dimmed"}
                          size="xs"
                          explanation={keys.title}
                        >
                          {keys.label}
                        </ExplainedValue>
                      )}
                    </Table.Td>
                    <Table.Td ta="right">
                      <ExplainedValue
                        size="sm"
                        c={blocked.blocking ? warningTextColor : undefined}
                        fw={blocked.blocking ? 650 : undefined}
                        explanation={blocked.title}
                      >
                        {blocked.label}
                      </ExplainedValue>
                    </Table.Td>
                    <Table.Td ta="right">
                      <ExplainedValue size="sm" explanation={rate.title}>
                        {rate.label}
                      </ExplainedValue>
                      {rate.keyedLabel === null ? null : (
                        <Text c="dimmed" size="xs">
                          {rate.keyedLabel}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td ta="right">
                      <ExplainedValue
                        size="sm"
                        c={throttled.throttling ? warningTextColor : undefined}
                        fw={throttled.throttling ? 650 : undefined}
                        explanation={throttled.title}
                      >
                        {throttled.label}
                      </ExplainedValue>
                    </Table.Td>
                    <Table.Td
                      ta="right"
                      title={queue.terminalCountsApproximate ? "PostgreSQL estimate" : undefined}
                    >
                      {approximatePrefix}
                      {formatCount(queue.succeeded)}
                    </Table.Td>
                    <Table.Td
                      ta="right"
                      title={queue.terminalCountsApproximate ? "PostgreSQL estimate" : undefined}
                    >
                      {approximatePrefix}
                      {formatCount(queue.failed)}
                    </Table.Td>
                    <Table.Td className="data-table__metric data-table__actions">
                      <QueueRowMenu
                        queue={queue}
                        capabilities={tierCapabilities}
                        pending={changingQueue === queue.queue || purgingQueue === queue.queue}
                        onClear={(trigger) => {
                          menuTrigger.current = trigger;
                          setConfirmingQueue(queue.queue);
                        }}
                        onAction={(action) => {
                          if (action === "tier") {
                            setQueueTier(queue.queue, queue.tier === "fast" ? "full" : "fast");
                          } else if (action === "recordAttempts") {
                            setQueueHistory(queue.queue, {
                              recordAttempts: queue.recordAttempts !== true,
                            });
                          } else {
                            setQueueHistory(queue.queue, {
                              recordClaims: queue.recordClaims !== true,
                            });
                          }
                        }}
                      />
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </TablePanel>
      )}
      {data.concurrencyPoliciesCapped || data.rateLimitPoliciesCapped ? (
        <div>
          {data.concurrencyPoliciesCapped ? (
            <p className="page-footnote">{concurrencyCappedFootnote}</p>
          ) : null}
          {data.rateLimitPoliciesCapped ? (
            <p className="page-footnote">{rateLimitCappedFootnote}</p>
          ) : null}
        </div>
      ) : null}
      {data.budgets.length === 0 ? null : <BudgetsTable budgets={data.budgets} />}
      {data.budgetsCapped ? <p className="page-footnote">{budgetCappedFootnote}</p> : null}
    </Page>
  );
}

/**
 * The queue that a fragment such as `#queue-billing` names, or null.
 *
 * A malformed fragment such as `#%` names no queue, so the page shows without a linked row.
 */
export function queueFromFragment(hash: string): string | null {
  let fragment: string;
  try {
    fragment = decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
  return fragment.startsWith("queue-") ? fragment.slice("queue-".length) : null;
}

/**
 * The queue that a link such as `/queues#queue-billing` names, from a schedule for example.
 *
 * The rows render after the browser looks for the fragment, so the page scrolls to the row
 * itself once the row exists.
 */
function useLinkedQueue(): string | null {
  const [queue] = useState(() =>
    typeof window === "undefined" ? null : queueFromFragment(window.location.hash),
  );
  useEffect(() => {
    if (queue === null) return;
    document.getElementById(`queue-${queue}`)?.scrollIntoView({ block: "center" });
  }, [queue]);
  return queue;
}

/**
 * The menu of one queue row: clear, tier, and history.
 *
 * Pause and resume stay in the row because operators use them most. Clear opens a confirmation.
 * Each tier or history action goes to `Admin.setQueueTier` or `Admin.setQueueHistory` through the
 * host, so the guards are the ones the CLI meets. A disabled action states its reason under its
 * label.
 */
function QueueRowMenu({
  queue,
  capabilities,
  pending,
  onClear,
  onAction,
}: {
  queue: DashboardQueuesPage["queues"][number];
  capabilities: QueueTierCapabilities;
  pending: boolean;
  onClear: (trigger: HTMLElement | null) => void;
  onAction: (action: QueueTierActionId) => void;
}) {
  const [tierAction, ...historyActions] = queueTierActions(queue, capabilities);
  const trigger = useRef<HTMLButtonElement>(null);
  const item = (action: NonNullable<typeof tierAction>) => (
    <Menu.Item
      key={action.id}
      disabled={action.unavailable !== null || pending}
      onClick={() => onAction(action.id)}
    >
      <Text size="sm" lh={1.3}>
        {action.label}
      </Text>
      {action.unavailable === null ? null : (
        <Text size="xs" c="dimmed" lh={1.3} mt={2} style={{ whiteSpace: "normal" }}>
          {action.unavailable}
        </Text>
      )}
    </Menu.Item>
  );
  return (
    <Menu
      blocksRefresh
      position="bottom-end"
      withinPortal
      shadow="md"
      width={280}
      transitionProps={{ duration: 0 }}
    >
      <Menu.Target>
        <ActionIcon
          ref={trigger}
          size="md"
          variant="subtle"
          color="gray"
          aria-label={`Actions for ${queue.queue}: clear, tier, and history`}
        >
          {pending ? (
            <Loader size={14} />
          ) : (
            <HugeiconsIcon icon={MoreVerticalIcon} size={16} strokeWidth={2} />
          )}
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item color="red" disabled={pending} onClick={() => onClear(trigger.current)}>
          <Text size="sm" lh={1.3} c="inherit">
            Clear queued tasks…
          </Text>
          <Text size="xs" c="dimmed" lh={1.3} mt={2} style={{ whiteSpace: "normal" }}>
            Deletes scheduled and ready tasks. Active tasks continue.
          </Text>
        </Menu.Item>
        <Menu.Divider />
        <Menu.Label>Tier</Menu.Label>
        {tierAction === undefined ? null : item(tierAction)}
        <Menu.Divider />
        <Menu.Label>Fast-tier history</Menu.Label>
        {historyActions.map(item)}
      </Menu.Dropdown>
    </Menu>
  );
}
