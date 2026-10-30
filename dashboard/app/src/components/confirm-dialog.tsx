import type { ReactNode, RefObject } from "react";
import { useConfirmationActivity } from "../dropdown-activity.js";
import { AlertDialog, Button } from "../ui.js";

/**
 * A confirmation before an operator action that changes state, such as clearing a queue.
 *
 * It is a Graphical alert dialog: focus moves into it, Escape and Cancel close it, and focus goes
 * back to the control that opened it. While it is open the dashboard does not refresh. While the
 * action runs, the dialog stays open and cannot close.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "primary",
  pending = false,
  confirmDisabled = false,
  initialFocus,
  finalFocus,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  pending?: boolean;
  confirmDisabled?: boolean;
  /** The element that takes focus when the dialog opens. The cancel button takes it by default. */
  initialFocus?: RefObject<HTMLElement | null>;
  /**
   * The element that takes focus when the dialog closes. Pass it when a menu item opens the
   * dialog, because the menu item is gone by then.
   */
  finalFocus?: RefObject<HTMLElement | null>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useConfirmationActivity(open);
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop />
        <AlertDialog.Popup
          className="confirm-dialog"
          initialFocus={initialFocus}
          finalFocus={finalFocus}
        >
          <AlertDialog.Title>{title}</AlertDialog.Title>
          <div className="confirm-dialog__body">{children}</div>
          <div className="confirm-dialog__actions">
            <AlertDialog.Close render={<Button variant="secondary" />} disabled={pending}>
              {cancelLabel}
            </AlertDialog.Close>
            <Button
              variant={tone === "danger" ? "danger" : "primary"}
              disabled={pending || confirmDisabled}
              aria-busy={pending || undefined}
              onClick={onConfirm}
            >
              {pending ? `${confirmLabel}…` : confirmLabel}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
