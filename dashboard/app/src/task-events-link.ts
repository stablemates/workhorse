/** Browser-link attributes for opening one task's Events feed beside the task listing. */
export function taskEventsLinkProps(taskId: string, href: string) {
  return {
    href,
    target: "_blank" as const,
    rel: "noopener noreferrer",
    "aria-label": `View all events for task ${taskId} in a new window`,
  };
}
