/**
 * The dashboard root and nothing else.
 *
 * `dashboard.tsx` re-exports this beside every page for library consumers. The browser entry
 * imports this module instead so the page re-exports stay out of its static graph and each page
 * keeps its own chunk.
 */
import type { DashboardClient, DashboardDemoTools } from "@stablemates/workhorse-dashboard-server";
import type { DashboardWorkspaceLink } from "@stablemates/workhorse-dashboard-server/server";
import { RefreshBlockerProvider } from "./refresh-blockers.js";
import { DropdownActivityProvider } from "./dropdown-activity.js";
import { DashboardClientContext, normalizeBasePath } from "./core.js";
import { DashboardContent } from "./shell/AppShell.js";

export interface DashboardProps {
  client: DashboardClient;
  /** Actor stored in audit metadata for mutations initiated by this dashboard. */
  auditActor?: string;
  /** Optional demo task seeding controls. Omit this in normal application dashboards. */
  demoTools?: DashboardDemoTools;
  /** URL namespace where the dashboard is mounted, for example `/workhorse`. */
  basePath?: string;
  /** Built-in authentication logout URL. Omit when the embedding host owns authorization. */
  logoutUrl?: string;
  /** Every workspace the host serves. Omit in single-workspace mode. */
  workspaces?: readonly DashboardWorkspaceLink[];
  /** Workspace this document was rendered for. Omit in single-workspace mode. */
  workspace?: string | null;
  /** SDK version displayed by the dashboard. Omit to hide it for direct React embeds. */
  workhorseVersion?: string;
}
export function Dashboard({
  client,
  auditActor = "dashboard",
  demoTools = undefined,
  basePath: basePathInput = "",
  logoutUrl = undefined,
  workspaces = [],
  workspace = null,
  workhorseVersion = undefined,
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
            workhorseVersion={workhorseVersion}
          />
        </DropdownActivityProvider>
      </RefreshBlockerProvider>
    </DashboardClientContext.Provider>
  );
}
