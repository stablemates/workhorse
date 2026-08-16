/** Mounted routes exposed only when the dashboard owns single-admin authentication. */
export interface DashboardAuthenticationRoutes {
  loginUrl: string;
  logoutUrl: string;
}
