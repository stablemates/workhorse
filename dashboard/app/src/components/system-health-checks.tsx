import type { QueueHealthReason } from "@stablemates/workhorse";
import { Anchor, Badge, Box, Group, Paper, Stack, Text } from "@mantine/core";
import { systemHealthChecks } from "../presentation-policy.js";

const checkStatuses = {
  critical: { label: "Critical", color: "red" },
  degraded: { label: "Degraded", color: "yellow" },
  passing: { label: "Passing", color: "teal" },
  throttling: { label: "Throttling", color: "gray" },
  limiting: { label: "Limiting", color: "gray" },
};

export function SystemHealthChecks({ reasons }: { reasons: readonly QueueHealthReason[] }) {
  return (
    <Paper withBorder component="section" aria-label="Health checks">
      <Box p="md">
        <Group gap="xs">
          <Text fw={650}>Health checks</Text>
          <Badge variant="light" color="gray" size="sm" tt="none">
            Now
          </Badge>
        </Group>
        <Text c="dimmed" size="xs">
          Current state at the latest refresh. Limits show when they are holding ready tasks back.
        </Text>
      </Box>
      <Box component="ul" className="system-health-checks">
        {systemHealthChecks(reasons).map((check) => (
          <Box component="li" className="system-health-check" key={check.code}>
            <Text className="system-health-check__name" size="sm" fw={600}>
              {check.label}
            </Text>
            <Badge
              className="system-health-check__status"
              color={checkStatuses[check.status].color}
              variant="light"
              tt="none"
            >
              {checkStatuses[check.status].label}
            </Badge>
            <Stack className="system-health-check__details" gap="xs">
              {check.messages.length === 0 ? (
                <Text c="dimmed" size="sm">
                  {check.summary}
                </Text>
              ) : (
                check.messages.map((message) => (
                  <Box key={message.message}>
                    <Text size="sm">
                      {message.subject ? (
                        <>
                          {message.subject.label} <strong>{message.subject.name}</strong>{" "}
                          {message.subject.detail}
                        </>
                      ) : (
                        message.message
                      )}
                    </Text>
                    <Text c="dimmed" size="xs">
                      {message.advice}{" "}
                      <Anchor
                        href={message.helpHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        size="xs"
                      >
                        Learn more
                      </Anchor>
                    </Text>
                  </Box>
                ))
              )}
            </Stack>
          </Box>
        ))}
      </Box>
    </Paper>
  );
}
