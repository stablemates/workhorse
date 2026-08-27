/** Mounted routes exposed only when the dashboard owns single-admin authentication. */
export interface DashboardAuthenticationRoutes {
  loginUrl: string;
  logoutUrl: string;
}

/** One switchable workspace as the browser sees it. */
export interface DashboardWorkspaceLink {
  name: string;
  /** Mount path of the workspace, e.g. `/workhorse/production`. */
  url: string;
  /** Display-only label of the backing database host, shown in the workspace switcher. */
  databaseHost?: string;
  /** Display-only name of the backing database, shown in the workspace switcher. */
  databaseName?: string;
}
