import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Dashboard } from "./dashboard.js";
import {
  createDashboardClient,
  type DashboardAuthenticationRoutes,
} from "@stablemates/workhorse-dashboard-server/client";
import type { DashboardWorkspaceLink } from "@stablemates/workhorse-dashboard-server/server";
// oxlint-disable-next-line import/no-unassigned-import -- Browser entrypoint owns the complete package stylesheet.
import "./styles.css";
import { WorkhorseThemeProvider } from "./theme.js";

const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
if (favicon) favicon.href = new URL("./assets/workhorse-favicon.svg", import.meta.url).href;

export interface WorkhorseDashboardRuntimeConfig {
  basePath: string;
  rpcUrl: string;
  auditActor: string;
  authentication: DashboardAuthenticationRoutes | null;
  demoTools?: boolean;
  workspaces?: readonly DashboardWorkspaceLink[];
  workspace?: string | null;
}

declare global {
  interface Window {
    workhorseDashboard?: WorkhorseDashboardRuntimeConfig;
  }
}

const config = window.workhorseDashboard;
if (!config) throw new Error("Missing Workhorse dashboard runtime configuration");
const client = createDashboardClient(config.rpcUrl, {
  unauthorizedRedirectUrl: config.authentication?.loginUrl,
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkhorseThemeProvider>
      <Dashboard
        client={client}
        basePath={config.basePath}
        auditActor={config.auditActor}
        logoutUrl={config.authentication?.logoutUrl}
        demoTools={
          config.demoTools && client.enqueueTest ? { enqueueTest: client.enqueueTest } : undefined
        }
        workspaces={config.workspaces}
        workspace={config.workspace}
      />
    </WorkhorseThemeProvider>
  </StrictMode>,
);
