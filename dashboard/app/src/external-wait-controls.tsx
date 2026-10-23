import { Button, Stack, Text, Textarea } from "@mantine/core";
import { dangerTextColor } from "./status-colors.js";

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

export function ExternalWaitDeadline({
  deadline,
  overdue,
}: {
  deadline: string;
  overdue: boolean;
}) {
  return (
    // Static text: the visible words state the deadline and the overdue state.
    <Text c={overdue ? dangerTextColor : "dimmed"} size="xs">
      {overdue ? "Overdue · " : null}Deadline {deadline}
    </Text>
  );
}
