import { ActionIcon, Code, Group, Tooltip } from "@mantine/core";
import { Copy } from "@phosphor-icons/react";
import { notifyDashboard } from "../notifications.js";
import { copyToClipboard } from "../preferences.js";

/** A compact row identity with a reserved copy target, so hover never shifts the table. */
export function TaskTableId({ id }: { id: string }) {
  return (
    <Group className="task-table-id" gap={4} wrap="nowrap" title={id}>
      <Code fz="xs" style={{ background: "transparent", padding: 0 }}>
        {id.slice(0, 8)}
      </Code>
      <Tooltip label="Copy task ID" withArrow>
        <ActionIcon
          className="task-table-id__copy"
          size="xs"
          variant="subtle"
          color="gray"
          aria-label={`Copy task ID ${id}`}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            void copyToClipboard(id).then((failure) =>
              notifyDashboard({
                id: "workhorse-task-clipboard",
                title: failure ? "Task ID not copied" : "Task ID copied",
                message: failure ?? "Task ID copied to the clipboard.",
                tone: failure ? "failure" : "neutral",
              }),
            );
          }}
        >
          <Copy size={14} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
