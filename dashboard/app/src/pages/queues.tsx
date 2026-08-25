import type { DashboardQueuesPage } from "@stablemates/workhorse-dashboard-server/wire";
import { Button, Code, Group, Paper, ScrollArea, Stack, Switch, Table, Text } from "@mantine/core";
import {
  concurrencyCappedFootnote,
  describeConcurrencyBlocked,
  describeConcurrencyKeys,
  describeConcurrencyLimit,
} from "../concurrency-policy.js";
import { describeRateLimit, describeRateThrottle, rateLimitCappedFootnote } from "../rate-limit.js";
import { EmptyState, PageHeader } from "../components/task-list.js";
import { HelpButton } from "../charts/system.js";

export function QueuesPage({
  data,
  togglingQueue,
  purgingQueue,
  confirmingQueue,
  setQueuePaused,
  setConfirmingQueue,
  purgeQueue,
}: {
  data: DashboardQueuesPage;
  togglingQueue: string | null;
  purgingQueue: string | null;
  confirmingQueue: string | null;
  setQueuePaused: (queue: string, paused: boolean) => void;
  setConfirmingQueue: (queue: string | null) => void;
  purgeQueue: (queue: string) => void;
}) {
  return (
    <Stack gap="xl">
      <PageHeader
        title="Queues"
        description="Pause new claims, compare concurrency and start-rate budgets, or clear tasks that have not started."
      />
      {data.queues.length === 0 ? (
        <EmptyState>No queue has accepted a task yet.</EmptyState>
      ) : (
        <Paper withBorder>
          <ScrollArea>
            <Table highlightOnHover verticalSpacing={6} horizontalSpacing="md" miw={1380}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Queue</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th ta="right">Scheduled</Table.Th>
                  <Table.Th ta="right">Ready</Table.Th>
                  <Table.Th ta="right">Active</Table.Th>
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
                      <span>Throttled</span>
                      <HelpButton
                        label="Throttled"
                        help="Ready tasks waiting for a queue or per-key token. This is a bounded lower bound, and the detail shows the earliest database-calculated eligibility time."
                      />
                    </Group>
                  </Table.Th>
                  <Table.Th ta="right">Succeeded</Table.Th>
                  <Table.Th ta="right">Failed</Table.Th>
                  <Table.Th ta="right">Actions</Table.Th>
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
                  return (
                    <Table.Tr key={queue.queue}>
                      <Table.Td>
                        <Code
                          fz="xs"
                          style={{
                            background: "transparent",
                            paddingBlock: 0,
                            paddingInline: 0,
                          }}
                        >
                          {queue.queue}
                        </Code>
                      </Table.Td>
                      <Table.Td>
                        <Switch
                          size="sm"
                          checked={!queue.paused}
                          disabled={togglingQueue === queue.queue}
                          label={queue.paused ? "Paused" : "Running"}
                          styles={{
                            label: { fontSize: "var(--mantine-font-size-xs)" },
                          }}
                          aria-label={`${queue.paused ? "Resume" : "Pause"} ${queue.queue}`}
                          onChange={(event) =>
                            setQueuePaused(queue.queue, !event.currentTarget.checked)
                          }
                        />
                      </Table.Td>
                      <Table.Td ta="right">{queue.scheduled}</Table.Td>
                      <Table.Td ta="right">{queue.ready}</Table.Td>
                      <Table.Td ta="right">{queue.active}</Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" title={limit.title} aria-label={`Limit: ${limit.title}`}>
                          {limit.label}
                        </Text>
                        {keys.label === null ? null : (
                          <Text
                            c={keys.saturated ? "yellow.8" : "dimmed"}
                            size="xs"
                            title={keys.title}
                            aria-label={`Per key: ${keys.title}`}
                          >
                            {keys.label}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text
                          size="sm"
                          c={blocked.blocking ? "yellow.8" : undefined}
                          fw={blocked.blocking ? 650 : undefined}
                          title={blocked.title}
                          aria-label={`Blocked: ${blocked.title}`}
                        >
                          {blocked.label}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" title={rate.title} aria-label={`Start rate: ${rate.title}`}>
                          {rate.label}
                        </Text>
                        {rate.keyedLabel === null ? null : (
                          <Text c="dimmed" size="xs">
                            {rate.keyedLabel}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text
                          size="sm"
                          c={throttled.throttling ? "yellow.8" : undefined}
                          fw={throttled.throttling ? 650 : undefined}
                          title={throttled.title}
                          aria-label={`Throttled: ${throttled.title}`}
                        >
                          {throttled.label}
                        </Text>
                      </Table.Td>
                      <Table.Td
                        ta="right"
                        title={queue.terminalCountsApproximate ? "PostgreSQL estimate" : undefined}
                      >
                        {approximatePrefix}
                        {queue.succeeded}
                      </Table.Td>
                      <Table.Td
                        ta="right"
                        title={queue.terminalCountsApproximate ? "PostgreSQL estimate" : undefined}
                      >
                        {approximatePrefix}
                        {queue.failed}
                      </Table.Td>
                      <Table.Td ta="right">
                        {confirmingQueue === queue.queue ? (
                          <Group gap={4} justify="flex-end" wrap="nowrap">
                            <Button
                              color="red"
                              size="compact-xs"
                              loading={purgingQueue === queue.queue}
                              onClick={() => purgeQueue(queue.queue)}
                            >
                              Confirm clear
                            </Button>
                            <Button
                              variant="subtle"
                              color="gray"
                              size="compact-xs"
                              disabled={purgingQueue === queue.queue}
                              onClick={() => setConfirmingQueue(null)}
                            >
                              Cancel
                            </Button>
                          </Group>
                        ) : (
                          <Button
                            variant="light"
                            color="red"
                            size="compact-xs"
                            onClick={() => setConfirmingQueue(queue.queue)}
                          >
                            Clear
                          </Button>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Paper>
      )}
      <Text c="dimmed" size="xs">
        Clear removes tasks that are scheduled or ready. It does not interrupt active tasks.
      </Text>
      {data.concurrencyPoliciesCapped ? (
        <Text c="dimmed" size="xs">
          {concurrencyCappedFootnote}
        </Text>
      ) : null}
      {data.rateLimitPoliciesCapped ? (
        <Text c="dimmed" size="xs">
          {rateLimitCappedFootnote}
        </Text>
      ) : null}
    </Stack>
  );
}
