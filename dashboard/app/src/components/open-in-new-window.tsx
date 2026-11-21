import { ActionIcon, Tooltip } from "@mantine/core";
import { ArrowSquareOut } from "@phosphor-icons/react";

/**
 * The icon link that opens a page in a new window.
 *
 * Every "open in a new window" control in the dashboard uses this one, so it has the same icon,
 * color, size, and tooltip everywhere.
 */
export function OpenInNewWindowButton({ href, label }: { href: string; label: string }) {
  return (
    <Tooltip label="Open in a new window" withArrow>
      <ActionIcon
        component="a"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        variant="subtle"
        color="gray"
        size="sm"
        aria-label={label}
      >
        <ArrowSquareOut size={16} aria-hidden />
      </ActionIcon>
    </Tooltip>
  );
}
