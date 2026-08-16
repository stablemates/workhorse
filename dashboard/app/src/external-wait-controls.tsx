import { Accordion, Alert, Button, Code, Group, Stack, Text, Textarea } from "@mantine/core";

export function SignalPayloadEditor({
  ariaLabel,
  payload,
  disabled,
  sending,
  onPayloadChange,
  onSend,
}: {
  ariaLabel: string;
  payload: string;
  disabled: boolean;
  sending: boolean;
  onPayloadChange: (value: string) => void;
  onSend: () => void;
}) {
  return (
    <Stack gap="xs" role="group" aria-label={ariaLabel}>
      <Textarea
        label="Signal payload (JSON)"
        description="The waiting handler receives this JSON value after it restarts."
        placeholder='{"approved":true}'
        value={payload}
        disabled={disabled}
        autosize
        minRows={3}
        maxRows={12}
        onChange={(event) => onPayloadChange(event.currentTarget.value)}
      />
      <Button
        loading={sending}
        disabled={disabled || !payload.trim()}
        onClick={onSend}
        style={{ alignSelf: "flex-start" }}
      >
        Send signal
      </Button>
    </Stack>
  );
}

export function HumanDecisionControls({
  ariaLabel,
  result,
  quickAction,
  canComplete,
  confirming,
  completing,
  onQuickAction,
  onResultChange,
  onReview,
  onComplete,
  onKeepEditing,
}: {
  ariaLabel: string;
  result: string;
  quickAction: { label: string } | null;
  canComplete: boolean;
  confirming: boolean;
  completing: boolean;
  onQuickAction: () => void;
  onResultChange: (value: string) => void;
  onReview: () => void;
  onComplete: () => void;
  onKeepEditing: () => void;
}) {
  return (
    <Stack gap="sm" role="group" aria-label={ariaLabel}>
      {quickAction ? (
        <Group gap="xs" wrap="wrap">
          <Button disabled={!canComplete} onClick={onQuickAction}>
            {quickAction.label}
          </Button>
          <Text c="dimmed" size="xs">
            Resume this task with the application-defined decision.
          </Text>
        </Group>
      ) : null}
      {confirming ? (
        <Alert color="orange" title="Confirm this irreversible result">
          <Text size="sm" mb="sm">
            The first accepted result resumes the handler. Check the result before completing this
            wait because it cannot be replaced.
          </Text>
          <Code block mb="sm">
            {result}
          </Code>
          <Group gap="xs" wrap="wrap">
            <Button color="orange" loading={completing} onClick={onComplete}>
              Confirm decision
            </Button>
            <Button variant="default" disabled={completing} onClick={onKeepEditing}>
              Keep editing
            </Button>
          </Group>
        </Alert>
      ) : null}
      <Accordion variant="contained">
        <Accordion.Item value="custom-result">
          <Accordion.Control>Provide a custom JSON result</Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Textarea
                label="Result (JSON)"
                description="Use the result shape requested in the decision context. Workhorse validates JSON size, not domain fields."
                placeholder='{"approved":true}'
                value={result}
                disabled={!canComplete}
                autosize
                minRows={3}
                maxRows={12}
                onChange={(event) => onResultChange(event.currentTarget.value)}
              />
              <Button
                disabled={!canComplete || !result.trim()}
                onClick={onReview}
                style={{ alignSelf: "flex-start" }}
              >
                Review result
              </Button>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}

export function ExternalWaitDeadline({
  deadline,
  overdue,
}: {
  deadline: string;
  overdue: boolean;
}) {
  return (
    <Text
      c={overdue ? "red" : "dimmed"}
      size="xs"
      role="status"
      aria-label={`${overdue ? "Overdue. " : ""}Deadline ${deadline}`}
    >
      {overdue ? "Overdue · " : null}Deadline {deadline}
    </Text>
  );
}
