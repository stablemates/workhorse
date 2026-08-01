export { Dashboard, type DashboardProps } from "./dashboard.js";
export { WorkhorseThemeProvider, type DashboardColorScheme, useWorkhorseTheme } from "./theme.js";
export type {
  DashboardAuditInput,
  DashboardClient,
  DashboardDemoJobKind,
  DashboardDemoScenario,
  DashboardDemoTools,
} from "./client.js";
export {
  parseTaskLocation,
  taskLocationHref,
  taskPageSizes,
  type TaskActivityGroup,
  type TaskActivityPeriod,
  type TaskLocationState,
  type TaskPageSize,
} from "./task-location.js";
