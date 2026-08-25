import type { DashboardClient } from "@workhorse-js/dashboard-server";
import { parseHumanWaitResult } from "../presentation.js";
import { notifyDashboard, notifyFailure } from "../notifications.js";
import type {
  DashboardJobDetail,
  DashboardSignalWaitRow,
} from "@workhorse-js/dashboard-server/wire";
import { Box, Button, Code, Group, Paper, Stack, Text } from "@mantine/core";
import { ExternalWaitDeadline, SignalPayloadEditor } from "../external-wait-controls.js";
import { useState } from "react";
import { formatExact } from "../preferences.js";
import { useDashboardClient } from "../core.js";
import { DrawerSection } from "./task-detail-overview.js";

async function deliverDashboardSignal({
  client,
  auditActor,
  jobId,
  name,
  payloadSource,
  reason,
}: {
  client: DashboardClient;
  auditActor: string;
  jobId: string;
  name: string;
  payloadSource: string;
  reason: string;
}): Promise<boolean> {
  const parsed = parseHumanWaitResult(payloadSource);
  if (parsed === null) {
    notifyDashboard({
      title: "Payload is not valid JSON",
      message: "Enter the JSON value the waiting handler should receive.",
      tone: "failure",
    });
    return false;
  }
  try {
    const delivery = await client.signalTask({
      id: jobId,
      name,
      payload: parsed.value,
      idempotencyKey: crypto.randomUUID(),
      audit: { actor: auditActor, reason, requestId: crypto.randomUUID() },
    });
    notifyDashboard({
      title: delivery.status === "delivered" ? "Signal delivered" : "Signal unchanged",
      message: `${name}: ${delivery.status}`,
      tone: delivery.status === "delivered" ? "success" : "neutral",
    });
    return true;
  } catch (cause) {
    notifyFailure("Signal not delivered", cause, "Workhorse rejected the signal payload");
    return false;
  }
}
export function SignalWaitCard({
  wait,
  payload,
  canSignal,
  sending,
  onPayloadChange,
  onSend,
  inspectJob,
}: {
  wait: DashboardSignalWaitRow;
  payload: string;
  canSignal: boolean;
  sending: boolean;
  onPayloadChange: (value: string) => void;
  onSend: () => void;
  inspectJob?: (id: string) => void;
}) {
  return (
    <Paper
      component="section"
      aria-label={`Signal ${wait.name} for task ${wait.jobId}`}
      withBorder
      p="lg"
    >
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <Box>
            <Text fw={700}>{wait.name}</Text>
            <Text size="sm">
              {wait.jobType} · {wait.queue} · attempt {wait.attempt}
            </Text>
            <Code fz="xs">{wait.jobId}</Code>
            {inspectJob ? (
              <Button
                variant="subtle"
                size="compact-xs"
                aria-label={`View task ${wait.jobId}`}
                onClick={() => inspectJob(wait.jobId)}
              >
                View task
              </Button>
            ) : null}
          </Box>
          <Text c="dimmed" size="xs">
            {formatExact(wait.createdAt)}
          </Text>
        </Group>
        <ExternalWaitDeadline
          deadline={formatExact(wait.deadlineAt)}
          overdue={new Date(wait.deadlineAt).getTime() <= Date.now()}
        />
        <SignalPayloadEditor
          ariaLabel={`Signal input for ${wait.name}`}
          payload={payload}
          disabled={!canSignal}
          sending={sending}
          onPayloadChange={onPayloadChange}
          onSend={onSend}
        />
      </Stack>
    </Paper>
  );
}
export function SignalTaskPanel({
  job,
  auditActor,
  reload,
}: {
  job: DashboardJobDetail;
  auditActor: string;
  reload: () => Promise<void>;
}) {
  const client = useDashboardClient();
  const [payload, setPayload] = useState("");
  const [sending, setSending] = useState(false);
  const wait = job.signalWait;
  if (!wait) return null;

  const send = async () => {
    setSending(true);
    try {
      const requestSucceeded = await deliverDashboardSignal({
        client,
        auditActor,
        jobId: job.identity.id,
        name: wait.name,
        payloadSource: payload,
        reason: `Send signal ${wait.name} from the task drawer`,
      });
      if (!requestSucceeded) return;
      setPayload("");
      await reload();
    } finally {
      setSending(false);
    }
  };

  return (
    <DrawerSection id="signal-delivery-heading" title="Signal delivery">
      <Text size="sm" mb={4}>
        Waiting for <Code fz="xs">{wait.name}</Code>
      </Text>
      <Box mb="sm">
        <ExternalWaitDeadline
          deadline={formatExact(wait.deadlineAt)}
          overdue={new Date(wait.deadlineAt).getTime() <= Date.now()}
        />
      </Box>
      <SignalPayloadEditor
        ariaLabel={`Signal input for ${wait.name}`}
        payload={payload}
        disabled={!job.canSignal}
        sending={sending}
        onPayloadChange={setPayload}
        onSend={() => void send()}
      />
    </DrawerSection>
  );
}
