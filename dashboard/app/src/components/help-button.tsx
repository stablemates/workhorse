import { ActionIcon, Tooltip } from "@mantine/core";
import { Info } from "@phosphor-icons/react";

/**
 * Inline explanation next to a heading or metric.
 *
 * It lives apart from the system charts because pages that never show a chart use it, and an
 * import from a page module would pull that page into the main bundle.
 */
export function HelpButton({ label, help }: { label: string; help: string }) {
  return (
    <Tooltip label={help} multiline w={280} withArrow>
      <ActionIcon
        className="task-drawer__help"
        aria-label={`${label}: ${help}`}
        color="gray"
        size="sm"
        variant="subtle"
      >
        <Info size={14} />
      </ActionIcon>
    </Tooltip>
  );
}
