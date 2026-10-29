import { useState, type ComponentProps } from "react";
import { Switch } from "../ui.js";

/**
 * Which position a switch shows.
 *
 * While a change waits for the server, the switch shows the position the operator asked for. When
 * the change ends, the switch shows the server value again: the new value after a success, or the
 * old value after a failure, so a failed change moves back without a separate rollback.
 */
export function shownSwitchPosition({
  checked,
  pending,
  requested,
}: {
  checked: boolean;
  pending: boolean;
  requested: boolean | null;
}): boolean {
  return pending && requested !== null ? requested : checked;
}

/**
 * A switch for a server change, such as pausing a queue.
 *
 * `checked` is the server value. `pending` is true while the change runs. The switch then ignores
 * new input, keeps its full color, and marks itself busy. `disabled` is only for a change that the
 * operator cannot make, such as a worker control in read-only mode.
 */
export function OptimisticSwitch({
  checked,
  pending,
  onCheckedChange,
  ...props
}: Omit<ComponentProps<typeof Switch.Root>, "checked" | "onCheckedChange" | "readOnly"> & {
  checked: boolean;
  pending: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const [requested, setRequested] = useState<boolean | null>(null);
  return (
    <Switch.Root
      {...props}
      checked={shownSwitchPosition({ checked, pending, requested })}
      readOnly={pending}
      aria-busy={pending}
      onCheckedChange={(next) => {
        if (pending) return;
        setRequested(next);
        onCheckedChange(next);
      }}
    />
  );
}
