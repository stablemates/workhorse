import type {
  DashboardClient,
  DashboardDemoTools,
  DashboardWorkspaceLink,
} from "@workhorse-js/dashboard-server";
import { RefreshBlockerProvider } from "./refresh-blockers.js";
import { DropdownActivityProvider } from "./dropdown-activity.js";
import { DashboardClientContext, normalizeBasePath } from "./core.js";
import { DashboardContent } from "./shell/AppShell.js";
export { HumanDecisionControls } from "./external-wait-controls.js";
export { BatchExecutionLine, CoalescingSection } from "./components/task-detail-relations.js";
export {
  BoundaryTimeline,
  ChildLine,
  ConcurrencyPolicyLine,
  DependencyLine,
  RedriveLine,
} from "./components/task-detail-durability.js";
export {
  TaskListingFilters,
  TaskName,
  TaskTags,
  TaskTagsTooltipContent,
  TaskWaitBadge,
} from "./components/task-list.js";
export { SignalWaitCard } from "./components/signal-task.js";
export { ExternalWaitAlert, QueuePressure, SystemKpiList } from "./charts/system.js";
export { EventDetails, eventTypeColor } from "./pages/events.js";
export { QueuesPage } from "./pages/queues.js";
export { SettingsPage, type SettingsPageProps } from "./pages/settings/index.js";
export { WorkersPage } from "./pages/workers.js";
export { DashboardWorkspaceSwitcher } from "./shell/AppShell.js";

export interface DashboardProps {
  client: DashboardClient;
  /** Actor stored in audit metadata for mutations initiated by this dashboard. */
  auditActor?: string;
  /** Optional demo job seeding controls. Omit this in normal application dashboards. */
  demoTools?: DashboardDemoTools;
  /** URL namespace where the dashboard is mounted, for example `/workhorse`. */
  basePath?: string;
  /** Built-in authentication logout URL. Omit when the embedding host owns authorization. */
  logoutUrl?: string;
  /** Every workspace the host serves. Omit in single-workspace mode. */
  workspaces?: readonly DashboardWorkspaceLink[];
  /** Workspace this document was rendered for. Omit in single-workspace mode. */
  workspace?: string | null;
}
export function Dashboard({
  client,
  auditActor = "dashboard",
  demoTools = undefined,
  basePath: basePathInput = "",
  logoutUrl = undefined,
  workspaces = [],
  workspace = null,
}: DashboardProps) {
  const basePath = normalizeBasePath(basePathInput);
  return (
    <DashboardClientContext.Provider value={client}>
      <RefreshBlockerProvider>
        <DropdownActivityProvider>
          <DashboardContent
            auditActor={auditActor}
            logoutUrl={logoutUrl ?? null}
            demoTools={demoTools ?? null}
            basePath={basePath}
            workspaces={workspaces}
            workspace={workspace}
          />
        </DropdownActivityProvider>
      </RefreshBlockerProvider>
    </DashboardClientContext.Provider>
  );
}
