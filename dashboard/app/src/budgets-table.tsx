import type { DashboardBudgetSummary } from "@stablemates/workhorse-dashboard-server/wire";
import { Box, Code, Group, Paper, ScrollArea, Table, Text } from "@mantine/core";
import {
  budgetCappedFootnote,
  describeBudgetBlocked,
  describeBudgetLimit,
  describeBudgetRate,
} from "./budget.js";
import { HelpButton } from "./charts/system.js";

export { budgetCappedFootnote };

/** Named budgets span queues, so both the Queues page and the health page show one table. */
export function BudgetsTable({ budgets }: { budgets: readonly DashboardBudgetSummary[] }) {
  return (
    <Paper withBorder>
      <Box p="md">
        <Group gap={4} wrap="nowrap">
          <Text fw={650}>Budgets</Text>
          <HelpButton
            label="Budgets"
            help="A budget caps active tasks, start rate, or both across every queue whose tasks name it. It adds to each queue's own limits rather than replacing them."
          />
        </Group>
        <Text c="dimmed" size="xs">
          Shared across queues · a task names at most one budget when it is enqueued
        </Text>
      </Box>
      <ScrollArea
        type="auto"
        offsetScrollbars="x"
        viewportProps={{ tabIndex: 0, role: "region", "aria-label": "Budgets table" }}
      >
        <Table
          highlightOnHover
          verticalSpacing={6}
          horizontalSpacing="md"
          className="dashboard-table dashboard-table--budgets"
          miw={760}
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Budget</Table.Th>
              <Table.Th>Namespace</Table.Th>
              <Table.Th ta="right">Active</Table.Th>
              <Table.Th ta="right">Start rate</Table.Th>
              <Table.Th ta="right">
                <Group gap={4} justify="flex-end" wrap="nowrap">
                  <span>Blocked</span>
                  <HelpButton
                    label="Blocked"
                    help="Ready tasks in any queue that cannot start because this budget is at its cap or out of tokens. Workhorse samples a bounded window, so this is a lower bound."
                  />
                </Group>
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {budgets.map((budget) => {
              const limit = describeBudgetLimit(budget);
              const rate = describeBudgetRate(budget);
              const blocked = describeBudgetBlocked(budget);
              return (
                <Table.Tr key={budget.name}>
                  <Table.Td>
                    <Code fz="xs" style={{ background: "transparent", padding: 0 }}>
                      {budget.name}
                    </Code>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {budget.namespace}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Text size="sm" title={limit.title} aria-label={`Active: ${limit.title}`}>
                      {limit.label}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Text size="sm" title={rate.title} aria-label={`Start rate: ${rate.title}`}>
                      {rate.label}
                    </Text>
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
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </ScrollArea>
    </Paper>
  );
}
