import { Button, Stack, Text } from "@mantine/core";
import { Notifications, notifications } from "@mantine/notifications";
import { CheckCircle, Info, WarningCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import {
  cancelOutcomeTone,
  describeCancelOutcome,
  runNowOutcomeTone,
  type DashboardResultTone,
} from "./presentation.js";
import type { DashboardCancelStatus } from "@stablemates/workhorse-dashboard-server/wire";
import type { RunNowFeedback } from "./run-now.js";

/**
 * Where every operator result in this dashboard is reported.
 *
 * One notification system, mounted once beside the theme, replaces the per-page result banners
 * this dashboard used to render next to whatever control produced them. An operator who pauses a
 * queue, releases a task, or cancels one gets the answer in the same place every time, and the
 * answer no longer moves the page under the pointer that asked for it or vanish when the drawer
 * that showed it closes.
 *
 * The corner is deliberate: results appear away from the tables and menus an operator is working
 * in, so nothing they are reading or clicking is displaced by an outcome arriving.
 */
export const dashboardNotificationPosition = "bottom-right";

export interface DashboardNotification {
  /**
   * Stable identity for repeated results of the same kind, so a second click replaces the first
   * answer instead of stacking a second copy of it beside it.
   */
  id?: string;
  title: string;
  message: ReactNode;
  tone?: DashboardResultTone;
  /** Exact wording behind a summary, offered as a title attribute rather than a second toast. */
  exact?: string;
  /** One follow-up the result makes obvious, such as opening the task that was just released. */
  action?: { label: string; onClick: () => void };
  /** Milliseconds, or false to require dismissal. Defaults by tone. */
  autoClose?: number | false;
}

const toneColor: Record<DashboardResultTone, string> = {
  neutral: "gray",
  success: "teal",
  failure: "red",
};

// A failure is given longer than a result an operator merely acknowledges, because it is the one
// outcome they may need to read twice, copy, or act on.
const toneAutoClose: Record<DashboardResultTone, number> = {
  neutral: 5_000,
  success: 6_000,
  failure: 10_000,
};

function toneIcon(tone: DashboardResultTone): ReactNode {
  if (tone === "success") return <CheckCircle size={18} weight="fill" />;
  if (tone === "failure") return <WarningCircle size={18} weight="fill" />;
  return <Info size={18} />;
}

/**
 * Report one operator result.
 *
 * The message is always written out. Colour and the icon repeat the tone rather than carrying it,
 * so a result is never icon-only, and each notification announces itself: a failure interrupts as
 * an alert, everything else is queued politely behind whatever the screen reader is saying.
 */
export function notifyDashboard(notification: DashboardNotification): string {
  const tone = notification.tone ?? "neutral";
  const action = notification.action;
  const id = notification.id ?? `workhorse-${crypto.randomUUID()}`;
  // `show` ignores an id that is already on screen, so a repeated action would report nothing at
  // all the second time. Removing the previous answer first is what makes the new one replace it.
  if (notification.id !== undefined) notifications.hide(notification.id);
  return notifications.show({
    id,
    color: toneColor[tone],
    icon: toneIcon(tone),
    title: notification.title,
    withBorder: true,
    autoClose: notification.autoClose ?? toneAutoClose[tone],
    role: tone === "failure" ? "alert" : "status",
    // The action sits under the sentence rather than beside it. Sharing one row makes the button
    // compete with the message for a fixed toast width, and the loser is whichever the browser
    // decides to shrink: a button reading "Open" instead of "Open task" is the same bug as a
    // truncated sentence. Stacked, each gets the full width and neither can clip the other.
    message: (
      <Stack gap={6} align="flex-start">
        <Text size="sm" title={notification.exact}>
          {notification.message}
        </Text>
        {action ? (
          <Button
            size="compact-xs"
            variant="light"
            // Mantine's own padding, unmodified. Aligning the label with the sentence above by
            // pulling the control left by its padding reads as a button padded on one side only,
            // which is worse than the small indent it was trying to remove.
            onClick={() => {
              notifications.hide(id);
              action.onClick();
            }}
          >
            {action.label}
          </Button>
        ) : null}
      </Stack>
    ),
  });
}

/**
 * Report a request that never reached a decision.
 *
 * Kept separate from a stated refusal: this is the shape used when the transport failed or the
 * host rejected the call, so the operator is told the durable state is unknown to the dashboard
 * rather than that something was deliberately left alone.
 */
export function notifyFailure(title: string, cause: unknown, fallback: string): string {
  return notifyDashboard({
    title,
    message: cause instanceof Error ? cause.message : fallback,
    tone: "failure",
  });
}

/**
 * Report what one run-now request did.
 *
 * The released task is what the operator now wants to watch, so it is offered directly rather than
 * left to be found again in the list. A failed request is offered no link, because the commonest
 * failure is the task no longer existing and a link would only lead to a second error.
 */
export function notifyRunNow(
  feedback: RunNowFeedback,
  options: { openTask: (id: string) => void },
): string {
  if (feedback.failure !== null) {
    return notifyDashboard({
      title: "Task not run now",
      message: feedback.failure,
      tone: "failure",
    });
  }
  const described = feedback.described!;
  return notifyDashboard({
    title: described.label,
    message: `${described.summary}.`,
    exact: described.exact,
    tone: runNowOutcomeTone(feedback.status!),
    action: { label: "Open task", onClick: () => options.openTask(feedback.jobId) },
  });
}

/**
 * Report what one cancellation did.
 *
 * Raised for every cancellation, including one whose task the operator has already navigated away
 * from: the request was still applied, and a result that only appeared in a drawer that has since
 * closed is a result the operator never got.
 */
export function notifyCancel(
  outcome: { jobId: string; status: DashboardCancelStatus; state: string | null },
  options: { openTask: (id: string) => void },
): string {
  const described = describeCancelOutcome(outcome.status, { state: outcome.state });
  return notifyDashboard({
    title: described.label,
    message: `${described.summary}.`,
    exact: described.exact,
    tone: cancelOutcomeTone(outcome.status),
    action: { label: "Open task", onClick: () => options.openTask(outcome.jobId) },
  });
}

/** Drop every notification on screen, for a context change that makes their results irrelevant. */
export function clearDashboardNotifications(): void {
  notifications.clean();
}

/**
 * The notification container, mounted once for the whole dashboard.
 *
 * It is rendered by `WorkhorseThemeProvider` rather than by a page, so a result raised while the
 * operator is navigating still has somewhere to arrive, and a host embedding this dashboard gets
 * the system without wiring anything.
 */
export function DashboardNotifications() {
  return <Notifications position={dashboardNotificationPosition} containerWidth={420} limit={4} />;
}
